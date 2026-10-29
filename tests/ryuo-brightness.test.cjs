const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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

function fixture({ preview = false, messages = [], code = 0 } = {}) {
  const calls = [];
  const stream = new ScreenStream({ app: { isPackaged: false }, preview,
    getConfig: () => ({ device: 'ryuo4' }), spawnProcess: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.emit('close', null); };
      queueMicrotask(() => {
        for (const message of messages) {
          // Exercise split UTF-8/JSON across stdout data events.
          const data = Buffer.from(JSON.stringify(message) + '\n');
          for (let offset = 0; offset < data.length; offset += 3) child.stdout.write(data.subarray(offset, offset + 3));
        }
        child.emit('close', code);
      });
      return child;
    } });
  return { stream, calls };
}

test('preview validates brightness without spawning any device process', async () => {
  const { stream, calls } = fixture({ preview: true });
  assert.equal(await stream.setRyuoBrightness(60), 60);
  assert.equal(calls.length, 0);
  assert.throws(() => stream.setRyuoBrightness('60'), /1–100/);
});

test('brightness uses a fixed RYUO command and never restarts a running stream', async () => {
  const { stream, calls } = fixture({ messages: [{ type: 'brightness', data: { brightness: 60, applied: true } }] });
  const runningChild = {}, runningWindow = {};
  stream.child = runningChild; stream.window = runningWindow; stream.status = 'running'; stream.generation = 7;
  assert.equal(await stream.setRyuoBrightness(60), 60);
  assert.deepEqual(calls[0][1].slice(-4), ['--device', 'ryuo4', '--brightness', '60']);
  assert.equal(calls[0][2].windowsHide, true);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(stream.child, runningChild); assert.equal(stream.window, runningWindow);
  assert.equal(stream.status, 'running'); assert.equal(stream.generation, 7);
});

test('only a successful verified acknowledgement is saved, and device failures permit retry', async () => {
  for (const options of [
    { messages: [] },
    { messages: [{ type: 'brightness', data: { brightness: 50, applied: true } }] },
    { messages: [{ type: 'brightness', data: { brightness: 60, applied: false } }] },
    { messages: [{ type: 'brightness', data: { brightness: 60, applied: true } }], code: 1 },
    { messages: [{ type: 'error', data: 'HID 被占用' }], code: 1 },
  ]) {
    const { stream } = fixture(options);
    await assert.rejects(stream.setRyuoBrightness(60), /未确认|HID 被占用/);
    await assert.rejects(stream.setRyuoBrightness(60), /未确认|HID 被占用/);
    assert.equal(stream.status, 'stopped', 'brightness errors must not fail the stream lifecycle');
  }
});
