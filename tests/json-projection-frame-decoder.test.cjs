const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonProjectionFrameDecoder } = require('../electron/json-projection-frame-decoder.cjs');

function rawFrame(json) {
  const body = Buffer.from(json), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
const frame = value => rawFrame(JSON.stringify(value));
function decode(value, options) {
  const received = [];
  new JsonProjectionFrameDecoder(options).feed(frame(value), item => received.push(item));
  assert.equal(received.length, 1);
  return received[0];
}

test('a 29 MB fragmented frame skips the body and retains metadata after it without allocating the frame', () => {
  const prefix = Buffer.from('{"body":"'), suffix = Buffer.from('","requests":[{"method":"item/tool/requestUserInput"}],"tag":"after"}');
  const length = 29_815_232, bodyLength = length - prefix.length - suffix.length;
  const header = Buffer.alloc(4); header.writeUInt32LE(length);
  const block = Buffer.alloc(16 * 1024, 'x'), received = [], calls = [];
  const decoder = new JsonProjectionFrameDecoder({ select: (path, type) => {
    calls.push([path, type]);
    return path[0] !== 'body';
  } });
  const allocate = Buffer.allocUnsafe;
  let largestAllocation = 0;
  Buffer.allocUnsafe = size => { largestAllocation = Math.max(largestAllocation, size); return allocate(size); };
  try {
    decoder.feed(header, item => received.push(item));
    decoder.feed(prefix, item => received.push(item));
    for (let offset = 0; offset < bodyLength; offset += block.length) {
      decoder.feed(block.subarray(0, Math.min(block.length, bodyLength - offset)), item => received.push(item));
    }
    assert.deepEqual(received, [], 'A partial frame must not publish an early projection');
    decoder.feed(suffix, item => received.push(item));
  } finally { Buffer.allocUnsafe = allocate; }
  assert.deepEqual(received, [{ requests: [{ method: 'item/tool/requestUserInput' }], tag: 'after' }]);
  assert.ok(largestAllocation <= 64 * 1024, `Unexpected retained payload allocation: ${largestAllocation}`);
  assert.equal(decoder.pendingBytes, 0);
  assert.ok(calls.some(([path, type]) => path.join('.') === 'body' && type === 'string'));
});

test('one incoming buffer larger than the old frame ceiling projects only selected fields', () => {
  const body = Buffer.alloc(17 * 1024 * 1024, 'p');
  const prefix = Buffer.from('{"ignored":"'), suffix = Buffer.from('","revision":42,"requests":[]}');
  const header = Buffer.alloc(4); header.writeUInt32LE(prefix.length + body.length + suffix.length);
  const bytes = Buffer.concat([header, prefix, body, suffix]), received = [];
  const decoder = new JsonProjectionFrameDecoder({ select: path => path[0] !== 'ignored' });
  decoder.feed(bytes, value => received.push(value));
  assert.deepEqual(received, [{ revision: 42, requests: [] }]);
  assert.equal(decoder.pendingBytes, 0);
});

test('one-byte fragmentation preserves UTF-8, escaped characters and lone JSON surrogates', () => {
  const value = { '中文🦊': '你好 · 日本語 · العربية · 🎉', escapes: 'quote" slash\\ newline\n tab\t', lone: '\ud800', pair: '\ud83e\udd8a' };
  const bytes = frame(value), received = [], decoder = new JsonProjectionFrameDecoder();
  for (const byte of bytes) decoder.feed(Buffer.from([byte]), item => received.push(item));
  assert.deepEqual(received, [value]);
  assert.equal(decoder.pendingBytes, 0);
});

test('multiple frames and partial following headers or bodies remain distinct', () => {
  const received = [], decoder = new JsonProjectionFrameDecoder(), second = frame({ second: true });
  decoder.feed(Buffer.concat([frame({ first: 1 }), second.subarray(0, 2)]), value => received.push(value));
  assert.deepEqual(received, [{ first: 1 }]);
  assert.equal(decoder.pendingBytes, 2);
  decoder.feed(second.subarray(2, 9), value => received.push(value));
  assert.deepEqual(received, [{ first: 1 }]);
  assert.equal(decoder.pendingBytes, 9);
  decoder.feed(Buffer.concat([second.subarray(9), frame(null), frame(false)]), value => received.push(value));
  assert.deepEqual(received, [{ first: 1 }, { second: true }, null, false]);
  assert.equal(decoder.pendingBytes, 0);
});

test('root primitives and numbers ending exactly at the frame boundary are finalized', () => {
  for (const json of ['0', '-0', '1.25', '-1.25e-3', '1e400', 'true', 'false', 'null', '""', '"root"', '[]', '{}']) {
    const received = [], decoder = new JsonProjectionFrameDecoder();
    decoder.feed(rawFrame(json), value => received.push(value));
    assert.deepEqual(received, [JSON.parse(json)], json);
  }
});

test('random fragmentation across many frames preserves their values and order', () => {
  const values = Array.from({ length: 75 }, (_, i) => ({
    id: i, signed: i === 0 ? 0 : -i / 7, nested: [null, i % 2 === 0, { text: '中文🌈'.repeat(i % 12) }],
  }));
  const bytes = Buffer.concat(values.map(frame)), received = [], decoder = new JsonProjectionFrameDecoder();
  let seed = 42, offset = 0;
  while (offset < bytes.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const end = Math.min(bytes.length, offset + 1 + seed % 73);
    decoder.feed(bytes.subarray(offset, end), value => received.push(value));
    offset = end;
  }
  assert.deepEqual(received, values);
  assert.equal(decoder.pendingBytes, 0);
});

test('overlong number tokens are omitted without dropping neighboring metadata', () => {
  const received = [], decoder = new JsonProjectionFrameDecoder();
  decoder.feed(rawFrame(`{"oversized":1${'0'.repeat(128)},"revision":15}`), value => received.push(value));
  assert.deepEqual(received, [{ revision: 15 }]);
});

test('selection sees typed paths, skips whole subtrees and preserves array positions', () => {
  const seen = [];
  const actual = decode({ skipped: { secret: { nested: true } }, list: [{ id: 'first' }, { text: 'PRIVATE' }, { id: 'last' }], empty: [] }, {
    select(path, type) {
      seen.push([path, type]);
      return path[0] !== 'skipped' && !(path[0] === 'list' && path[1] === 1);
    },
  });
  const expected = [{ id: 'first' }, , { id: 'last' }];
  assert.deepEqual(actual, { list: expected, empty: [] });
  assert.equal(actual.list.length, 3);
  assert.equal(Object.hasOwn(actual.list, 1), false);
  assert.ok(seen.some(([path, type]) => path.length === 0 && type === 'object'));
  assert.ok(seen.some(([path, type]) => path[0] === 'list' && path[1] === 2 && path[2] === 'id' && type === 'string'));
  assert.equal(seen.some(([path]) => path[0] === 'skipped' && path.length > 1), false);
});

test('skipped roots do not dispatch but subsequent frames still do', () => {
  let keep = false;
  const received = [], decoder = new JsonProjectionFrameDecoder({ select: () => keep });
  decoder.feed(frame({ secret: 'PRIVATE' }), value => received.push(value));
  assert.deepEqual(received, []);
  keep = true;
  decoder.feed(frame({ ok: true }), value => received.push(value));
  assert.deepEqual(received, [{ ok: true }]);
});

test('string length limits discard whole fields and numeric selection overrides the default', () => {
  const value = { defaultOk: 'a'.repeat(256), defaultLong: 'b'.repeat(257), limitedOk: '1234', limitedLong: '12345', empty: '', list: ['x'.repeat(257), 'kept'] };
  const actual = decode(value, { select(path, type) {
    if (type === 'string' && String(path[0]).startsWith('limited')) return 4;
    if (path[0] === 'empty') return 0;
    return true;
  } });
  assert.deepEqual(actual, { defaultOk: value.defaultOk, limitedOk: '1234', empty: '', list: [, 'kept'] });
  assert.equal(Object.hasOwn(actual, 'defaultLong'), false);
  assert.equal(Object.hasOwn(actual, 'limitedLong'), false);
});

test('huge keys are discarded without visiting or retaining their values', () => {
  const key = 'k'.repeat(40 * 1024), seen = [];
  const actual = decode({ [key]: { secret: 'PRIVATE' }, after: 7 }, { select: (path, type) => { seen.push([path, type]); return true; } });
  assert.deepEqual(actual, { after: 7 });
  assert.ok(seen.every(([path]) => path.every(part => typeof part !== 'string' || part.length <= 256)));
});

test('own __proto__ properties do not mutate output prototypes', () => {
  const received = [], decoder = new JsonProjectionFrameDecoder();
  decoder.feed(rawFrame('{"__proto__":{"polluted":true},"constructor":{"prototype":{"also":true}},"ok":1}'), value => received.push(value));
  assert.equal(Object.getPrototypeOf(received[0]), Object.prototype);
  assert.equal(Object.hasOwn(received[0], '__proto__'), true);
  assert.deepEqual(received[0].__proto__, { polluted: true });
  assert.equal({}.polluted, undefined);
  assert.equal({}.also, undefined);
});

test('a later duplicate key replaces the earlier value even when the replacement is dropped', () => {
  const received = [], decoder = new JsonProjectionFrameDecoder({ maxStringChars: 4 });
  decoder.feed(rawFrame('{"id":"old","id":"too-long","n":1,"n":2}'), value => received.push(value));
  assert.deepEqual(received, [{ n: 2 }]);
});

test('malformed JSON remains invalid inside a skipped subtree and cannot publish a partial projection', () => {
  for (const json of [
    '{"ok":true,"skip":{"x":}}', '{"skip":[1,]}', '{"skip":"bad\\q"}',
    '{"skip":01}', '{"skip":1e}', '{"skip":true false}', '{"skip":"unterminated}',
    '{"ok":1} {"other":2}', ' ', '{"ok":',
  ]) {
    const received = [], decoder = new JsonProjectionFrameDecoder({ select: path => path[0] !== 'skip' });
    assert.throws(() => decoder.feed(rawFrame(json), value => received.push(value)), undefined, json);
    assert.deepEqual(received, [], json);
    assert.equal(decoder.pendingBytes, 0, json);
    decoder.feed(frame({ recovered: true }), value => received.push(value));
    assert.deepEqual(received, [{ recovered: true }], json);
  }
});

test('depth and projected size/node limits reject atomically and permit later valid frames', () => {
  const cases = [
    [{ maxDepth: 3 }, { skip: { child: { tooDeep: {} } } }, () => false],
    [{ maxProjectedBytes: 128 }, { message: 'x'.repeat(200) }],
    [{ maxNodes: 4 }, { list: Array.from({ length: 10 }, (_, i) => i) }],
    [{ maxNodes: 4 }, Array.from({ length: 10 }, () => 'ignored'), path => path.length === 0],
  ];
  for (const [options, value, select] of cases) {
    const decoder = new JsonProjectionFrameDecoder({ ...options, ...(select ? { select } : {}) }), received = [];
    assert.throws(() => decoder.feed(frame(value), result => received.push(result)), RangeError);
    assert.deepEqual(received, []);
    assert.equal(decoder.pendingBytes, 0);
    decoder.feed(frame(null), result => received.push(result));
    assert.deepEqual(received, select && !select([]) ? [] : [null]);
  }
});

test('invalid frame lengths fail before body allocation and configured frame caps are enforced', () => {
  for (const length of [0, 256 * 1024 * 1024 + 1, 0xffffffff]) {
    const decoder = new JsonProjectionFrameDecoder(), header = Buffer.alloc(4), received = [];
    header.writeUInt32LE(length);
    assert.throws(() => decoder.feed(header, result => received.push(result)), RangeError);
    assert.equal(decoder.pendingBytes, 0);
    decoder.feed(frame(true), result => received.push(result));
    assert.deepEqual(received, [true]);
  }
  const decoder = new JsonProjectionFrameDecoder({ maxFrame: 8 });
  assert.throws(() => decoder.feed(frame({ larger: true }), () => {}), RangeError);
  for (const maxFrame of [0, -1, NaN, Infinity, 1.5, 256 * 1024 * 1024 + 1]) assert.throws(() => new JsonProjectionFrameDecoder({ maxFrame }), RangeError);
  for (const maxProjectedBytes of [0, -1, NaN, Infinity, 1.5, 2 * 1024 * 1024 + 1]) assert.throws(() => new JsonProjectionFrameDecoder({ maxProjectedBytes }), RangeError);
});

test('reset drops incomplete bytes and callback reset discards later frames from the same buffer', () => {
  const decoder = new JsonProjectionFrameDecoder(), received = [], partial = frame({ old: 'unfinished' });
  decoder.feed(partial.subarray(0, 10), () => assert.fail('incomplete frame'));
  assert.ok(decoder.pendingBytes > 0);
  decoder.reset();
  assert.equal(decoder.pendingBytes, 0);
  decoder.feed(Buffer.concat([frame('first'), frame('discard')]), result => { received.push(result); decoder.reset(); });
  assert.deepEqual(received, ['first']);
  decoder.feed(frame('new'), result => received.push(result));
  assert.deepEqual(received, ['first', 'new']);
});

test('callback and selector errors reset parser state without consuming later frames', () => {
  const decoder = new JsonProjectionFrameDecoder(), received = [];
  assert.throws(() => decoder.feed(Buffer.concat([frame(1), frame(2)]), () => { throw new Error('callback failed'); }), /callback failed/);
  assert.equal(decoder.pendingBytes, 0);
  decoder.feed(frame(3), value => received.push(value));
  assert.deepEqual(received, [3]);
  const selection = new JsonProjectionFrameDecoder({ select(path) { if (path[0] === 'bad') throw new Error('selection failed'); return true; } });
  assert.throws(() => selection.feed(frame({ bad: 1 }), () => {}), /selection failed/);
  assert.equal(selection.pendingBytes, 0);
  selection.feed(frame({ ok: 1 }), value => received.push(value));
  assert.deepEqual(received, [3, { ok: 1 }]);
});

test('invalid input resets an incomplete frame and empty buffers do not dispatch', () => {
  const decoder = new JsonProjectionFrameDecoder();
  decoder.feed(frame('partial').subarray(0, 6), () => {});
  assert.throws(() => decoder.feed('invalid', () => {}), TypeError);
  assert.equal(decoder.pendingBytes, 0);
  decoder.feed(Buffer.alloc(0), () => assert.fail('empty input'));
});
