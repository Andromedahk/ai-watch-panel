const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

async function boundedFile(file, root, maxBytes = 8 * 1024 * 1024) {
  const [real, base] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
  if (!real.startsWith(base + path.sep)) throw new Error('Outside data directory');
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Record size unsupported');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > stat.size) throw new Error('Record changed during read');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
async function directories(root, limit = 256) {
  try {
    const entries = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory());
    if (entries.length > limit) throw new Error('Too many session directories');
    return entries.map(d => path.join(root, d.name));
  }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Parse frame boundaries from the Zstandard format; do not search compressed payloads for magic bytes.
function zstdFrames(input) {
  const frames = []; let cursor = 0;
  while (cursor < input.length) {
    const start = cursor;
    if (cursor + 5 > input.length || input.readUInt32LE(cursor) !== 0xfd2fb528) throw new Error('Incomplete or unsupported frame');
    const flags = input[cursor + 4]; cursor += 5;
    if (flags & 0x18) throw new Error('Unsupported frame flags');
    const sizeFlag = flags >>> 6; const single = Boolean(flags & 0x20); const dictionary = flags & 3;
    cursor += (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag ? 1 << sizeFlag : single ? 1 : 0);
    let last = false;
    while (!last) {
      if (cursor + 3 > input.length) throw new Error('Incomplete block');
      const block = input.readUIntLE(cursor, 3); cursor += 3;
      last = Boolean(block & 1); const type = (block >>> 1) & 3;
      if (type === 3) throw new Error('Unsupported block');
      cursor += type === 1 ? 1 : block >>> 3;
      if (cursor > input.length) throw new Error('Incomplete block');
    }
    if (flags & 4) cursor += 4;
    if (cursor > input.length) throw new Error('Incomplete checksum');
    frames.push([start, cursor]);
    if (frames.length > 65536) throw new Error('Too many frames');
  }
  return frames;
}
async function harnessEvents(input, compressed, details = false) {
  let decoded = 0; const events = [];
  const chunks = compressed ? zstdFrames(input).slice(-128).map(([a, b]) => input.subarray(a, b)) : [input];
  for (const chunk of chunks) {
    const text = compressed ? (await promisify(zlib.zstdDecompress)(chunk, { maxOutputLength: 8 * 1024 * 1024 })).toString('utf8') : chunk.toString('utf8');
    decoded += Buffer.byteLength(text);
    if (decoded > 16 * 1024 * 1024) throw new Error('Decoded records too large');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'session' && event.version !== 4) throw new Error('Unsupported session version');
      if (!Number.isInteger(event.seq) || !Number.isFinite(event.time)) continue;
      // Only metadata leaves this reader. Message bodies, IDs, commands and paths are discarded.
      events.push({ type: event.type, seq: event.seq, time: event.time,
        reason: event.type === 'turn/end' ? event.data?.reason?.kind : undefined,
        ...(details && event.type === 'session' ? { title: require('./task-details.cjs').safeText(event.title || event.data?.title) } : {}) });
      if (events.length > 100000) throw new Error('Too many events');
    }
  }
  // Cache only the state boundary, latest approval and final timestamp, never full history.
  const boundary = events.findLast(e => e.type === 'turn/start' || e.type === 'turn/end');
  const approval = events.findLast(e => e.type === 'approval/asked' || e.type === 'approval/decided');
  return [...new Set([boundary, approval, ...(details ? [events.findLast(e => e.title), events.findLast(e => ['tool/start', 'tool/end'].includes(e.type))] : []), events.at(-1)].filter(Boolean))].sort((a, b) => a.seq - b.seq);
}
module.exports = { boundedFile, directories, zstdFrames, harnessEvents };
