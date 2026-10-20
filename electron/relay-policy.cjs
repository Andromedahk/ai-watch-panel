// Public IPC projections. Credentials, executable locations and worker internals
// stay in the main process even when an adapter adds fields later.
const RELAY_AGENTS = Object.freeze(['claude', 'codex']);
const path = require('node:path');
const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const isRelayAgent = value => typeof value === 'string' && RELAY_AGENTS.includes(value);
const isRelayAgents = value => Array.isArray(value) && value.length <= RELAY_AGENTS.length
  && new Set(value).size === value.length && value.every(isRelayAgent);
const isRelayTaskId = value => typeof value === 'string' && TASK_ID.test(value);
function relayEnvironmentAllowed(environment) {
  const keys = ['AI_WATCH_TEST_PROFILE', 'AI_WATCH_TEST_STATUS', 'AI_WATCH_TEST_RELAY'];
  if (!keys.some(key => environment[key] !== undefined)) return true;
  return typeof environment.AI_WATCH_TEST_PROFILE === 'string' && path.isAbsolute(environment.AI_WATCH_TEST_PROFILE)
    && ['fixture', 'glow-running', 'glow-attention'].includes(environment.AI_WATCH_TEST_STATUS)
    && environment.AI_WATCH_TEST_RELAY === '1';
}
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : null;
const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
function publicRelayState(server = {}, dispatcher = {}, enabled = false) {
  return {
    enabled: enabled === true,
    running: server.running === true,
    endpoint: typeof server.endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(server.endpoint) ? server.endpoint : null,
    agentCount: Number.isInteger(server.agentCount) && server.agentCount >= 0 ? Math.min(server.agentCount, 100) : 0,
    queuedTasks: Number.isInteger(server.queuedTasks) && server.queuedTasks >= 0 ? Math.min(server.queuedTasks, 500) : 0,
    lastEventAt: timestamp(server.lastEventAt),
    ...(server.error ? { error: safeCode(server.error) || 'relay-unavailable' } : {}),
    agents: RELAY_AGENTS.map(id => {
      const agent = Array.isArray(dispatcher.agents) ? dispatcher.agents.find(item => item?.id === id) : null;
      return { id, available: agent?.available === true, enabled: agent?.enabled === true, busy: agent?.busy === true,
        ...(typeof agent?.sessionId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(agent.sessionId) ? { sessionId: agent.sessionId } : {}),
        ...(agent?.lastError ? { lastError: safeCode(agent.lastError) || 'worker-unavailable' } : {}) };
    }),
  };
}
function publicRelayTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 50).filter(task => task && isRelayTaskId(task.id) && isRelayAgent(task.from) && isRelayAgent(task.to)).map(task => ({
    id: task.id, from: task.from, to: task.to,
    subject: typeof task.subject === 'string' ? task.subject.slice(0, 160) : '',
    status: ['queued', 'running', 'completed', 'failed', 'cancelled', 'expired'].includes(task.status) ? task.status : 'failed',
    updatedAt: timestamp(task.updatedAt),
  }));
}
module.exports = { RELAY_AGENTS, isRelayAgent, isRelayAgents, isRelayTaskId, relayEnvironmentAllowed, publicRelayState, publicRelayTasks };
