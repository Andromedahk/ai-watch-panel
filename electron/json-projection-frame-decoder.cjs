const { StringDecoder } = require('node:string_decoder');
const { jsonParser } = require('stream-json/core/parser.js');
const { none, isMany, getManyValues } = require('stream-chain/core');

const MAX_FRAME = 256 * 1024 * 1024;
const MAX_PROJECTED_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const OMIT = Symbol('omitted JSON value');
const NO_KEY = Symbol('missing or omitted JSON key');

function limit(value, maximum, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${name}`);
  return value;
}

// Retained strings must not keep a large tokenizer input string alive through a
// sliced-string backing store. Only bounded selected metadata is copied here;
// JSON round-tripping also preserves escaped lone UTF-16 surrogates.
const copyString = value => JSON.parse(JSON.stringify(value));

/**
 * Read length-prefixed JSON without materializing its discarded text or trees.
 * select(path, type): false skips a whole value; true keeps it and visits its
 * children; a nonnegative integer keeps a string up to that many UTF-16 units.
 * Oversized keys/string/number values are omitted, never truncated. Selected
 * arrays retain their length and original indexes, with holes for omitted items.
 * A skipped root does not call handle. Every selected root is dispatched only
 * after the entire frame has been validated. Resource-limit errors reset state
 * and throw, allowing the connection owner to close or replace its transport.
 */
class JsonProjectionFrameDecoder {
  constructor({ select = () => true, maxFrame = MAX_FRAME, maxProjectedBytes = MAX_PROJECTED_BYTES,
    maxNodes = 65536, maxDepth = 128, maxKeyChars = 256, maxStringChars = 256, maxNumberChars = 128 } = {}) {
    if (typeof select !== 'function') throw new TypeError('Invalid JSON projection selector');
    this.select = select;
    this.maxFrame = limit(maxFrame, MAX_FRAME, 'maximum frame size');
    this.maxProjectedBytes = limit(maxProjectedBytes, MAX_PROJECTED_BYTES, 'projection budget');
    this.maxNodes = limit(maxNodes, 65536, 'projection node budget');
    this.maxDepth = limit(maxDepth, 128, 'JSON nesting depth');
    this.maxKeyChars = limit(maxKeyChars, 1024, 'maximum key length');
    this.maxStringChars = limit(maxStringChars, MAX_PROJECTED_BYTES / 2, 'maximum string length', 0);
    this.maxNumberChars = limit(maxNumberChars, 1024, 'maximum number length');
    this.header = Buffer.alloc(4);
    this.generation = 0;
    this.reset();
  }

  reset() {
    this.generation++;
    this._clearFrame();
  }

  _clearFrame() {
    this.headerBytes = 0;
    this.frameLength = 0;
    this.frameBytes = 0;
    this.parser = null;
    this.utf8 = null;
    this.stack = [];
    this.scalar = null;
    this.key = null;
    this.root = OMIT;
    this.rootStarted = false;
    this.rootComplete = false;
    this.projectedBytes = 0;
    this.projectedNodes = 0;
  }

  get pendingBytes() { return this.headerBytes + this.frameBytes; }

  _charge(bytes, nodes = 0) {
    this.projectedBytes += bytes;
    this.projectedNodes += nodes;
    if (this.projectedBytes > this.maxProjectedBytes || this.projectedNodes > this.maxNodes) {
      throw new RangeError('JSON projection budget exceeded');
    }
  }

  _slot(type) {
    const parent = this.stack.at(-1);
    let path;
    let key;
    let eligible = true;
    if (!parent) {
      if (this.rootStarted) throw new SyntaxError('Multiple JSON roots in one frame');
      this.rootStarted = true;
      path = [];
    } else if (parent.type === 'array') {
      key = parent.index++;
      eligible = parent.selected;
      if (eligible) {
        // Array positions count against both budgets even when the value is
        // omitted: preserving a million holes must not bypass the memory cap.
        this._charge(8, 1);
        parent.value.length = parent.index;
        path = parent.path.concat(key);
      }
    } else {
      key = parent.key;
      parent.key = NO_KEY;
      eligible = parent.selected && key !== NO_KEY;
      if (eligible) {
        path = parent.path.concat(key);
        // JSON duplicate keys use their last value, including an omitted one.
        if (Object.hasOwn(parent.value, key)) delete parent.value[key];
      }
    }
    let decision = false;
    if (eligible) decision = this.select(path, type);
    if (decision !== false && decision !== true && !(Number.isSafeInteger(decision) && decision >= 0)) {
      throw new TypeError('Invalid JSON projection selection');
    }
    const selected = decision !== false;
    const maxChars = type === 'string' && typeof decision === 'number' ? decision : this.maxStringChars;
    if (type === 'string' && selected) limit(maxChars, MAX_PROJECTED_BYTES / 2, 'selected string length', 0);
    return { parent, key, path, selected, maxChars };
  }

  _commit(slot, value) {
    if (!slot.parent) {
      this.root = value;
      this.rootComplete = true;
      return;
    }
    if (value === OMIT) return;
    if (slot.parent.type === 'object') {
      this._charge(16 + slot.key.length * 2);
      // Assignment to __proto__ would mutate the prototype rather than retain
      // the JSON property. This also handles constructor/prototype as plain data.
      Object.defineProperty(slot.parent.value, slot.key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      slot.parent.value[slot.key] = value;
    }
  }

  _tokens(result) {
    if (result === none) return;
    if (isMany(result)) {
      for (const token of getManyValues(result)) this._token(token);
    } else this._token(result);
  }

  _token(token) {
    switch (token.name) {
      case 'startObject':
      case 'startArray': {
        if (this.stack.length >= this.maxDepth) throw new RangeError('JSON nesting depth exceeded');
        const type = token.name === 'startObject' ? 'object' : 'array';
        const slot = this._slot(type);
        if (slot.selected) this._charge(32, 1);
        this.stack.push({ type, slot, path: slot.path, selected: slot.selected,
          value: slot.selected ? type === 'array' ? [] : {} : OMIT, key: NO_KEY, index: 0 });
        return;
      }
      case 'endObject':
      case 'endArray': {
        const frame = this.stack.pop();
        if (!frame || frame.type !== (token.name === 'endObject' ? 'object' : 'array')) throw new SyntaxError('Unbalanced JSON container');
        this._commit(frame.slot, frame.value);
        return;
      }
      case 'startKey':
        this.key = { text: '', retained: this.stack.at(-1)?.selected === true };
        return;
      case 'endKey': {
        const parent = this.stack.at(-1);
        if (!parent || parent.type !== 'object' || !this.key) throw new SyntaxError('Unexpected JSON key');
        parent.key = this.key.retained ? copyString(this.key.text) : NO_KEY;
        this.key = null;
        return;
      }
      case 'startString':
      case 'startNumber': {
        const type = token.name === 'startString' ? 'string' : 'number';
        const slot = this._slot(type);
        this.scalar = { type, slot, text: '', retained: slot.selected,
          maxChars: type === 'number' ? this.maxNumberChars : slot.maxChars };
        return;
      }
      case 'stringChunk':
      case 'numberChunk': {
        const target = this.key || this.scalar;
        if (!target) throw new SyntaxError('Unexpected JSON scalar chunk');
        if (!target.retained) return;
        const maximum = this.key ? this.maxKeyChars : target.maxChars;
        if (target.text.length + token.value.length > maximum) {
          target.text = '';
          target.retained = false;
          return;
        }
        if (!this.key && this.projectedBytes + (target.text.length + token.value.length) * 2 > this.maxProjectedBytes) {
          throw new RangeError('JSON projection budget exceeded');
        }
        target.text += token.value;
        return;
      }
      case 'endString':
      case 'endNumber': {
        const scalar = this.scalar;
        if (!scalar || scalar.type !== (token.name === 'endString' ? 'string' : 'number')) throw new SyntaxError('Unbalanced JSON scalar');
        this.scalar = null;
        let value = OMIT;
        if (scalar.retained) {
          this._charge(16 + (scalar.type === 'string' ? scalar.text.length * 2 : 8), 1);
          value = scalar.type === 'string' ? copyString(scalar.text) : Number(scalar.text);
        }
        this._commit(scalar.slot, value);
        return;
      }
      case 'nullValue':
      case 'trueValue':
      case 'falseValue': {
        const slot = this._slot(token.name === 'nullValue' ? 'null' : 'boolean');
        if (slot.selected) this._charge(16, 1);
        this._commit(slot, slot.selected ? token.value : OMIT);
        return;
      }
      default:
        throw new SyntaxError('Unexpected JSON projection token');
    }
  }

  feed(chunk, handle) {
    const generation = this.generation;
    try {
      if (!Buffer.isBuffer(chunk) || typeof handle !== 'function') throw new TypeError('Invalid frame input');
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.parser) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes < 4) continue;
          this.frameLength = this.header.readUInt32LE(0);
          if (!this.frameLength || this.frameLength > this.maxFrame) throw new RangeError('Invalid frame length');
          this.parser = jsonParser({ packValues: false });
          this.utf8 = new StringDecoder('utf8');
        }
        const count = Math.min(CHUNK_BYTES, this.frameLength - this.frameBytes, chunk.length - offset);
        const text = this.utf8.write(chunk.subarray(offset, offset + count));
        offset += count;
        this.frameBytes += count;
        if (text) this._tokens(this.parser(text));
        if (this.frameBytes === this.frameLength) {
          const tail = this.utf8.end();
          if (tail) this._tokens(this.parser(tail));
          this._tokens(this.parser(none));
          if (!this.rootComplete || this.stack.length || this.scalar || this.key) throw new SyntaxError('Incomplete JSON frame');
          const projected = this.root;
          // Release parser, token state, and old input before consumer code runs.
          // Internal frame completion must not change the public reset generation.
          this._clearFrame();
          if (projected !== OMIT) handle(projected);
          if (this.generation !== generation) return;
        }
      }
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}

module.exports = { JsonProjectionFrameDecoder, MAX_FRAME, MAX_PROJECTED_BYTES, CHUNK_BYTES };
