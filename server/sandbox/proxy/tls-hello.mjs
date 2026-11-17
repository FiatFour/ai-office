/** @typedef {{ kind: 'need-more' } | { kind: 'invalid' } | { kind: 'hello', sni: string | null, ech: boolean }} Hello */

const RECORD_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const EXT_SERVER_NAME = 0;
const EXT_ECH = [0xfe0d, 0xffce];
const MAX_RECORD = 16384;
const MAX_HELLO = 65536;

/** @type {Hello} */
const NEED_MORE = { kind: 'need-more' };
/** @type {Hello} */
const INVALID = { kind: 'invalid' };

/** Bounded reader that throws a RangeError when a field runs past its buffer. */
class Reader {
  /** @param {Buffer} buffer */
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  /** @param {number} length */
  take(length) {
    if (this.offset + length > this.buffer.length) throw new RangeError('truncated');
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u8() {
    return /** @type {number} */ (this.take(1)[0]);
  }

  u16() {
    return this.take(2).readUInt16BE();
  }

  /** @param {1 | 2} lengthBytes */
  vector(lengthBytes) {
    return this.take(lengthBytes === 1 ? this.u8() : this.u16());
  }

  get done() {
    return this.offset === this.buffer.length;
  }
}

/** @param {Buffer} extension */
function readServerName(extension) {
  const list = new Reader(new Reader(extension).vector(2));
  /** @type {string[]} */
  const names = [];
  while (!list.done) {
    const type = list.u8();
    const name = list.vector(2);
    if (type === 0) names.push(name.toString('latin1').toLowerCase());
  }
  return names;
}

/** @param {Buffer} body @returns {Hello} */
function readHello(body) {
  const reader = new Reader(body);
  reader.take(2 + 32);
  reader.vector(1);
  reader.vector(2);
  reader.vector(1);
  if (reader.done) return { kind: 'hello', sni: null, ech: false };
  const extensions = new Reader(reader.vector(2));
  /** @type {string[]} */
  let names = [];
  let sawServerName = false;
  let ech = false;
  while (!extensions.done) {
    const type = extensions.u16();
    const data = extensions.vector(2);
    if (type === EXT_SERVER_NAME) {
      if (sawServerName) return INVALID;
      sawServerName = true;
      names = readServerName(data);
    } else if (EXT_ECH.includes(type)) {
      ech = true;
    }
  }
  if (names.length > 1) return INVALID;
  return { kind: 'hello', sni: names[0] ?? null, ech };
}

/**
 * Reads the SNI and the ECH marker out of the first bytes a TLS client sends. It never decrypts anything.
 * Returns `need-more` until the whole ClientHello has arrived, across TCP segments and handshake records.
 * @param {Buffer} bytes
 * @returns {Hello}
 */
export function parseClientHello(bytes) {
  let handshake = Buffer.alloc(0);
  let offset = 0;
  try {
    for (;;) {
      if (bytes.length < offset + 5) return NEED_MORE;
      if (bytes[offset] !== RECORD_HANDSHAKE || bytes[offset + 1] !== 3) return INVALID;
      const length = bytes.readUInt16BE(offset + 3);
      if (length === 0 || length > MAX_RECORD) return INVALID;
      if (bytes.length < offset + 5 + length) return NEED_MORE;
      handshake = Buffer.concat([handshake, bytes.subarray(offset + 5, offset + 5 + length)]);
      offset += 5 + length;
      if (handshake.length >= 4) {
        if (handshake[0] !== HANDSHAKE_CLIENT_HELLO) return INVALID;
        const total = 4 + handshake.readUIntBE(1, 3);
        if (total > MAX_HELLO) return INVALID;
        if (handshake.length >= total) return readHello(handshake.subarray(4, total));
      }
    }
  } catch (error) {
    if (error instanceof RangeError) return INVALID;
    throw error;
  }
}
