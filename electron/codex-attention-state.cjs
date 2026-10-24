const { createHash } = require('node:crypto');

const MAX_REQUESTS = 256;
const MAX_QUESTIONS = 256;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const INPUT = new Set(['item/tool/requestUserInput', 'item/tool/requestOptionPicker']);
const APPROVAL = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
const INPUT_TOOLS = new Set(['request_onboarding_input', 'request_option_picker', 'request_environment_input']);
const FIELDS = new Set(['requests', 'turns', 'items', 'id', 'turnId', 'type', 'status', 'method', 'completed',
  'params', 'tool', 'arguments', 'step', 'questions', 'content', 'input', 'text', 'pendingRequest',
  'kind', 'elicitationKind', 'unansweredAsyncQuestions', 'questionIds', 'turnHistory', 'history', 'entitiesByKey']);
const CONVERSATION = new Set(['requests', 'turns', 'pendingRequest', 'unansweredAsyncQuestions', 'turnHistory']);
const ENVELOPE = new Set(['type', 'method', 'requestId', 'sourceClientId', 'resultType', 'version', 'result', 'params']);
const PARAMETERS = new Set(['hostId', 'conversationId', 'status', 'clientId', 'change']);
const CHANGE = new Set(['type', 'revision', 'baseRevision', 'conversationState', 'patches']);
const hash = value => createHash('sha256').update(value).digest('hex');
const ITEM_TYPES = new Set(['agentMessage', 'userMessage', 'steeringUserMessage', 'text', 'inputText']);
const ITEM_FIELDS = new Set(['id', 'type', 'status', 'questions', 'content', 'input']);
const STATUSES = new Set(['inProgress', 'completed', 'failed', 'interrupted', 'cancelled', 'accepted', 'pending', 'rejected']);

// Decode only a small projection of the IPC envelope and attention metadata. Long
// message bodies, command arguments, titles and attachment data are never packed.
function selectAttentionField(path, type) {
  if (!path.length) return type === 'object';
  let allowed = false;
  if (path.length === 1) allowed = ENVELOPE.has(path[0]);
  else if (path[0] === 'result') allowed = path.length === 2 && path[1] === 'clientId';
  else if (path[0] === 'params') {
    if (path.length === 2) allowed = PARAMETERS.has(path[1]);
    else if (path[1] === 'change') {
      if (path.length === 3) allowed = CHANGE.has(path[2]);
      else if (path[2] === 'conversationState') {
        allowed = path.length === 4 ? CONVERSATION.has(path[3]) :
          typeof path.at(-1) === 'number' || FIELDS.has(path.at(-1)) || path.at(-2) === 'entitiesByKey';
      } else if (path[2] === 'patches') {
        allowed = typeof path.at(-1) === 'number' || ['op', 'path', 'value'].includes(path.at(-1)) ||
          path.includes('value') && (FIELDS.has(path.at(-1)) || path.at(-2) === 'entitiesByKey');
      }
    }
  }
  if (!allowed) return false;
  // A reply marker is parsed into hashed question identifiers immediately after
  // projection. Its text never enters cached state or the renderer bridge.
  if (type === 'string') return ['text', 'value'].includes(path.at(-1)) ? 65536 : 256;
  return true;
}

function replyKeys(text) {
  if (typeof text !== 'string') return [];
  const start = text.lastIndexOf('<send_user_message_question_reply>');
  if (start < 0 || !text.trimEnd().endsWith('</send_user_message_question_reply>')) return [];
  try {
    const value = JSON.parse(text.slice(start + 34, text.lastIndexOf('</send_user_message_question_reply>')));
    const replies = Array.isArray(value) ? value : [value];
    if (replies.length > MAX_QUESTIONS) return [];
    return replies.flatMap(reply => {
      if (typeof reply?.questionItemId !== 'string' || reply.questionItemId.length > 1024) return [];
      const identity = JSON.parse(reply.questionItemId);
      return Array.isArray(identity) && identity.length === 3 && identity[0] === 'request_user_input_async' &&
        typeof identity[1] === 'string' && identity[1].length <= 256 && Number.isSafeInteger(identity[2]) && identity[2] >= 0 && identity[2] < MAX_QUESTIONS
        ? [`${hash(identity[1])}:${identity[2]}`] : [];
    });
  } catch { return []; }
}

function sanitize(value, key = '') {
  if (key === 'requests' && Array.isArray(value)) return value.map(request => {
    const method = typeof request?.method === 'string' && (INPUT.has(request.method) || APPROVAL.has(request.method) ||
      ['item/tool/call', 'mcpServer/elicitation/request'].includes(request.method)) ? request.method : '';
    const result = { method };
    if (request?.completed === true) result.completed = true;
    const tool = request?.params?.tool;
    if (method === 'item/tool/call') {
      result.params = {};
      if (INPUT_TOOLS.has(tool) || tool === 'setup_codex_step') result.params.tool = tool;
      if (tool === 'setup_codex_step') {
        result.params.arguments = {};
        if (['role', 'task', 'complete'].includes(request.params?.arguments?.step)) result.params.arguments.step = request.params.arguments.step;
      }
    }
    return result;
  });
  if (key === 'text') return replyKeys(value);
  if (key === 'id' || key === 'turnId') return typeof value === 'string' && value.length <= 256 ? hash(value) : null;
  if (key === 'type') return ITEM_TYPES.has(value) ? value : '';
  if (key === 'status') return STATUSES.has(value) ? value : '';
  if (key === 'item') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = Object.create(null);
    for (const field of ['id', 'type', 'status', 'questions']) if (Object.hasOwn(value, field)) item[field] = sanitize(value[field], field);
    if (['userMessage', 'steeringUserMessage'].includes(value.type)) {
      for (const field of ['content', 'input']) if (Object.hasOwn(value, field)) item[field] = sanitize(value[field], field);
    }
    return item;
  }
  if (key === 'turn') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const turn = Object.create(null);
    for (const field of ['id', 'turnId', 'status', 'items']) if (Object.hasOwn(value, field)) turn[field] = sanitize(value[field], field);
    return turn;
  }
  if (key === 'questions' || key === 'questionIds') return Array.isArray(value) && value.length <= MAX_QUESTIONS ? Array(value.length).fill(null) : [];
  if (['turns', 'items'].includes(key) && Array.isArray(value)) return value.map(entry => sanitize(entry, key === 'turns' ? 'turn' : 'item'));
  if (['content', 'input'].includes(key)) return Array.isArray(value) ? value.map(entry =>
    entry && typeof entry === 'object' && ['text', 'inputText'].includes(entry.type) ? { type: entry.type, text: replyKeys(entry.text) } : null) : [];
  if (key === 'entitiesByKey' && value && typeof value === 'object' && !Array.isArray(value)) {
    const turns = Object.create(null);
    for (const [identity, turn] of Object.entries(value)) if (identity.length <= 256) turns[hash(identity)] = sanitize(turn, 'turn');
    return turns;
  }
  if (Array.isArray(value)) return value.map(entry => sanitize(entry));
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const [name, entry] of Object.entries(value)) if (FIELDS.has(name)) result[name] = sanitize(entry, name);
    return result;
  }
  return typeof value === 'string' ? value.length <= 256 ? value : null :
    value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pointer(path) {
  const parts = Array.isArray(path) ? path : typeof path === 'string' && path.startsWith('/')
    ? path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) : path === '' ? [] : null;
  if (!parts || parts.length > 32 || parts.some(part => typeof part !== 'string' && !Number.isSafeInteger(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) return null;
  return parts;
}

function patchValue(root, parts, patch) {
  // Question wording is intentionally absent from the projection. A content-only
  // update must still advance the revision without invalidating its placeholders.
  if (parts.includes('questions') && parts.at(-2) !== 'questions' && parts.at(-1) !== 'questions') return true;
  let parent = root;
  for (const key of parts.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) return false;
    parent = parent[key];
  }
  if (!parent || typeof parent !== 'object') return false;
  const last = parts.at(-1);
  const key = Array.isArray(parent) ? last === '-' ? parent.length : Number(last) : last;
  if (Array.isArray(parent) && (!Number.isSafeInteger(key) || key < 0 || key > parent.length || key > 100000)) return false;
  if (parts.at(-2) === 'questions' && Array.isArray(parent) && patch.op === 'add' && parent.length >= MAX_QUESTIONS) return false;
  const role = parts.at(-2) === 'items' ? 'item' : parts[0] === 'turns' && parts.length === 2 || parts[0] === 'turnHistory' && parts.length === 4 ? 'turn' : typeof last === 'string' ? last : '';
  const value = parts.at(-2) === 'questions' ? null : sanitize(patch.value, role);
  if (Array.isArray(parent)) {
    if (patch.op === 'add') parent.splice(key, 0, value);
    else if (key >= parent.length) return false;
    else if (patch.op === 'remove') parent.splice(key, 1);
    else if (patch.op === 'replace') parent[key] = value;
    else return false;
  } else if (patch.op === 'remove') delete parent[key];
  else if (patch.op === 'add' || patch.op === 'replace') parent[key] = value;
  else return false;
  return true;
}

function applyAttentionChange(previous, change) {
  if (!Number.isSafeInteger(change?.revision) || change.revision < 0) return null;
  if (change.type === 'snapshot') {
    const source = change.conversationState;
    if (!Array.isArray(source?.requests) || source.requests.length > MAX_REQUESTS) return null;
    if (Object.hasOwn(source, 'turns') && !Array.isArray(source.turns)) return null;
    if (previous && change.revision <= previous.revision) return previous;
    const projected = Object.create(null);
    for (const field of CONVERSATION) if (Object.hasOwn(source, field)) projected[field] = sanitize(source[field], field);
    const state = { ...projected, revision: change.revision };
    return Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE_BYTES ? state : null;
  }
  if (change.type !== 'patches' || !previous || !Array.isArray(change.patches)) return null;
  if (change.revision <= previous.revision) return previous;
  if (previous.revision !== change.baseRevision || change.patches.length > 100000) return null;
  let result = previous;
  for (const patch of change.patches) {
    const parts = pointer(patch.path);
    if (!parts) return null;
    if (!parts.length) {
      if (!['add', 'replace'].includes(patch.op)) return null;
      result = applyAttentionChange(null, { type: 'snapshot', revision: change.revision, conversationState: patch.value });
      if (!result) return null;
    } else if (CONVERSATION.has(parts[0])) {
      if (parts[0] === 'turns' && parts.length > 2 && !['status', 'turnId', 'id', 'items'].includes(parts[2])) continue;
      if (parts[0] === 'turnHistory' && parts.length > 1 && !['kind', 'history'].includes(parts[1])) continue;
      if (parts[0] === 'turnHistory' && parts.length > 2 && parts[2] !== 'entitiesByKey') continue;
      if (parts[0] === 'turnHistory' && parts.length > 3) parts[3] = hash(String(parts[3]));
      if (parts[0] === 'turnHistory' && parts.length > 4 && !['status', 'turnId', 'id', 'items'].includes(parts[4])) continue;
      if (parts.some((part, index) => index > 0 && !Number.isSafeInteger(Number(part)) && part !== '-' && !FIELDS.has(part) &&
        !(parts[0] === 'turnHistory' && index === 3))) continue;
      const itemAt = parts.lastIndexOf('items');
      if (itemAt >= 0 && parts.length > itemAt + 2 && !ITEM_FIELDS.has(parts[itemAt + 2])) continue;
      if (itemAt >= 0 && ['content', 'input'].includes(parts[itemAt + 2])) {
        let item = result;
        for (const part of parts.slice(0, itemAt + 2)) item = item?.[part];
        if (item?.type !== undefined && !['userMessage', 'steeringUserMessage'].includes(item.type)) continue;
      }
      if (parts.at(-1) === 'text') {
        let parent = result;
        for (const part of parts.slice(0, -1)) parent = parent?.[part];
        if (parent?.type === 'agentMessage') continue;
      }
      if (result === previous) result = structuredClone(previous);
      if (!patchValue(result, parts, patch)) return null;
    }
  }
  if (result === previous) return { ...previous, revision: change.revision };
  if (!Array.isArray(result.requests) || result.requests.length > MAX_REQUESTS || Object.hasOwn(result, 'turns') && !Array.isArray(result.turns)) return null;
  result.requests = sanitize(result.requests, 'requests');
  result.revision = change.revision;
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_STATE_BYTES ? result : null;
}

function requestKinds(request) {
  if (!request || request.completed === true) return [];
  if (INPUT.has(request.method)) return ['input'];
  if (APPROVAL.has(request.method)) return ['approval'];
  if (request.method === 'mcpServer/elicitation/request') return ['input'];
  if (request.method === 'item/tool/call' && (INPUT_TOOLS.has(request.params?.tool) ||
    request.params?.tool === 'setup_codex_step' && ['role', 'task'].includes(request.params?.arguments?.step))) return ['input'];
  return [];
}

function hasAsyncQuestions(state) {
  if (state.unansweredAsyncQuestions?.questionIds?.length) return true;
  const turns = [...Array.isArray(state.turns) ? state.turns : [], ...Object.values(state.turnHistory?.history?.entitiesByKey || {})];
  for (const turn of turns) {
    if (turn?.status !== 'inProgress' || !Array.isArray(turn.items)) continue;
    const asked = new Set(), answered = new Set();
    for (const item of turn.items) {
      if (item?.type === 'agentMessage' && typeof item.id === 'string') {
        for (let index = 0; index < (item.questions?.length || 0); index++) asked.add(`${item.id}:${index}`);
      }
      if (item?.type === 'userMessage' || item?.type === 'steeringUserMessage' && item.status === 'accepted') {
        for (const entry of item.content || item.input || []) for (const key of Array.isArray(entry?.text) ? entry.text : []) answered.add(key);
      }
    }
    for (const key of asked) if (!answered.has(key)) return true;
  }
  return false;
}

function summarizeAttention(states) {
  const inputThreads = new Set(), approvalThreads = new Set();
  for (const [id, state] of states) {
    for (const request of state.requests) for (const kind of requestKinds(request)) (kind === 'input' ? inputThreads : approvalThreads).add(id);
    if (hasAsyncQuestions(state)) inputThreads.add(id);
    if (['userInput', 'optionPicker', 'setupCodexStep', 'mcpServerElicitation', 'implementPlan'].includes(state.pendingRequest?.kind)) inputThreads.add(id);
    if (['approval', 'permissionRequest'].includes(state.pendingRequest?.kind)) approvalThreads.add(id);
  }
  return { inputThreads, approvalThreads, waitingThreads: new Set([...inputThreads, ...approvalThreads]) };
}

module.exports = { applyAttentionChange, summarizeAttention, selectAttentionField };
