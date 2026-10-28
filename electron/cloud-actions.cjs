const { createHash, randomUUID } = require('node:crypto');
const { CodexAttentionReader } = require('./codex-attention.cjs');
const { JsonProjectionFrameDecoder } = require('./json-projection-frame-decoder.cjs');

const METHODS = new Map([
  ['item/tool/requestUserInput', 'thread-follower-submit-user-input'],
  ['item/commandExecution/requestApproval', 'thread-follower-command-approval-decision'],
  ['item/fileChange/requestApproval', 'thread-follower-file-approval-decision'],
]);
const REQUEST_FIELDS = new Set(['id', 'method', 'completed', 'params', 'threadId', 'turnId', 'itemId', 'questions', 'header',
  'question', 'options', 'label', 'description', 'isOther', 'isSecret', 'reason', 'command', 'cwd', 'grantRoot', 'availableDecisions']);
const MAX_REQUESTS = 256, MAX_BYTES = 256 * 1024, TTL = 10 * 60 * 1000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max ? value : null;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 || Number.isSafeInteger(value);

// This is a separate opt-in projection. The ordinary status reader remains
// read-only and never retains prompt text. Unknown protocols fail closed.
function selectActionField(path, type) {
  if (!path.length) return type === 'object';
  const last = path.at(-1);
  let allowed = false;
  if (path.length === 1) allowed = ['type', 'method', 'requestId', 'sourceClientId', 'handledByClientId', 'resultType', 'result', 'version', 'params'].includes(last);
  else if (path[0] === 'result') allowed = path.length === 2 && ['clientId', 'ok'].includes(last);
  else if (path[0] === 'params') {
    if (path.length === 2) allowed = ['hostId', 'conversationId', 'status', 'clientId', 'change'].includes(last);
    else if (path[1] === 'change') {
      if (path.length === 3) allowed = ['type', 'revision', 'baseRevision', 'conversationState', 'patches'].includes(last);
      else if (path[2] === 'conversationState') allowed = path.length === 4 ? last === 'requests' : typeof last === 'number' || REQUEST_FIELDS.has(last);
      else if (path[2] === 'patches') allowed = typeof last === 'number' || ['op', 'path', 'value'].includes(last) || path.includes('value') && REQUEST_FIELDS.has(last);
    }
  }
  return allowed ? type === 'string' ? ['command', 'reason', 'question', 'description', 'value'].includes(last) ? 4096 : 1024 : true : false;
}

function pointer(value) {
  const parts = Array.isArray(value) ? value : typeof value === 'string' && value.startsWith('/')
    ? value.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) : value === '' ? [] : null;
  return parts && parts.length < 20 && parts.every(part => (typeof part === 'string' || Number.isSafeInteger(part)) &&
    !['__proto__', 'prototype', 'constructor'].includes(part)) ? parts : null;
}

function applyChange(previous, change) {
  if (!Number.isSafeInteger(change?.revision) || change.revision < 0) return null;
  let next;
  if (change.type === 'snapshot') next = { requests: change.conversationState?.requests, revision: change.revision };
  else {
    if (change.type !== 'patches' || !previous || previous.revision !== change.baseRevision || !Array.isArray(change.patches) || change.patches.length > 10000) return null;
    next = structuredClone(previous);
    for (const patch of change.patches) {
      const parts = pointer(patch.path);
      if (!parts) return null;
      if (!parts.length) {
        if (!['replace', 'add'].includes(patch.op)) return null;
        next = { requests: patch.value?.requests };
        continue;
      }
      if (parts[0] !== 'requests') continue;
      if (parts.slice(1).some(part => typeof part !== 'number' && !/^\d+$/.test(part) && part !== '-' && !REQUEST_FIELDS.has(part))) continue;
      if (!['add', 'replace', 'remove'].includes(patch.op)) return null;
      let parent = next;
      for (const key of parts.slice(0, -1)) {
        if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) return null;
        parent = parent[key];
      }
      if (!parent || typeof parent !== 'object') return null;
      let key = parts.at(-1);
      if (Array.isArray(parent)) {
        key = key === '-' ? parent.length : Number(key);
        if (!Number.isSafeInteger(key) || key < 0 || key > parent.length || patch.op !== 'add' && key === parent.length) return null;
        if (patch.op === 'add') parent.splice(key, 0, patch.value);
        else if (patch.op === 'remove') parent.splice(key, 1);
        else parent[key] = patch.value;
      } else if (patch.op === 'remove') delete parent[key];
      else Object.defineProperty(parent, key, { value: patch.value, enumerable: true, configurable: true, writable: true });
    }
    next.revision = change.revision;
  }
  return Array.isArray(next.requests) && next.requests.length <= MAX_REQUESTS && Buffer.byteLength(JSON.stringify(next)) <= MAX_BYTES ? next : null;
}

class CodexActionReader extends CodexAttentionReader {
  constructor(options) {
    super(options);
    this.decoder = new JsonProjectionFrameDecoder({ select: selectActionField, maxProjectedBytes: MAX_BYTES });
    this.responses = new Map();
    this.listeners = new Set();
  }
  changed() { for (const listener of this.listeners || []) listener(); }
  handle(message) {
    if (message.type === 'response' && this.responses.has(message.requestId)) {
      const resolve = this.responses.get(message.requestId);
      this.responses.delete(message.requestId);
      resolve(message);
      return;
    }
    if (message.type !== 'broadcast' || message.method !== 'thread-stream-state-changed') return super.handle(message);
    const { conversationId: id, change, hostId } = message.params || {};
    if (hostId !== 'local' || !this.wanted.has(id)) return;
    if (message.version !== 11 || typeof message.sourceClientId !== 'string') { this.states.delete(id); this.changed(); return; }
    const prior = this.states.get(id), revision = this.revisions.get(id);
    if (change?.type === 'patches' && revision?.owner !== message.sourceClientId) return;
    if (revision?.owner === message.sourceClientId && (change?.revision < revision.value || change?.revision === revision.value && prior)) return;
    const next = applyChange(prior?.owner === message.sourceClientId ? prior : null, change);
    if (Number.isSafeInteger(change?.revision)) this.revisions.set(id, { owner: message.sourceClientId, value: change.revision });
    if (next) this.states.set(id, { ...next, owner: message.sourceClientId });
    else {
      this.states.delete(id);
      if (this.now() - (this.lastSnapshotRequest.get(id) || 0) >= 5000) {
        this.lastSnapshotRequest.set(id, this.now()); this.follow(id, false); this.follow(id, true);
      }
    }
    this.changed();
  }
  request(method, params, owner, timeout = 8000) {
    if (!this.client || !this.socket?.writable || ![...METHODS.values()].includes(method)) return Promise.reject(new Error('local-unavailable'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.responses.delete(requestId); reject(new Error('outcome-unknown')); }, timeout);
      this.responses.set(requestId, response => {
        clearTimeout(timer);
        if (response.resultType === 'success' && (response.method !== method || response.handledByClientId !== owner ||
          response.version !== undefined && response.version !== 1)) reject(new Error('invalid-local-response'));
        else resolve(response);
      });
      this.send({ type: 'request', sourceClientId: this.client, requestId, method, version: 1, targetClientId: owner, timeoutMs: timeout, params });
    });
  }
  close() {
    for (const resolve of this.responses?.values() || []) resolve({ resultType: 'error', error: 'local-disconnected' });
    this.responses?.clear();
    super.close();
  }
}

function presentRequest(request, thread, owner) {
  if (!request || request.completed === true || !identity(request.id) || !METHODS.has(request.method)) return null;
  const params = request.params;
  if (!params || params.threadId !== thread || !identity(params.turnId) || !identity(params.itemId)) return null;
  const kind = request.method === 'item/tool/requestUserInput' ? 'input' : 'approval';
  const fingerprint = hash([thread, owner, request]);
  let detail, questions, localQuestions, fullContent;
  if (kind === 'input') {
    if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 16) return null;
    const ids = new Set(); questions = []; localQuestions = new Map(); fullContent = { questions: [] };
    for (const item of params.questions) {
      if (!item || !text(item.id, 256) || ids.has(item.id) || !text(item.question) || item.isSecret === true ||
        item.header != null && text(item.header, 256) == null || item.options != null && (!Array.isArray(item.options) || item.options.length > 32)) return null;
      ids.add(item.id);
      const options = [];
      for (const option of item.options || []) {
        if (!text(option?.label, 256) || option.description != null && text(option.description, 1024) == null) return null;
        options.push({ label: `option.${options.length + 1}`, description: '' });
      }
      const id = hash([fingerprint, item.id]);
      localQuestions.set(id, { id: item.id, labels: (item.options || []).map(option => option.label), other: item.isOther === true });
      questions.push({ id, header: `question.${questions.length + 1}`, question: 'review.questionOnDesktop', options, isOther: item.isOther === true });
      fullContent.questions.push({ id, header: item.header || '', question: item.question,
        options: (item.options || []).map(option => ({ label: option.label, description: option.description || '' })) });
    }
    detail = 'input';
  } else {
    const command = text(params.command), reason = text(params.reason), root = text(params.grantRoot, 1024);
    if (request.method.includes('commandExecution') && !command) return null;
    if (request.method.includes('fileChange') && !reason && !root) return null;
    if (params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes('accept') || !params.availableDecisions.includes('decline'))) return null;
    // Metadata-only mode uses a fixed executable vocabulary. Optional original
    // text is carried separately and never substitutes for numbered identities.
    const match = command?.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    const executable = (match?.[1] || match?.[2] || match?.[3] || '').split(/[\\/]/).at(-1);
    const common = new Set(['git', 'npm', 'npx', 'node', 'python', 'python3', 'pip', 'pip3', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cargo', 'go', 'make', 'cmake', 'swift', 'xcodebuild', 'gradle', 'docker', 'curl', 'wget', 'ls', 'cat', 'rg', 'find', 'cp', 'mv', 'rm']);
    detail = request.method.includes('fileChange') ? 'fileChange' : common.has(executable) ? executable : 'command';
    fullContent = Object.fromEntries((request.method.includes('fileChange') ? ['cwd', 'reason', 'grantRoot'] : ['command', 'cwd', 'reason'])
      .filter(key => typeof params[key] === 'string').map(key => [key, params[key]]));
  }
  const item = { id: `codex-${fingerprint}`, provider: 'codex', kind,
    title: kind === 'input' ? 'codex.input' : request.method.includes('commandExecution') ? 'codex.commandApproval' : 'codex.fileApproval',
    detail, ...(questions ? { questions } : {}) };
  const validFullText = value => typeof value === 'string' ? !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)
    : Array.isArray(value) ? value.every(validFullText) : value && typeof value === 'object' ? Object.values(value).every(validFullText) : true;
  const fullContentValid = validFullText(fullContent) && ['cwd', 'grantRoot'].every(key => fullContent[key] === undefined || fullContent[key].length <= 1024)
    && ['command', 'reason'].every(key => fullContent[key] === undefined || fullContent[key].length <= 4096);
  return { item, localQuestions, fullContent, fullContentValid, thread, owner, requestId: request.id, method: request.method, fingerprint };
}

class CloudActionAdapter {
  constructor({ statusReader, now = Date.now, reader, timeout = 8000 } = {}) {
    this.statusReader = statusReader; this.now = now; this.timeout = timeout;
    this.reader = reader || new CodexActionReader({ codexHome: statusReader.codexHome, now });
    this.entries = new Map(); this.finished = new Map(); this.inFlight = new Map(); this.disposed = false; this.generation = 0;
  }
  refresh() {
    const current = new Map();
    if (!this.reader.client) { this.entries.clear(); return; }
    for (const [thread, state] of this.reader.states) for (const request of state.requests || []) {
      const entry = presentRequest(request, thread, state.owner);
      if (!entry) continue;
      entry.revision = state.revision;
      entry.item.expiresAt = this.entries.get(entry.item.id)?.item.expiresAt || this.now() + TTL;
      current.set(entry.item.id, entry);
    }
    this.entries = current;
  }
  async pending({ uploadFullContent = false } = {}) {
    if (this.disposed) return [];
    const generation = this.generation;
    const source = this.statusReader?.codexAttention;
    if (source) await this.reader.poll([...source.wanted], Boolean(source.client), this.now());
    if (this.disposed || this.generation !== generation) return [];
    this.refresh();
    // Keep the full eligible count until projectStatus applies its count/byte
    // budget, so the mobile snapshot can flag an incomplete request list.
    return [...this.entries.values()].filter(entry => entry.item.expiresAt > this.now() && !this.finished.has(entry.item.id))
      .map(entry => structuredClone({ ...entry.item, ...(uploadFullContent ? entry.fullContentValid ? { fullContent: entry.fullContent } : { fullContentUnavailable: true } : {}) }));
  }
  execute(command) {
    if (this.inFlight.has(command?.id)) return this.inFlight.get(command.id);
    const promise = this.perform(command);
    this.inFlight.set(command?.id, promise);
    void promise.finally(() => this.inFlight.delete(command?.id));
    return promise;
  }
  async perform(command) {
    const generation = this.generation;
    const result = (status, error) => ({ id: typeof command?.id === 'string' ? command.id : '', status, ...(error ? { error } : {}) });
    if (this.disposed) return result('failed', 'local-unavailable');
    if (!text(command?.id, 128) || !text(command?.requestId, 256)) return result('failed', 'invalid-command');
    if (!Number.isSafeInteger(command.expiresAt) || command.expiresAt <= this.now()) return result('failed', 'command-expired');
    this.refresh();
    const entry = this.entries.get(command.requestId);
    if (!entry || entry.item.expiresAt <= this.now()) return result('failed', 'request-expired');
    if (this.finished.has(entry.item.id)) return result('failed', 'request-already-handled');
    const params = { conversationId: entry.thread, requestId: entry.requestId };
    if (entry.item.kind === 'input') {
      if (command.kind !== 'answer') return result('failed', 'wrong-action');
      const source = command.answers || (entry.item.questions.length === 1 && text(command.answer) != null
        ? { [entry.item.questions[0].id]: { answers: [command.answer] } } : null);
      if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== entry.item.questions.length) return result('failed', 'invalid-answers');
      const answers = Object.create(null);
      for (const question of entry.item.questions) {
        const values = Object.hasOwn(source, question.id) && source[question.id]?.answers;
        if (!Array.isArray(values) || values.length < 1 || values.length > 16 || values.some(value => !text(value) || !value.trim())) return result('failed', 'invalid-answers');
        const local = entry.localQuestions.get(question.id);
        const mapped = [];
        for (const value of values) {
          const index = question.options.findIndex(option => option.label === value);
          if (index >= 0) mapped.push(local.labels[index]);
          else if (local.other || !local.labels.length) mapped.push(value);
          else return result('failed', 'invalid-answers');
        }
        answers[local.id] = { answers: mapped };
      }
      params.response = { answers };
    } else {
      if (!['approve', 'deny'].includes(command.kind)) return result('failed', 'wrong-action');
      params.decision = command.kind === 'approve' ? 'accept' : 'decline';
    }
    // Mark before dispatch: timeout/disconnect is an unknown outcome and must not
    // replay an approval automatically. The owner may already have consumed it.
    this.finished.set(entry.item.id, this.now());
    while (this.finished.size > 2048) this.finished.delete(this.finished.keys().next().value);
    let stop;
    const resolution = new Promise(resolve => {
      const timer = setTimeout(() => { stop(); resolve(false); }, this.timeout);
      const check = () => {
        const state = this.reader.states.get(entry.thread);
        if (!this.reader.client || state?.owner !== entry.owner) return;
        if (state.revision > entry.revision && !state.requests.some(request => request.id === entry.requestId && request.completed !== true)) { stop(); resolve(true); }
      };
      stop = () => { clearTimeout(timer); this.reader.listeners.delete(check); };
      this.reader.listeners.add(check); check();
    });
    try {
      const response = await this.reader.request(METHODS.get(entry.method), params, entry.owner, this.timeout);
      if (this.generation !== generation || this.disposed) { stop(); return result('failed', 'local-unavailable'); }
      if (response.resultType !== 'success' || response.result?.ok !== true) { stop(); return result('failed', 'local-rejected'); }
      const resolved = await resolution;
      if (this.generation !== generation || this.disposed) return result('failed', 'local-unavailable');
      return resolved ? result('succeeded') : result('failed', 'outcome-unknown');
    } catch { stop(); return result('failed', 'outcome-unknown'); }
  }
  suspend() { this.generation++; this.reader.close(); this.entries.clear(); }
  dispose() { this.disposed = true; this.suspend(); }
}

module.exports = { CloudActionAdapter, CodexActionReader, applyChange, presentRequest, selectActionField };
