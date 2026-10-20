const MAX_FRAME = 16 * 1024 * 1024;
const copyBytes = (source, target, targetStart, sourceStart, sourceEnd) => source.copy(target, targetStart, sourceStart, sourceEnd);

/** Decode four-byte little-endian lengths without repeatedly copying partial frames. */
class JsonFrameDecoder {
  constructor({ maxFrame = MAX_FRAME, allocate = Buffer.allocUnsafe, copy = copyBytes } = {}) {
    if (!Number.isInteger(maxFrame) || maxFrame < 1 || maxFrame > MAX_FRAME) throw new RangeError('Invalid maximum frame size');
    this.maxFrame = maxFrame;
    this.allocate = allocate;
    this.copy = copy;
    this.header = Buffer.allocUnsafe(4);
    this.generation = 0;
    this.reset();
  }
  reset() {
    this.headerBytes = 0;
    this.payload = null;
    this.payloadBytes = 0;
    this.generation++;
  }
  get pendingBytes() { return this.headerBytes + this.payloadBytes; }
  feed(chunk, handle) {
    const generation = this.generation;
    try {
      if (!Buffer.isBuffer(chunk) || typeof handle !== 'function') throw new TypeError('Invalid frame input');
      let position = 0;
      while (position < chunk.length) {
        if (!this.payload) {
          const count = Math.min(4 - this.headerBytes, chunk.length - position);
          this.copy(chunk, this.header, this.headerBytes, position, position + count);
          this.headerBytes += count;
          position += count;
          if (this.headerBytes < 4) continue;
          const size = this.header.readUInt32LE(0);
          if (!size || size > this.maxFrame) throw new RangeError('Invalid frame length');
          this.payload = this.allocate(size);
          if (!Buffer.isBuffer(this.payload) || this.payload.length !== size) throw new TypeError('Invalid frame allocation');
        }
        const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - position);
        if (count) {
          this.copy(chunk, this.payload, this.payloadBytes, position, position + count);
          this.payloadBytes += count;
          position += count;
        }
        if (this.payloadBytes === this.payload.length) {
          const payload = this.payload;
          // Release the completed byte buffer before dispatching to the reader.
          this.headerBytes = 0;
          this.payload = null;
          this.payloadBytes = 0;
          handle(JSON.parse(payload.toString('utf8')));
          // A callback may close its connection and explicitly discard later frames.
          if (this.generation !== generation) return;
        }
      }
    } catch (error) { this.reset(); throw error; }
  }
}
module.exports = { JsonFrameDecoder, MAX_FRAME };
