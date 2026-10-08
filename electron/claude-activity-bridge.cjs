// The packaged main process owns consent. A child helper's execution or trust
// failure must never turn an already granted main-process permission into a
// repeated authorization request.
const { readDesktopActivity, ACTIVITY_PROBE_ERRORS } = require('./claude-desktop.cjs');
const BRIDGE_PROBE_ERRORS = Object.freeze(['permission-check-failed', 'helper-access-denied']);
const PLAN_NAMES = new Set(['Free', 'Pro', 'Max', 'Max 5×', 'Max 20×', 'Team', 'Enterprise']);
const PROBE_ERRORS = new Set([...ACTIVITY_PROBE_ERRORS, ...BRIDGE_PROBE_ERRORS]);

function unknown(trusted, probeError, supported = true) {
  return { trusted, supported, activity: 'unknown', plan: null, complete: false,
    ...(probeError ? { probeError } : {}) };
}
function executionError(error) {
  if (error?.code === 'ENOENT') return 'helper-missing';
  if (['EACCES', 'EPERM', 'ENOEXEC'].includes(error?.code)) return 'helper-blocked';
  if (['ETIMEDOUT', 'ERR_CHILD_PROCESS_TIMEOUT'].includes(error?.code)
    || (error?.killed === true && error?.signal === 'SIGTERM')) return 'timeout';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'invalid-output';
  return 'helper-failed';
}

function createClaudeActivityBridge({ permissionReader, readActivity = readDesktopActivity, platform = process.platform } = {}) {
  if (typeof permissionReader !== 'function' || typeof readActivity !== 'function') throw new TypeError('Invalid Claude activity bridge');
  return async function desktopActivityReader(pid, options = {}) {
    const targetPlatform = options.platform || platform;
    if (platform !== 'darwin' || targetPlatform !== 'darwin') return unknown(null, 'unsupported-platform', false);
    const requestAccess = options.requestAccess === true;
    let trusted;
    try {
      trusted = await permissionReader(requestAccess);
      if (typeof trusted !== 'boolean') return unknown(null, 'permission-check-failed');
    } catch { return unknown(null, 'permission-check-failed'); }
    if (!trusted) return unknown(false);
    // Prompting is exclusively a main-process action. A fresh poll will probe
    // Claude after consent, without ever prompting from the spawned executable.
    if (requestAccess) return unknown(true);
    if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) return unknown(true, 'invalid-pid');
    let result;
    try {
      result = await readActivity(pid, { platform: targetPlatform, requestAccess: false });
    } catch (error) { return unknown(true, executionError(error)); }
    if (result?.trusted === false) return unknown(true, 'helper-access-denied');
    if (result?.probeError) return unknown(true, PROBE_ERRORS.has(result.probeError) ? result.probeError : 'invalid-output');
    if (!result || Array.isArray(result) || result.trusted !== true || result.supported !== true
      || typeof result.complete !== 'boolean' || !['running', 'idle', 'unknown'].includes(result.activity)
      || (result.plan !== null && !PLAN_NAMES.has(result.plan))) return unknown(true, 'invalid-output');
    return { trusted: true, supported: true, activity: result.activity, plan: result.plan, complete: result.complete };
  };
}
module.exports = { createClaudeActivityBridge, BRIDGE_PROBE_ERRORS };
