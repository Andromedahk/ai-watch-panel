// Test-only entry point: exercise the real encoder bridge while preventing USB
// deployment. It must never be used with a real profile or without fixture data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

assert.ok(process.env.AI_WATCH_TEST_PROFILE, 'An isolated test profile is required');
assert.match(path.basename(process.env.AI_WATCH_TEST_PROFILE), /^ai-watch-screen-encoder-/);
assert.ok(['fixture', 'glow-running', 'glow-attention'].includes(process.env.AI_WATCH_TEST_STATUS), 'Synthetic status is required');
assert.notEqual(process.env.AI_WATCH_STREAM_PREVIEW, '1', 'This test must use the real encoder path');
assert.ok(!process.env.XANALI_PYTHON, 'Only the packaged helper is allowed');
const expectedBridge = path.resolve(__dirname, '../../.local/screen-bridge/XANALI-Panel-Bridge/XANALI-Panel-Bridge.exe');
assert.ok(fs.statSync(expectedBridge).isFile(), 'Build the local display bridge before encoder QA');
const originalSpawn = childProcess.spawn;
global.aiWatchEncoderQA = { calls: [] };
childProcess.spawn = function (command, args = [], options) {
  const basename = path.basename(String(command)).toLowerCase();
  if (basename !== 'xanali-panel-bridge.exe') {
    assert.ok(!args.some(argument => String(argument).includes('panel_stream_bridge.py')), 'Python bridge fallback is forbidden in this test');
    return originalSpawn.call(this, command, args, options);
  }
  assert.equal(path.resolve(String(command)).toLowerCase(), expectedBridge.toLowerCase(), 'Only the verified local helper may run');
  const safeArgs = [...args.filter(argument => argument !== '--dry-run'), '--dry-run'];
  const report = { basename, dryRun: true, args: safeArgs, events: [], stderr: '', exit: null, closed: false };
  global.aiWatchEncoderQA.calls.push(report);
  const child = originalSpawn.call(this, command, safeArgs, options);
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (line.trim()) {
        try { report.events.push(JSON.parse(line)); }
        catch { report.events.push({ type: 'invalid-json', data: line.slice(0, 200) }); }
      }
    }
  });
  child.stderr.on('data', chunk => { report.stderr = (report.stderr + chunk.toString('utf8')).slice(-8192); });
  child.on('error', error => { report.spawnError = error.message; });
  child.on('exit', (code, signal) => { report.exit = { code, signal }; });
  child.on('close', () => { report.closed = true; });
  return child;
};
require('../../electron/main.cjs');
