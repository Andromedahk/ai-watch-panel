// Source-mode Electron -> Python -> HEVC QA. Strictly isolated and no USB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const profile = process.env.AI_WATCH_TEST_PROFILE;
const python = process.env.XANALI_PYTHON;
const resources = process.env.AI_WATCH_RYUO_QA_RESOURCES;
assert.ok(profile && path.isAbsolute(profile));
assert.match(path.basename(profile), /^ai-watch-ryuo-encoder-/);
assert.equal(process.env.AI_WATCH_TEST_STATUS, 'glow-running', 'Only synthetic activity may be read');
assert.notEqual(process.env.AI_WATCH_STREAM_PREVIEW, '1', 'Real BGRA and encoder are required');
assert.ok(['win32', 'darwin'].includes(process.platform), 'Electron streaming QA requires a prepared native host');
assert.ok(python && path.isAbsolute(python) && fs.statSync(python).isFile());
assert.equal(resources, path.join(profile, 'resources'), 'Resources must belong to this temporary test profile');
assert.ok(fs.statSync(path.join(resources, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')).isFile());
assert.equal(fs.existsSync(path.join(resources, 'adb')), false, 'No ADB runtime is provided to this test');
const expectedSource = path.resolve(__dirname, '../../screen-bridge/app/panel_stream_bridge.py');
const originalSpawn = childProcess.spawn;
global.aiWatchRyuoEncoderQA = { calls: [] };
childProcess.spawn = function (command, args = [], options) {
  assert.ok(!/^adb(?:\.exe)?$/i.test(path.basename(String(command))), 'ADB must never execute in encoder QA');
  if (!args.some(argument => String(argument).endsWith('panel_stream_bridge.py'))) return originalSpawn.call(this, command, args, options);
  assert.equal(String(command), python, 'Only the explicit source Python runtime may run');
  assert.equal(args[1], expectedSource);
  assert.equal(args[args.indexOf('--device') + 1], 'ryuo4');
  assert.equal(args[args.indexOf('--width') + 1], '2240');
  assert.equal(args[args.indexOf('--height') + 1], '1080');
  assert.equal(args[args.indexOf('--fps') + 1], '30');
  assert.equal(args[args.indexOf('--bitrate-mbps') + 1], '6');
  assert.ok(!args.some(argument => ['--probe', '--check', '--resources'].includes(argument)));
  const safeArgs = [...args.filter(argument => argument !== '--dry-run'), '--dry-run', '--resources', resources];
  const report = { dryRun: true, args: safeArgs, events: [], stderr: '', exit: null, closed: false };
  global.aiWatchRyuoEncoderQA.calls.push(report);
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

// Only the fixture bypasses resource discovery: production discovery deliberately
// requires ADB, while this test supplies encoder-only temporary resources.
const streaming = require('../../electron/screen-stream.cjs');
const available = { available: true, unavailableReason: null };
streaming.streamAvailability = () => available;
streaming.streamDeviceAvailability = () => ({ zhanyu: available, ryuo4: available });
streaming.ScreenStream.prototype.availability = () => available;
const originalState = streaming.ScreenStream.prototype.state;
streaming.ScreenStream.prototype.state = function () {
  return { ...originalState.call(this), deviceAvailability: { zhanyu: available, ryuo4: available } };
};
require('../../electron/main.cjs');
