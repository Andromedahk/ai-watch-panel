const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { JsonProjectionFrameDecoder } = require('./json-projection-frame-decoder.cjs');
const { applyAttentionChange, summarizeAttention, selectAttentionField } = require('./codex-attention-state.cjs');
class CodexAttentionReader {
  constructor({ codexHome, connect = net.createConnection, platform = process.platform, onChange = () => {}, now = Date.now } = {}) {
    this.endpoint = path.join(codexHome, 'ipc', 'ipc.sock'); this.connect = connect; this.platform = platform;
    this.socket = null; this.client = null; this.decoder = new JsonProjectionFrameDecoder({ select: selectAttentionField }); this.states = new Map();
    this.wanted = new Set(); this.subscribed = new Set(); this.lastSnapshotRequest = new Map(); this.retryAt = 0;
    this.onChange = onChange; this.now = now; this.generation = 0; this.opening = null; this.changeTimer = null; this.fingerprint = '';
    this.revisions = new Map();
  }
  async poll(threadIds, available, now = Date.now()) {
    const known = summarizeAttention(this.states).waitingThreads;
    this.wanted = new Set([...new Set([...known].filter(id => threadIds.includes(id)).concat(threadIds)
      .filter(id => typeof id === 'string' && id.length <= 256))].slice(0, 32));
    if (!available) this.close();
    else if (!this.socket && now >= this.retryAt) {
      if (!this.opening) this.opening = this.open(now).finally(() => { this.opening = null; });
      await this.opening;
    }
    if (this.client) this.syncSubscriptions(now);
    return this.summary();
  }
  summary() {
    const summary = summarizeAttention(this.states);
    return { ...summary, connected: Boolean(this.client), observedThreads: this.states.size };
  }
  changed() {
    const summary = this.summary();
    const fingerprint = JSON.stringify([summary.connected, summary.observedThreads, [...summary.inputThreads].sort(), [...summary.approvalThreads].sort()]);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    if (!this.changeTimer) this.changeTimer = setTimeout(() => { this.changeTimer = null; this.onChange(); }, 50);
  }
  async open(now) {
    this.retryAt = now + 15000;
    const generation = this.generation;
    if (this.platform === 'win32') return;
    try {
      const [file, directory] = await Promise.all([fs.lstat(this.endpoint), fs.lstat(path.dirname(this.endpoint))]);
      if (generation !== this.generation) return;
      const uid = process.getuid?.();
      if (!file.isSocket() || !directory.isDirectory() || uid == null || file.uid !== uid || directory.uid !== uid || (directory.mode & 0o022)) return;
      const socket = this.connect(this.endpoint); this.socket = socket;
      const deadline = setTimeout(() => { if (this.socket === socket) this.close(); }, 3000);
      socket.on('connect', () => { if (this.socket === socket) this.send({ type: 'request', method: 'initialize', requestId: randomUUID(),
        sourceClientId: 'initializing-client', version: 0, params: { clientType: 'ai-watch' } }); });
      socket.on('data', chunk => {
        if (this.socket !== socket) return;
        try {
          this.decoder.feed(chunk, message => {
            this.handle(message);
            if (this.client) clearTimeout(deadline);
          });
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
  syncSubscriptions(now = this.now()) {
    for (const id of this.subscribed) if (!this.wanted.has(id)) { this.follow(id, false); this.subscribed.delete(id); this.states.delete(id); this.lastSnapshotRequest.delete(id); this.revisions.delete(id); }
    for (const id of this.wanted) {
      if (!this.subscribed.has(id)) { this.follow(id, true); this.subscribed.add(id); this.lastSnapshotRequest.set(id, now); }
      else if (!this.states.has(id) && now - (this.lastSnapshotRequest.get(id) ?? -Infinity) >= 5000) {
        this.lastSnapshotRequest.set(id, now); this.follow(id, false); this.follow(id, true);
      }
    }
    this.changed();
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
      for (const [id, state] of this.states) if (state.owner === message.params.clientId) { this.states.delete(id); this.subscribed.delete(id); this.revisions.delete(id); }
      this.changed();
    }
    if (message.method === 'ipc-connection-reset') { this.close(); this.retryAt = 0; return; }
    if (message.method === 'thread-stream-following-status-requested' && message.params?.hostId === 'local' && this.wanted.has(message.params.conversationId)) this.follow(message.params.conversationId, true);
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11 || message.params?.hostId !== 'local') return;
    const { conversationId: id, change } = message.params;
    if (!this.wanted.has(id)) return;
    const previous = this.states.get(id);
    const revision = this.revisions.get(id);
    if (change?.type === 'patches' && revision && revision.owner !== message.sourceClientId) return;
    if (revision?.owner === message.sourceClientId && Number.isSafeInteger(change?.revision) &&
      (change.revision < revision.value || change.revision === revision.value && previous)) return;
    // A gap still proves that older snapshots are obsolete. Preserve the highest
    // observed revision while asking the owner for a complete replacement.
    if (['snapshot', 'patches'].includes(change?.type) && Number.isSafeInteger(change.revision) && change.revision >= 0) {
      this.revisions.set(id, { owner: message.sourceClientId, value: change.revision });
    }
    const next = applyAttentionChange(previous?.owner === message.sourceClientId ? previous : null, change);
    if (next) { this.states.set(id, { ...next, owner: message.sourceClientId }); this.revisions.set(id, { owner: message.sourceClientId, value: next.revision }); }
    else {
      this.states.delete(id);
      // A dropped revision must not leave a stale red light. Ask for a fresh snapshot.
      const now = this.now();
      if (now - (this.lastSnapshotRequest.get(id) ?? -Infinity) >= 5000) {
        this.lastSnapshotRequest.set(id, now); this.follow(id, false); this.follow(id, true);
      }
    }
    this.changed();
  }
  close() {
    this.generation++;
    const socket = this.socket; this.socket = null; this.client = null; this.decoder.reset();
    this.states.clear(); this.subscribed.clear(); this.lastSnapshotRequest.clear(); this.revisions.clear(); socket?.destroy();
    this.changed();
  }
}
module.exports = { CodexAttentionReader, applyAttentionChange, summarizeAttention };
