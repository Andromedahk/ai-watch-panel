const fs = require('node:fs/promises');
const path = require('node:path');
const { ManagedCliRuntime, AGENTS, UUID, cleanText, safeError, privateDirectory, writePrivateJson } = require('./provider-runtime.cjs');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);
const PURPOSE = 'Execute the explicitly enabled managed relay task and retain a readable result.';

function parseResultEnvelope(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 80000) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).length !== 3 || !['status', 'summary', 'details'].every(key => Object.hasOwn(parsed, key)) ||
    !['completed', 'failed'].includes(parsed.status) || typeof parsed.summary !== 'string' || typeof parsed.details !== 'string') return null;
  const summary = cleanText(parsed.summary, 2001), details = cleanText(parsed.details, 16001);
  if (!summary || summary.length > 2000 || !details || details.length > 16000) return null;
  return { status: parsed.status, summary, details };
}

class AgentDispatcher {
  constructor({ relay, directory, onChange = () => {}, fixtureMode = false, runtime } = {}) {
    if (!relay || !directory) throw new TypeError('relay-and-directory-required');
    this.relay = relay; this.directory = path.resolve(directory); this.onChange = onChange;
    this.runtime = runtime || (fixtureMode ? {
      discover: async () => AGENTS.map(id => ({ id, available: false })),
      run: async () => ({ errorCode: 'cli-unavailable' }), cancel() {}, stop() {}
    } : new ManagedCliRuntime());
    this.enabled = new Set(); this.active = new Map(); this.bindings = {};
    this.agents = new Map(AGENTS.map(id => [id, { id, available: false, enabled: false, busy: false }]));
    this.initialized = false; this.checking = false; this.stopping = false;
    this.bindingWrites = Promise.resolve();
  }
  setEnabledAgents(ids) {
    if (!Array.isArray(ids) || ids.some(id => !AGENTS.includes(id))) throw new TypeError('invalid-agent');
    this.enabled = new Set(ids);
    for (const id of AGENTS) {
      this.agents.get(id).enabled = this.enabled.has(id);
      if (!this.enabled.has(id) && this.active.has(id)) this.runtime.cancel?.(id);
    }
    this.changed();
    return this.getState();
  }
  getState() {
    return { agents: AGENTS.map(id => {
      const state = this.agents.get(id);
      return { id, available: state.available, enabled: state.enabled, busy: state.busy,
        ...(this.bindings[id]?.sessionId ? { sessionId: this.bindings[id].sessionId } : {}),
        ...(state.lastError ? { lastError: state.lastError } : {}) };
    }) };
  }
  changed() { try { this.onChange(this.getState()); } catch {} }
  async initialize() {
    if (this.initialized) return;
    await privateDirectory(this.directory);
    const file = path.join(this.directory, 'managed-sessions.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('invalid-binding');
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed?.version !== 1 || parsed?.owner !== 'ai-watch-managed-relay' || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw new Error('invalid-binding');
      for (const [id, binding] of Object.entries(parsed.sessions)) {
        if (!AGENTS.includes(id) || !binding || !UUID.test(binding.sessionId || '') || typeof binding.createdAt !== 'string') throw new Error('invalid-binding');
        this.bindings[id] = { sessionId: binding.sessionId, createdAt: binding.createdAt };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        for (const state of this.agents.values()) state.lastError = 'session-binding-invalid';
        this.bindingInvalid = true;
      }
    }
    if (!this.bindingInvalid) {
      const providers = await this.runtime.discover();
      for (const item of providers || []) {
        if (!this.agents.has(item.id)) continue;
        const state = this.agents.get(item.id);
        state.available = item.available === true;
        if (item.lastError) state.lastError = safeError(item.lastError);
      }
    }
    this.initialized = true;
    this.changed();
  }
  bindSession(agentId, sessionId) {
    if (!AGENTS.includes(agentId) || !UUID.test(sessionId || '')) return Promise.reject(new Error('invalid-session'));
    this.bindingWrites = this.bindingWrites.then(async () => {
      const binding = this.bindings[agentId];
      if (binding && binding.sessionId !== sessionId) throw new Error('session-mismatch');
      const sessions = { ...this.bindings, [agentId]: binding || { sessionId, createdAt: new Date().toISOString() } };
      await writePrivateJson(path.join(this.directory, 'managed-sessions.json'), { version: 1, owner: 'ai-watch-managed-relay', sessions });
      this.bindings = sessions;
      this.changed();
    });
    return this.bindingWrites;
  }
  async tasks() { const tasks = await this.relay.ownerListTasks({ limit: 500 }); return Array.isArray(tasks) ? tasks : []; }
  command(actor, tool, args) {
    const source = typeof this.relay.ownerCommand === 'function' ? this.relay : this.relay.store;
    if (!source || typeof source.ownerCommand !== 'function') throw new Error('relay-unavailable');
    return source.ownerCommand(actor, tool, args);
  }
  async report(agentId, taskId, status, summary, details) {
    const result = await this.command(agentId, 'relay_report_result', { taskId, status, purpose: PURPOSE,
      summary: cleanText(summary, 2000) || 'Managed CLI did not return a result.',
      details: cleanText(details, 16000) || 'No final answer was returned by the managed CLI.' });
    if (!result?.ok) throw new Error('result-record-failed');
    return result;
  }
  async tick() {
    if (this.checking || this.stopping) return;
    this.checking = true;
    let finishTick;
    this.tickDone = new Promise(resolve => { finishTick = resolve; });
    try {
      await this.initialize();
      if (this.bindingInvalid) return;
      const tasks = await this.tasks();
      for (const [id, active] of this.active) {
        const current = tasks.find(task => task.id === active.task.id);
        if (!current || TERMINAL.has(current.status) || !this.enabled.has(id)) this.runtime.cancel?.(id);
      }
      for (const id of AGENTS) {
        if (this.stopping || !this.enabled.has(id) || this.active.has(id) || !this.agents.get(id).available) continue;
        const task = tasks.filter(item => item.to === id && item.status === 'queued')
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
        if (!task) continue;
        const claim = await this.command(id, 'relay_claim_task', { taskId: task.id, purpose: PURPOSE });
        if (!claim?.ok) { this.agents.get(id).lastError = 'task-claim-failed'; this.changed(); continue; }
        const claimed = claim.task || { ...task, status: 'running' };
        if (task.sessionId && task.sessionId !== this.bindings[id]?.sessionId) {
          this.agents.get(id).lastError = 'unmanaged-session';
          await this.report(id, task.id, 'failed', 'Rejected an unmanaged session target.', 'The requested session is not the dedicated session created and bound by AI Watch. Existing user conversations are never taken over.');
          this.changed(); continue;
        }
        const state = this.agents.get(id);
        state.busy = true; delete state.lastError;
        const active = { task: claimed, promise: null };
        this.active.set(id, active);
        active.promise = this.execute(id, claimed).finally(() => {
          if (this.active.get(id) === active) { this.active.delete(id); state.busy = false; this.changed(); }
        });
        this.changed();
      }
    } catch {
      for (const id of this.enabled) this.agents.get(id).lastError = 'dispatcher-failed';
      this.changed();
    } finally { this.checking = false; finishTick(); }
  }
  async execute(agentId, task) {
    let credentials;
    try {
      credentials = await this.relay.clientCredentials(agentId);
      const before = (await this.tasks()).find(item => item.id === task.id);
      if (!before || TERMINAL.has(before.status)) return;
      if (this.stopping || !this.enabled.has(agentId)) {
        await this.report(agentId, task.id, 'failed', `Managed ${agentId} CLI was cancelled.`, 'The managed worker was disabled or stopped before a process was started.');
        return;
      }
      let recordedSession = false;
      const recordSession = async id => {
        await this.bindSession(agentId, id);
        if (recordedSession) return;
        recordedSession = true;
        const current = (await this.tasks()).find(item => item.id === task.id);
        if (current && !TERMINAL.has(current.status)) await this.command(agentId, 'relay_message', {
          taskId: task.id, kind: 'progress', purpose: 'Retain the managed CLI session identity so the human-readable task record can be traced.',
          text: `Managed ${agentId} CLI session: ${id}. This is a dedicated AI Watch worker session; it does not identify a desktop web chat.`
        });
      };
      const result = await this.runtime.run({ agentId, task, credentials,
        sessionId: this.bindings[agentId]?.sessionId || null,
        workDirectory: path.join(this.directory, 'work', agentId),
        onSession: recordSession });
      if (result?.sessionId) await this.bindSession(agentId, result.sessionId);
      const current = (await this.tasks()).find(item => item.id === task.id);
      // A model may already have reported via MCP, or the sender cancelled.
      if (!current || TERMINAL.has(current.status)) return;
      if (result?.errorCode || this.stopping || !this.enabled.has(agentId)) {
        const errorCode = this.stopping || !this.enabled.has(agentId) ? 'runtime-cancelled' : safeError(result?.errorCode);
        this.agents.get(agentId).lastError = errorCode;
        await this.report(agentId, task.id, 'failed', `Managed ${agentId} CLI did not complete the task.`, `Execution ended with ${errorCode}. Starting the CLI is not treated as task completion.`);
      } else {
        let text = cleanText(result?.text);
        if (credentials?.token) text = text.split(credentials.token).join('[relay credential removed]');
        if (!text) {
          this.agents.get(agentId).lastError = 'empty-result';
          await this.report(agentId, task.id, 'failed', `Managed ${agentId} CLI returned no final answer.`, 'No task outcome could be verified.');
        } else {
          const session = this.bindings[agentId]?.sessionId;
          const envelope = parseResultEnvelope(text);
          const prefix = session ? `Managed CLI session: ${session}\n\n` : '';
          if (envelope) {
            await this.report(agentId, task.id, envelope.status, `Managed ${agentId} CLI: ${envelope.summary}`, `${prefix}${envelope.details}`);
          } else {
            this.agents.get(agentId).lastError = 'unverified-result';
            await this.report(agentId, task.id, 'failed', `Managed ${agentId} CLI returned an unverified outcome.`, `${prefix}The final answer did not contain the required result envelope, and no MCP result was recorded. It is retained below for human review; it is not treated as task completion.\n\n${text}`);
          }
        }
      }
    } catch {
      this.agents.get(agentId).lastError = 'dispatcher-failed';
      try {
        const current = (await this.tasks()).find(item => item.id === task.id);
        if (current && !TERMINAL.has(current.status)) await this.report(agentId, task.id, 'failed', `Managed ${agentId} CLI failed.`, 'The dispatcher could not safely obtain and retain the task result.');
      } catch {}
    }
  }
  async stop() {
    this.stopping = true;
    await this.tickDone;
    for (const id of this.active.keys()) this.runtime.cancel?.(id);
    this.runtime.stop?.();
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
    await this.bindingWrites.catch(() => {});
  }
}

module.exports = { AgentDispatcher, parseResultEnvelope };
