const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { RyuoBrightness } = require('../electron/ryuo-brightness.cjs');
const { ScreenStream } = require('../electron/screen-stream.cjs');
const { validateRyuoBrightness } = require('../electron/screen-stream-policy.cjs');
const { validPreferences } = require('../electron/window-policy.cjs');

test('brightness is a bounded integer percentage, stored separately from stream parameters', () => {
  for (const value of [1, 60, 100]) {
    assert.equal(validateRyuoBrightness(value), value);
    assert.equal(validPreferences({ ryuoBrightness: value }).ryuoBrightness, value);
  }
  for (const value of [0, 101, -1, 1.5, NaN, Infinity, '60', null, true, {}, []]) {
    assert.throws(() => validateRyuoBrightness(value), /1–100/);
    assert.equal(validPreferences({ ryuoBrightness: value }).ryuoBrightness, null);
  }
  assert.equal(validPreferences({}).ryuoBrightness, null, 'an unset preference must not imply a hardware reading');
});

function fakeChild({ closeOnEof = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.writes = []; child.kills = 0;
  child.stdin.on('data', chunk => child.writes.push(chunk.toString()));
  child.stdin.on('finish', () => { if (closeOnEof) child.emit('close', 0); });
  child.kill = () => { child.kills++; child.emit('close', null); return true; };
  return child;
}

function send(child, message) {
  // Exercise split UTF-8 and JSON across the stdout transport.
  const data = Buffer.from(JSON.stringify(message) + '\n');
  for (let offset = 0; offset < data.length; offset += 3) child.stdout.write(data.subarray(offset, offset + 3));
}
function ack(child, brightness) { send(child, { type: 'brightness', data: { brightness, applied: true, holding: true } }); }
function heartbeat(child, brightness) { send(child, { type: 'brightness-heartbeat', data: { brightness } }); }

function fixture({ preview = false, closeOnEof = true, screen = false } = {}) {
  const calls = [], children = [], changes = [];
  const spawnProcess = (...args) => {
    calls.push(args); const child = fakeChild({ closeOnEof }); children.push(child); return child;
  };
  const command = () => ({ executable: 'fixture-bridge', args: ['fixture.py'], cwd: 'fixture-root' });
  const controller = new RyuoBrightness({ command, spawnProcess, preview,
    onChange: () => changes.push(controller.state()) });
  if (!screen) return { controller, calls, children, changes };
  const stream = new ScreenStream({ app: { isPackaged: false }, preview, spawnProcess,
    getConfig: () => ({ device: 'ryuo4' }), getState: () => ({}), getStatus: () => ({}) });
  return { stream, calls, children };
}

test('preview validates brightness without spawning any device process', async () => {
  const { stream, calls } = fixture({ preview: true, screen: true });
  assert.equal(await stream.setRyuoBrightness(60), 60);
  assert.equal(stream.state().ryuoBrightnessStatus, 'holding');
  assert.equal(calls.length, 0);
  assert.throws(() => stream.setRyuoBrightness('60'), /1–100/);
  await stream.stopRyuoBrightness();
  assert.equal(stream.state().ryuoBrightnessStatus, 'inactive');
});

test('invalid percentages never create a persistent brightness worker', () => {
  const { controller, calls } = fixture();
  for (const value of [0, 101, true, '60', {}, 1.5]) assert.throws(() => controller.apply(value), /1–100/);
  assert.equal(calls.length, 0);
  assert.equal(controller.state().ryuoBrightnessStatus, 'inactive');
});

test('persistent brightness uses fixed arguments without replacing the video process or window', async () => {
  const { stream, calls, children } = fixture({ screen: true });
  const runningChild = {}, runningWindow = {};
  stream.child = runningChild; stream.window = runningWindow; stream.status = 'running'; stream.generation = 7;
  try {
    const applied = stream.setRyuoBrightness(60);
    await Promise.resolve();
    ack(children[0], 60);
    assert.equal(await applied, 60);
    assert.deepEqual(calls[0][1].slice(-5), ['--device', 'ryuo4', '--brightness', '60', '--hold']);
    assert.equal(calls[0][2].windowsHide, true);
    assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(children[0].stdin.writableEnded, false, 'stdin must stay open after the first acknowledgement');
    assert.equal(stream.child, runningChild); assert.equal(stream.window, runningWindow);
    assert.equal(stream.status, 'running'); assert.equal(stream.generation, 7);
    assert.equal(stream.state().ryuoBrightnessStatus, 'holding');
  } finally { await stream.stopRyuoBrightness(); }
});

test('periodic heartbeat acknowledgements keep brightness active beyond the five-second device timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, children } = fixture();
  try {
    const applied = controller.apply(60); ack(children[0], 60); await applied;
    for (let seconds = 2; seconds <= 22; seconds += 2) {
      t.mock.timers.tick(2000); heartbeat(children[0], 60);
      assert.equal(controller.state().ryuoBrightnessStatus, 'holding', `heartbeat at ${seconds}s`);
    }
    assert.equal(children[0].kills, 0);
  } finally { await controller.stop(); }
});

test('new brightness is sent to the same worker, and old acknowledgements cannot complete the update', async () => {
  const { controller, calls, children } = fixture();
  try {
    const initial = controller.apply(60); ack(children[0], 60); await initial;
    let completed = false;
    const update = controller.apply(80).then(value => { completed = true; return value; });
    assert.equal(calls.length, 1);
    assert.deepEqual(children[0].writes.map(value => JSON.parse(value)), [{ brightness: 80 }]);
    heartbeat(children[0], 60); ack(children[0], 60);
    send(children[0], { type: 'brightness', data: { brightness: 80, applied: true, holding: false } });
    await Promise.resolve();
    assert.equal(completed, false, 'neither an old value nor a one-shot acknowledgement proves the new hold');
    assert.equal(controller.state().ryuoBrightnessStatus, 'starting');
    ack(children[0], 80);
    assert.equal(await update, 80);
    assert.equal(controller.value, 80);
    assert.equal(await controller.apply(80), 80, 'already holding the saved value is a no-op');
    assert.equal(calls.length, 1); assert.equal(children[0].writes.length, 1);
  } finally { await controller.stop(); }
});

test('missing heartbeats report a brightness error and terminate only the brightness worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { stream, children } = fixture({ screen: true });
  const videoChild = {}, outputWindow = {};
  stream.child = videoChild; stream.window = outputWindow; stream.status = 'running'; stream.generation = 3;
  const applied = stream.setRyuoBrightness(60); await Promise.resolve(); ack(children[0], 60); await applied;
  t.mock.timers.tick(6999);
  assert.equal(stream.state().ryuoBrightnessStatus, 'holding');
  t.mock.timers.tick(1);
  assert.equal(stream.state().ryuoBrightnessStatus, 'error');
  assert.match(stream.state().ryuoBrightnessError, /保活已中断/);
  assert.equal(children[0].kills, 1);
  assert.equal(stream.child, videoChild); assert.equal(stream.window, outputWindow);
  assert.equal(stream.status, 'running'); assert.equal(stream.generation, 3);
  await stream.stopRyuoBrightness();
});

test('a worker exiting with code zero after initial success still stops the brightness hold', async () => {
  const { controller, children } = fixture();
  const applied = controller.apply(60); ack(children[0], 60); await applied;
  children[0].emit('close', 0);
  assert.equal(controller.state().ryuoBrightnessStatus, 'error');
  assert.match(controller.state().ryuoBrightnessError, /保活已退出/);
  assert.equal(controller.session, null);
  await controller.stop();
});

test('device errors reject an outstanding update and permit a new worker on retry', async () => {
  const { controller, calls, children } = fixture();
  try {
    const initial = controller.apply(60); ack(children[0], 60); await initial;
    const update = controller.apply(80);
    const rejected = assert.rejects(update, /HID 已断开/);
    send(children[0], { type: 'error', data: 'HID 已断开' });
    await rejected;
    assert.equal(controller.state().ryuoBrightnessStatus, 'error');
    const retry = controller.apply(80); ack(children[1], 80);
    assert.equal(await retry, 80); assert.equal(calls.length, 2);
    assert.equal(controller.state().ryuoBrightnessStatus, 'holding');
  } finally { await controller.stop(); }
});

test('worker launch failure and stdin pipe errors reject without leaving holding state', async () => {
  const launch = new RyuoBrightness({ command: () => ({ args: [] }), spawnProcess: () => { throw new Error('spawn failed'); } });
  await assert.rejects(launch.apply(60), /spawn failed/);
  assert.equal(launch.state().ryuoBrightnessStatus, 'error');
  const { controller, children } = fixture();
  const pending = controller.apply(60);
  const rejected = assert.rejects(pending, /管道已断开/);
  children[0].stdin.emit('error', new Error('EPIPE'));
  await rejected;
  assert.equal(controller.state().ryuoBrightnessStatus, 'error'); assert.equal(children[0].kills, 1);
  await controller.stop();
});

test('an acknowledgement timeout kills the initial worker and rejects the pending setting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, children } = fixture();
  const rejected = assert.rejects(controller.apply(60), /调节超时/);
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(children[0].kills, 1); assert.equal(controller.state().ryuoBrightnessStatus, 'error');
  await controller.stop();
});

test('stopping sends EOF, cancels an unacknowledged setting and removes all heartbeat timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, children } = fixture();
  const rejected = assert.rejects(controller.apply(60), /保活已停止/);
  await controller.stop(); await rejected;
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(children[0].kills, 0);
  t.mock.timers.tick(60000);
  assert.deepEqual(controller.state(), { ryuoBrightnessStatus: 'inactive', ryuoBrightnessError: null });
  assert.equal(children[0].kills, 0, 'cancelled acknowledgement timer must not kill an already stopped child');
});

test('shutdown kills only its owned worker if EOF is ignored, without waiting indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, children } = fixture({ closeOnEof: false });
  const applied = controller.apply(60); ack(children[0], 60); await applied;
  const stopped = controller.stop();
  assert.equal(children[0].stdin.writableEnded, true);
  t.mock.timers.tick(2499); assert.equal(children[0].kills, 0);
  t.mock.timers.tick(1); await stopped;
  assert.equal(children[0].kills, 1); assert.equal(controller.state().ryuoBrightnessStatus, 'inactive');
});

test('late stdout and close events from a failed worker cannot alter a replacement hold', async () => {
  const { controller, children } = fixture();
  try {
    const first = controller.apply(60); ack(children[0], 60); await first;
    send(children[0], { type: 'error', data: 'HID disconnected' });
    const next = controller.apply(80); ack(children[1], 80); await next;
    ack(children[0], 60); heartbeat(children[0], 60);
    send(children[0], { type: 'error', data: 'old error' }); children[0].emit('close', 0);
    assert.deepEqual(controller.state(), { ryuoBrightnessStatus: 'holding', ryuoBrightnessError: null });
    assert.equal(controller.value, 80); assert.equal(children[1].kills, 0);
  } finally { await controller.stop(); }
});

test('malformed or one-shot acknowledgements never complete a persistent brightness request', async () => {
  for (const message of [
    { type: 'brightness', data: { brightness: 50, applied: true, holding: true } },
    { type: 'brightness', data: { brightness: 60, applied: false, holding: true } },
    { type: 'brightness', data: { brightness: 60, applied: true } },
    { type: 'brightness-heartbeat', data: { brightness: 60 } },
  ]) {
    const { controller, children } = fixture();
    let completed = false;
    const pending = controller.apply(60).then(value => { completed = true; return value; });
    const rejected = assert.rejects(pending, /保活已退出/);
    send(children[0], message); await Promise.resolve();
    assert.equal(completed, false);
    children[0].emit('close', 0); await rejected;
    assert.equal(controller.state().ryuoBrightnessStatus, 'error');
    await controller.stop();
  }
});

test('oversized worker output is bounded and cannot leave a hold reported as active', async () => {
  const { controller, children } = fixture();
  const rejected = assert.rejects(controller.apply(60), /异常数据/);
  children[0].stdout.write('x'.repeat(8193)); await rejected;
  assert.equal(controller.state().ryuoBrightnessStatus, 'error'); assert.equal(children[0].kills, 1);
  await controller.stop();
});

test('a public screen stop cancels an in-flight brightness request before waiting on the stream queue', async () => {
  const { stream, children } = fixture({ screen: true });
  const rejected = assert.rejects(stream.setRyuoBrightness(60), /保活已停止/);
  await Promise.resolve();
  await stream.stop(); await rejected;
  assert.equal(children[0].stdin.writableEnded, true);
  assert.equal(stream.state().ryuoBrightnessStatus, 'inactive'); assert.equal(stream.status, 'stopped');
});

test('internal video cleanup preserves the independent brightness worker for a stream restart', async () => {
  const { stream, calls, children } = fixture({ screen: true });
  try {
    const applied = stream.setRyuoBrightness(60); await Promise.resolve(); ack(children[0], 60); await applied;
    const session = stream.brightness.session;
    await stream.stopInternal();
    assert.equal(stream.brightness.session, session);
    assert.equal(stream.state().ryuoBrightnessStatus, 'holding');
    assert.equal(children[0].stdin.writableEnded, false); assert.equal(calls.length, 1);
  } finally { await stream.stopRyuoBrightness(); }
});

test('public stop invalidates a queued brightness change before it can restart the worker', async () => {
  const { stream, calls } = fixture({ screen: true });
  const rejected = assert.rejects(stream.setRyuoBrightness(60), /保活已停止/);
  // No microtask yield: this setting is still behind ScreenStream.serialize.
  await stream.stop(); await rejected;
  assert.equal(calls.length, 0);
  assert.equal(stream.state().ryuoBrightnessStatus, 'inactive');
});

test('repeated stop calls share the same cleanup promise until the owned worker closes', async () => {
  const { controller, children } = fixture({ closeOnEof: false });
  const applied = controller.apply(60); ack(children[0], 60); await applied;
  const first = controller.stop(), second = controller.stop();
  assert.equal(first, second, 'a second stop must wait for the existing worker cleanup');
  let firstDone = false, secondDone = false;
  first.then(() => { firstDone = true; }); second.then(() => { secondDone = true; });
  await Promise.resolve();
  assert.equal(firstDone, false); assert.equal(secondDone, false);
  children[0].emit('close', 0);
  await Promise.all([first, second]);
  assert.equal(firstDone, true); assert.equal(secondDone, true);
  assert.equal(children[0].kills, 0);
  assert.equal(controller.stopping, null);
});

test('applying after stop waits for the old worker to close before launching the replacement', async () => {
  const { controller, calls, children } = fixture({ closeOnEof: false });
  try {
    const initial = controller.apply(60); ack(children[0], 60); await initial;
    const stopped = controller.stop();
    const replacement = controller.apply(80);
    await Promise.resolve();
    assert.equal(calls.length, 1, 'old and new heartbeat workers must not overlap');
    assert.equal(children[0].stdin.writableEnded, true);
    children[0].emit('close', 0); await stopped;
    assert.equal(calls.length, 2);
    ack(children[1], 80);
    assert.equal(await replacement, 80);
    assert.deepEqual(controller.state(), { ryuoBrightnessStatus: 'holding', ryuoBrightnessError: null });
    assert.equal(controller.value, 80); assert.equal(children[1].kills, 0);
  } finally {
    const stopped = controller.stop();
    children.forEach(child => child.emit('close', 0));
    await stopped;
  }
});
