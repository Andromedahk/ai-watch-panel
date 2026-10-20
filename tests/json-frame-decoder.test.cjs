const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonFrameDecoder, MAX_FRAME } = require('../electron/json-frame-decoder.cjs');
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
test('incremental headers and fragmented UTF-8 payloads preserve complete JSON values', () => {
  const value = { text: '你好 · 日本語 · العربية · 🦊🎉', nested: [1, true, null] };
  const bytes = frame(value), decoder = new JsonFrameDecoder(), received = [];
  for (const byte of bytes) decoder.feed(Buffer.from([byte]), message => received.push(message));
  assert.deepEqual(received, [value]); assert.equal(decoder.pendingBytes, 0); assert.equal(decoder.payload, null);
});
test('multiple complete frames and a partial next frame are dispatched without retaining prior frames', () => {
  const decoder = new JsonFrameDecoder(), received = [], next = frame({ next: true });
  decoder.feed(Buffer.concat([frame([1, 2]), frame('hello'), next.subarray(0, 7)]), message => received.push(message));
  assert.deepEqual(received, [[1, 2], 'hello']); assert.equal(decoder.pendingBytes, 7);
  decoder.feed(next.subarray(7), message => received.push(message)); assert.deepEqual(received, [[1, 2], 'hello', { next: true }]);
});
test('random fragmentation copies each input byte once and bounds the frame allocation', () => {
  const values = Array.from({ length: 100 }, (_, i) => ({ number: i, text: '中文🌈'.repeat(i % 23) }));
  const bytes = Buffer.concat(values.map(frame)); let copied = 0, largestAllocation = 0, seed = 42;
  const decoder = new JsonFrameDecoder({ allocate: size => { largestAllocation = Math.max(largestAllocation, size); return Buffer.allocUnsafe(size); },
    copy: (source, target, targetStart, sourceStart, sourceEnd) => { copied += sourceEnd - sourceStart; return source.copy(target, targetStart, sourceStart, sourceEnd); } });
  const received = []; let offset = 0;
  while (offset < bytes.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const end = Math.min(bytes.length, offset + 1 + seed % 67);
    decoder.feed(bytes.subarray(offset, end), message => received.push(message)); offset = end;
  }
  assert.deepEqual(received, values); assert.equal(copied, bytes.length);
  assert.equal(largestAllocation, Math.max(...values.map(value => frame(value).length - 4)));
});
test('a large fragmented frame allocates one payload and performs linear copying', () => {
  const value = { text: 'x'.repeat(1024 * 1024) }, bytes = frame(value);
  let copies = 0, allocations = 0; const received = [];
  const decoder = new JsonFrameDecoder({ allocate: size => { allocations++; return Buffer.allocUnsafe(size); },
    copy: (source, target, at, from, to) => { copies += to - from; return source.copy(target, at, from, to); } });
  for (let i = 0; i < bytes.length; i += 8192) decoder.feed(bytes.subarray(i, i + 8192), message => received.push(message));
  assert.deepEqual(received, [value]); assert.equal(allocations, 1); assert.equal(copies, bytes.length);
});
test('zero and oversized lengths fail before allocation and allow a fresh valid frame', () => {
  for (const size of [0, MAX_FRAME + 1, 0xffffffff]) {
    const decoder = new JsonFrameDecoder(), header = Buffer.alloc(4); header.writeUInt32LE(size);
    assert.throws(() => decoder.feed(header, () => {}), /Invalid frame length/);
    assert.equal(decoder.pendingBytes, 0); assert.equal(decoder.payload, null);
    const received = []; decoder.feed(frame({ ok: true }), value => received.push(value)); assert.deepEqual(received, [{ ok: true }]);
  }
});
test('the size ceiling remains 16 MiB and cannot be configured above it', () => {
  assert.equal(MAX_FRAME, 16 * 1024 * 1024);
  for (const maxFrame of [0, -1, NaN, Infinity, 2.5, MAX_FRAME + 1]) assert.throws(() => new JsonFrameDecoder({ maxFrame }), RangeError);
  const decoder = new JsonFrameDecoder({ maxFrame: 8 }), header = Buffer.alloc(4); header.writeUInt32LE(9);
  assert.throws(() => decoder.feed(header, () => {}), RangeError);
});
test('malformed JSON and callback errors discard incomplete state before later feeds', () => {
  const decoder = new JsonFrameDecoder(), invalid = Buffer.from([1, 0, 0, 0, 123]);
  assert.throws(() => decoder.feed(invalid, () => {}), SyntaxError); assert.equal(decoder.pendingBytes, 0);
  assert.throws(() => decoder.feed(frame({ ok: true }), () => { throw new Error('Dispatch failed'); }), /Dispatch failed/);
  assert.equal(decoder.payload, null); const received = []; decoder.feed(frame(42), value => received.push(value)); assert.deepEqual(received, [42]);
});
test('reset drops partial payload and reset during dispatch discards the rest of the current chunk', () => {
  const decoder = new JsonFrameDecoder(), partial = frame({ old: true });
  decoder.feed(partial.subarray(0, 8), () => assert.fail('incomplete message')); decoder.reset(); assert.equal(decoder.payload, null);
  const received = []; decoder.feed(Buffer.concat([frame('first'), frame('discard')]), value => { received.push(value); decoder.reset(); });
  assert.deepEqual(received, ['first']); decoder.feed(frame('new'), value => received.push(value)); assert.deepEqual(received, ['first', 'new']);
});
test('invalid input clears partial frame state and empty chunks do not dispatch', () => {
  const decoder = new JsonFrameDecoder(); decoder.feed(frame('partial').subarray(0, 6), () => {});
  assert.throws(() => decoder.feed('invalid', () => {}), TypeError); assert.equal(decoder.pendingBytes, 0);
  decoder.feed(Buffer.alloc(0), () => assert.fail('empty chunk')); assert.equal(decoder.payload, null);
});
