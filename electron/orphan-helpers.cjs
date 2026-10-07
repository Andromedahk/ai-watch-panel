const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const execute = promisify(execFile);

const HELPER_SUFFIX = '/AI Watch.app/Contents/Frameworks/AI Watch Helper (Renderer).app/Contents/MacOS/AI Watch Helper (Renderer)';
const IDENTIFIER = 'app.aiwatch.panel';
async function command(binary, args) {
  try { return (await execute(binary, args, { timeout: 2000, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout; }
  catch (error) {
    // ps exits with 1 and no output when the selected process no longer exists.
    if (binary === 'ps' && error.code === 1 && !error.stdout && !error.stderr) return '';
    throw error;
  }
}
function output(result) { return typeof result === 'string' ? result : result?.stdout || ''; }
function processRows(result) {
  return output(result).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]), ppid = Number(match[2]), executable = match[3].trim();
    return Number.isSafeInteger(pid) && pid > 1 && Number.isSafeInteger(ppid) ? [{ pid, ppid, executable }] : [];
  });
}
function bundleFor(executable) {
  if (!path.posix.isAbsolute(executable) || !executable.endsWith(HELPER_SUFFIX)) return null;
  // Exclude path traversal and noncanonical spellings before checking the bundle.
  if (path.posix.normalize(executable) !== executable) return null;
  return executable.slice(0, -HELPER_SUFFIX.length) + '/AI Watch.app';
}

/** Recover only this product's parentless macOS renderer helpers, never live trees. */
async function cleanupOrphanedHelpers({ platform = process.platform, packaged = false,
  runCommand = command, kill = process.kill.bind(process), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  selfPid = process.pid, graceMs = 1000, maxCandidates = 16 } = {}) {
  const result = { checked: 0, stopped: 0, signalsSent: 0, skipped: 0, remaining: [], errors: 0 };
  if (platform !== 'darwin' || packaged !== true) return result;
  const verifiedBundles = new Map();
  const validBundle = async bundle => {
    if (!verifiedBundles.has(bundle)) {
      try {
        const id = output(await runCommand('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])).trim();
        verifiedBundles.set(bundle, id === IDENTIFIER);
      } catch { verifiedBundles.set(bundle, false); }
    }
    return verifiedBundles.get(bundle);
  };
  const probe = async candidate => {
    const rows = processRows(await runCommand('ps', ['-p', String(candidate.pid), '-o', 'pid=,ppid=,comm=']));
    const row = rows.find(value => value.pid === candidate.pid);
    if (!row) return 'missing';
    return row.ppid === 1 && row.executable === candidate.executable ? 'same' : 'changed';
  };
  let rows;
  try { rows = processRows(await runCommand('ps', ['-ax', '-o', 'pid=,ppid=,comm='])); }
  catch { result.errors++; return result; }
  const limit = Number.isInteger(maxCandidates) ? Math.max(0, Math.min(maxCandidates, 32)) : 16;
  const candidates = rows.filter(row => row.pid !== selfPid && row.ppid === 1 && bundleFor(row.executable)).slice(0, limit);
  for (const candidate of candidates) {
    result.checked++;
    if (!await validBundle(bundleFor(candidate.executable))) { result.skipped++; continue; }
    try {
      // Re-read immediately before each signal; the PID or parent may have changed.
      if (await probe(candidate) !== 'same') { result.skipped++; continue; }
      try { kill(candidate.pid, 'SIGTERM'); result.signalsSent++; }
      catch (error) { if (error.code === 'ESRCH') { result.stopped++; continue; } throw error; }
      await wait(Math.max(0, Math.min(Number.isFinite(graceMs) ? graceMs : 1000, 2000)));
      const afterTerm = await probe(candidate);
      if (afterTerm === 'missing') { result.stopped++; continue; }
      if (afterTerm === 'changed') { result.skipped++; continue; }
      // An abnormal helper can keep several runnable threads after SIGTERM.
      // A second fresh identity check is required before escalation.
      if (await probe(candidate) !== 'same') { result.skipped++; continue; }
      try { kill(candidate.pid, 'SIGKILL'); result.signalsSent++; }
      catch (error) { if (error.code === 'ESRCH') { result.stopped++; continue; } throw error; }
      await wait(100);
      const afterKill = await probe(candidate);
      if (afterKill === 'missing') result.stopped++;
      else if (afterKill === 'same') result.remaining.push(candidate.pid);
      else result.skipped++;
    } catch { result.errors++; result.remaining.push(candidate.pid); }
  }
  return result;
}
module.exports = { cleanupOrphanedHelpers };
