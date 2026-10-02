const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_REQUESTS = 256;
const INPUT = new Set(['item/tool/requestUserInput', 'item/tool/requestOptionPicker']);
const APPROVAL = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
function requestMetadata(request) {
  // Retain no question, command, permission payload, title, path, or account information.
  return { method: typeof request?.method === 'string' && request.method.length < 100 ? request.method : '' };
}
function applyAttentionChange(previous, change) {
  if (!Number.isSafeInteger(change?.revision)) return null;
  if (change.type === 'snapshot') {
    const requests = change.conversationState?.requests;
    if (!Array.isArray(requests) || requests.length > MAX_REQUESTS) return null;
    return { revision: change.revision, requests: requests.map(requestMetadata) };
  }
  if (change.type !== 'patches' || !previous || previous.revision !== change.baseRevision || !Array.isArray(change.patches)) return null;
  const requests = previous.requests.map(r => ({ ...r }));
  for (const patch of change.patches) {
    const parts = Array.isArray(patch.path) ? patch.path : typeof patch.path === 'string' ? patch.path.split('/').slice(1) : null;
    if (!parts) return null;
    if (!parts.length) return null;
    if (parts[0] !== 'requests') continue;
    if (parts.length === 1 && ['add', 'replace'].includes(patch.op)) {
      if (!Array.isArray(patch.value) || patch.value.length > MAX_REQUESTS) return null;
      requests.splice(0, requests.length, ...patch.value.map(requestMetadata)); continue;
    }
    const index = parts[1] === '-' ? requests.length : Number(parts[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index > requests.length || index >= MAX_REQUESTS) return null;
    if (parts.length === 2) {
      if (patch.op === 'add') requests.splice(index, 0, requestMetadata(patch.value));
      else if (patch.op === 'remove' && index < requests.length) requests.splice(index, 1);
      else if (patch.op === 'replace' && index < requests.length) requests[index] = requestMetadata(patch.value);
      else return null;
    } else if (parts.length === 3 && parts[2] === 'method' && requests[index]) {
      requests[index] = requestMetadata({ method: patch.op === 'remove' ? '' : patch.value });
    }
    if (requests.length > MAX_REQUESTS) return null;
  }
  return { revision: change.revision, requests };
}
function summarizeAttention(states) {
  const inputThreads = new Set(); const approvalThreads = new Set();
  for (const [id, state] of states) for (const request of state.requests) {
    if (INPUT.has(request.method)) inputThreads.add(id);
    if (APPROVAL.has(request.method)) approvalThreads.add(id);
  }
  return { inputThreads, approvalThreads, waitingThreads: new Set([...inputThreads, ...approvalThreads]) };
}
class CodexAttentionReader {
  constructor({ codexHome, connect = net.createConnection, platform = process.platform } = {}) {
    this.endpoint = path.join(codexHome, 'ipc', 'ipc.sock'); this.connect = connect; this.platform = platform;
    this.socket = null; this.client = null; this.buffer = Buffer.alloc(0); this.states = new Map();
    this.wanted = new Set(); this.subscribed = new Set(); this.lastSnapshotRequest = new Map(); this.retryAt = 0;
  }
  async poll(threadIds, available, now = Date.now()) {
    this.wanted = new Set(threadIds.slice(0, 32));
    if (!available) this.close();
    else if (!this.socket && now >= this.retryAt) await this.open(now);
    if (this.client) this.syncSubscriptions();
    const summary = summarizeAttention(this.states);
    return { ...summary, connected: Boolean(this.client), observedThreads: this.states.size };
  }
  async open(now) {
    this.retryAt = now + 15000;
    if (this.platform === 'win32') return;
    try {
      const [file, directory] = await Promise.all([fs.lstat(this.endpoint), fs.lstat(path.dirname(this.endpoint))]);
      const uid = process.getuid?.();
      if (!file.isSocket() || !directory.isDirectory() || uid == null || file.uid !== uid || directory.uid !== uid || (directory.mode & 0o022)) return;
      const socket = this.connect(this.endpoint); this.socket = socket;
      const deadline = setTimeout(() => this.close(), 3000);
      socket.on('connect', () => this.send({ type: 'request', method: 'initialize', requestId: randomUUID(),
        sourceClientId: 'initializing-client', version: 0, params: { clientType: 'ai-watch' } }));
      socket.on('data', chunk => {
        if (this.socket !== socket) return;
        try {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          while (this.buffer.length >= 4) {
            const size = this.buffer.readUInt32LE(0);
            if (!size || size > MAX_FRAME) throw new Error('Invalid frame');
            if (this.buffer.length < size + 4) break;
            const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
            this.buffer = this.buffer.length === size + 4 ? Buffer.alloc(0) : this.buffer.subarray(size + 4);
            this.handle(message);
            if (this.client) clearTimeout(deadline);
          }
        } catch { this.close(); }
      });
      socket.on('error', () => { if (this.socket === socket) this.close(); });
      socket.on('close', () => { clearTimeout(deadline); if (this.socket === socket) this.close(); });
    } catch { this.close(); }
  }
  send(message) {
    if (!this.socket?.writable) return;
    const data = Buffer.from(JSON.stringify(message)); const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(data.length); this.socket.write(Buffer.concat([prefix, data]));
  }
  follow(id, following) {
    this.send({ type: 'broadcast', sourceClientId: this.client, version: 1, method: 'thread-stream-following-changed',
      params: { conversationId: id, hostId: 'local', following } });
  }
  syncSubscriptions() {
    for (const id of this.subscribed) if (!this.wanted.has(id)) { this.follow(id, false); this.subscribed.delete(id); this.states.delete(id); this.lastSnapshotRequest.delete(id); }
    for (const id of this.wanted) if (!this.subscribed.has(id)) { this.follow(id, true); this.subscribed.add(id); }
  }
  handle(message) {
    if (message.type === 'response' && message.method === 'initialize' && message.resultType === 'success' && typeof message.result?.clientId === 'string') {
      this.client = message.result.clientId; this.syncSubscriptions(); return;
    }
    if (message.type === 'client-discovery-request') {
      // This monitor never owns a task or handles commands/approvals for another client.
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); return;
    }
    if (message.type !== 'broadcast') return;
    if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
      for (const [id, state] of this.states) if (state.owner === message.params.clientId) { this.states.delete(id); this.subscribed.delete(id); }
    }
    if (message.method === 'thread-stream-following-status-requested' && message.params?.hostId === 'local' && this.wanted.has(message.params.conversationId)) this.follow(message.params.conversationId, true);
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11 || message.params?.hostId !== 'local') return;
    const { conversationId: id, change } = message.params;
    if (!this.wanted.has(id)) return;
    const previous = this.states.get(id);
    const next = applyAttentionChange(previous?.owner === message.sourceClientId ? previous : null, change);
    if (next) this.states.set(id, { ...next, owner: message.sourceClientId });
    else {
      this.states.delete(id);
      // A dropped revision must not leave a stale red light. Ask for a fresh snapshot.
      const now = Date.now();
      if (now - (this.lastSnapshotRequest.get(id) || 0) > 5000) {
        this.lastSnapshotRequest.set(id, now); this.follow(id, false); this.follow(id, true);
      }
    }
  }
  close() {
    const socket = this.socket; this.socket = null; this.client = null; this.buffer = Buffer.alloc(0);
    this.states.clear(); this.subscribed.clear(); this.lastSnapshotRequest.clear(); socket?.destroy();
  }
}
module.exports = { CodexAttentionReader, applyAttentionChange, summarizeAttention };
