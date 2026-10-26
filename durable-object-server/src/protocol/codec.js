// protocol/codec.js
//
// Pure, socket-free binary encoder/decoder driven by the schema. Safe to import in
// browsers, Cloudflare Workers, and Node. Everything is little-endian.

export const FLAG = Object.freeze({ REQUEST: 1, RESPONSE: 2, ERROR: 4, CHUNK: 8 });
export const CHUNK_HEADER_SIZE = 7; // [ver|flags][transferId u16][index u16][total u16]

/** Built-in messages every endpoint understands. */
export const SYSTEM_MESSAGES = Object.freeze({
  // Sent by the server right after a socket is accepted.
  //   uid  - this client's id
  //   base - server epoch (ms) that all `ts` fields on this connection are relative to
  //   now  - server clock (ms) at send time, used to estimate clock offset
  hello: { id: 255, fields: { uid: 'uid', base: 'f64', now: 'f64' } },

  relayStart: { id: 254, fields: { peer: 'uid', xfer: 'u16', total: 'uvar', size: 'uvar', meta: 'json', isMsg: 'bool' }, reply: 'relayAck' },
  relayChunk: { id: 253, fields: { peer: 'uid', xfer: 'u16', index: 'uvar', isMsg: 'bool' }, payload: true, reply: 'relayAck' },
  relayAck:   { id: 252, fields: {} },
});

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class ProtocolVersionError extends ProtocolError {
  constructor(got, expected) {
    super(`Protocol version mismatch: received v${got}, expected v${expected}`);
    this.name = 'ProtocolVersionError';
    this.got = got;
    this.expected = expected;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const EMPTY = new Uint8Array(0);
const NAME_RE = /^[A-Za-z_$][\w$]*$/;

/** ArrayBuffer | TypedArray | DataView -> Uint8Array view (no copy). */
export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') throw new ProtocolError('Text frames are not supported; send binary');
  throw new TypeError('Expected an ArrayBuffer or typed array');
}

function binary(data, what) {
  if (typeof data === 'string') throw new TypeError(`${what} must be binary, not a string`);
  return toBytes(data);
}

// ---------------------------------------------------------------------------
// Reader / Writer
// ---------------------------------------------------------------------------

class Writer {
  constructor(size) {
    this.buf = new ArrayBuffer(size);
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
    this.o = 0;
  }
}

class Reader {
  constructor(u8) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.o = 0;
  }
  need(n) {
    if (this.o + n > this.u8.byteLength) throw new ProtocolError('Truncated packet');
  }
}

function uvarSize(n) {
  let s = 1;
  while (n >= 128) {
    n = Math.floor(n / 128);
    s++;
  }
  return s;
}

function writeUvar(w, n) {
  while (n >= 128) {
    w.u8[w.o++] = (n % 128) | 128;
    n = Math.floor(n / 128);
  }
  w.u8[w.o++] = n;
}

function readUvar(r) {
  let n = 0;
  let mul = 1;
  for (let i = 0; i < 8; i++) {
    r.need(1);
    const b = r.u8[r.o++];
    n += (b & 127) * mul;
    if (!(b & 128)) return n;
    mul *= 128;
  }
  throw new ProtocolError('Varint too long');
}

// ---------------------------------------------------------------------------
// Field types
//
// Each type is { size(prepped), prep(value, name, st), write(w, prepped), read(r, st) }.
// `prep` validates and converts (e.g. string -> bytes) so size and write share the work.
// `st` is { base, now } for the connection.
// ---------------------------------------------------------------------------

function numType(bytes, get, set, min, max, int) {
  return {
    size: () => bytes,
    prep(v, name) {
      if (typeof v !== 'number' || Number.isNaN(v)) throw new TypeError(`Field "${name}" must be a number`);
      if (int && (!Number.isInteger(v) || v < min || v > max)) {
        throw new RangeError(`Field "${name}" must be an integer in [${min}, ${max}], got ${v}`);
      }
      return v;
    },
    write(w, v) {
      w.dv[set](w.o, v, true);
      w.o += bytes;
    },
    read(r) {
      r.need(bytes);
      const v = r.dv[get](r.o, true);
      r.o += bytes;
      return v;
    },
  };
}

const u32 = numType(4, 'getUint32', 'setUint32', 0, 0xffffffff, true);
const i32 = numType(4, 'getInt32', 'setInt32', -0x80000000, 0x7fffffff, true);

const varBytes = {
  size: (b) => uvarSize(b.length) + b.length,
  write(w, b) {
    writeUvar(w, b.length);
    w.u8.set(b, w.o);
    w.o += b.length;
  },
  readRaw(r) {
    const len = readUvar(r);
    r.need(len);
    const out = r.u8.subarray(r.o, r.o + len);
    r.o += len;
    return out;
  },
};

const TYPES = {
  u8: numType(1, 'getUint8', 'setUint8', 0, 0xff, true),
  u16: numType(2, 'getUint16', 'setUint16', 0, 0xffff, true),
  u32,
  i8: numType(1, 'getInt8', 'setInt8', -0x80, 0x7f, true),
  i16: numType(2, 'getInt16', 'setInt16', -0x8000, 0x7fff, true),
  i32,
  f32: numType(4, 'getFloat32', 'setFloat32', 0, 0, false),
  f64: numType(8, 'getFloat64', 'setFloat64', 0, 0, false),
  uid: u32,

  bool: {
    size: () => 1,
    prep(v, name) {
      if (typeof v !== 'boolean') throw new TypeError(`Field "${name}" must be a boolean`);
      return v ? 1 : 0;
    },
    write(w, v) {
      w.u8[w.o++] = v;
    },
    read(r) {
      r.need(1);
      return r.u8[r.o++] === 1;
    },
  },

  uvar: {
    size: uvarSize,
    prep(v, name) {
      if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`Field "${name}" must be a non-negative safe integer`);
      return v;
    },
    write: writeUvar,
    read: readUvar,
  },

  // Absolute ms (server clock) <-> i32 ms relative to the connection's base.
  ts: {
    auto: true, // may be omitted when encoding; filled with "now"
    isTs: true, // value depends on the connection's base time
    size: () => 4,
    prep(v, name, st) {
      if (v === undefined) v = st.now;
      else if (v instanceof Date) v = v.getTime();
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`Field "${name}" must be a ms timestamp or Date`);
      const rel = Math.round(v - st.base);
      if (rel < -0x80000000 || rel > 0x7fffffff) {
        throw new RangeError(`Field "${name}": timestamp is more than ~24.8 days from this connection's base time`);
      }
      return rel;
    },
    write: i32.write,
    read(r, st) {
      return st.base + i32.read(r);
    },
  },

  str: {
    size: varBytes.size,
    prep(v, name) {
      if (typeof v !== 'string') throw new TypeError(`Field "${name}" must be a string`);
      return enc.encode(v);
    },
    write: varBytes.write,
    read: (r) => dec.decode(varBytes.readRaw(r)),
  },

  json: {
    size: varBytes.size,
    prep: (v) => enc.encode(JSON.stringify(v) ?? 'null'),
    write: varBytes.write,
    read(r) {
      try {
        return JSON.parse(dec.decode(varBytes.readRaw(r)));
      } catch {
        throw new ProtocolError('Invalid JSON field');
      }
    },
  },

  bytes: {
    size: varBytes.size,
    prep: (v, name) => binary(v, `Field "${name}"`),
    write: varBytes.write,
    read: (r) => varBytes.readRaw(r).slice(), // small field: copy so it doesn't pin the packet
  },
};

function fixedBytes(n) {
  return {
    size: () => n,
    prep(v, name) {
      const b = binary(v, `Field "${name}"`);
      if (b.byteLength !== n) throw new RangeError(`Field "${name}" must be exactly ${n} bytes, got ${b.byteLength}`);
      return b;
    },
    write(w, b) {
      w.u8.set(b, w.o);
      w.o += n;
    },
    read(r) {
      r.need(n);
      const out = r.u8.slice(r.o, r.o + n);
      r.o += n;
      return out;
    },
  };
}

function flagsType(names, where) {
  if (!names.length || names.length > 32) throw new Error(`${where}: flags needs 1..32 names`);
  for (const n of names) if (typeof n !== 'string' || !NAME_RE.test(n)) throw new Error(`${where}: bad flag name ${JSON.stringify(n)}`);
  if (new Set(names).size !== names.length) throw new Error(`${where}: duplicate flag name`);
  const nbytes = Math.ceil(names.length / 8);
  return {
    size: () => nbytes,
    prep(v, name) {
      if (typeof v !== 'object' || v === null) throw new TypeError(`Field "${name}" must be an object of booleans`);
      const out = new Uint8Array(nbytes);
      names.forEach((n, i) => {
        if (v[n]) out[i >> 3] |= 1 << (i & 7);
      });
      return out;
    },
    write(w, b) {
      w.u8.set(b, w.o);
      w.o += nbytes;
    },
    read(r) {
      r.need(nbytes);
      const out = {};
      names.forEach((n, i) => {
        out[n] = (r.u8[r.o + (i >> 3)] & (1 << (i & 7))) !== 0;
      });
      r.o += nbytes;
      return out;
    },
  };
}

function resolveType(spec, where) {
  if (spec && typeof spec === 'object' && Array.isArray(spec.flags)) return flagsType(spec.flags, where);
  if (typeof spec === 'string') {
    if (Object.hasOwn(TYPES, spec)) return TYPES[spec];
    const m = /^bytes\((\d+)\)$/.exec(spec);
    if (m && +m[1] > 0) return fixedBytes(+m[1]);
  }
  throw new Error(`${where}: unknown field type ${JSON.stringify(spec)}`);
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export class Codec {
  /**
   * @param {object} schema  see schema.js
   * @param {{ strict?: boolean }} [options]  strict (default true) rejects unknown field names on encode
   */
  constructor(schema, { strict = true } = {}) {
    if (!schema || typeof schema !== 'object' || !schema.messages) throw new Error('Schema must have a `messages` object');
    const { version } = schema;
    if (!Number.isInteger(version) || version < 0 || version > 15) throw new Error('schema.version must be an integer 0..15');
    this.version = version;
    this.strict = strict;
    this._byName = new Map();
    this._byId = new Map();

    // if none of the schema messages have ids, assign them sequentially starting at 1 (system messages are 240..255)
    if (!Object.values(schema.messages).some((d) => Number.isInteger(d.id))) {
      let nextId = 1;
      for (const d of Object.values(schema.messages)) {
        if (d.id === undefined) {
          d.id = nextId++;
        }
      }
    }

    const entries = [
      ...Object.entries(SYSTEM_MESSAGES).map(([n, d]) => [n, d, true]),
      ...Object.entries(schema.messages).map(([n, d]) => [n, d, false]),
    ];

    for (const [name, d, system] of entries) {
      const where = `message "${name}"`;
      if (!NAME_RE.test(name)) throw new Error(`${where}: invalid name`);
      if (!Number.isInteger(d.id) || d.id < (system ? 240 : 1) || d.id > (system ? 255 : 239)) {
        throw new Error(`${where}: id must be an integer ${system ? '240..255' : '1..239'} (got ${d.id})`);
      }
      if (this._byName.has(name)) throw new Error(`${where}: duplicate name`);
      if (this._byId.has(d.id)) throw new Error(`${where}: id ${d.id} already used by "${this._byId.get(d.id).name}"`);

      const fields = [];
      const fieldMap = new Map();
      for (const [fname, spec] of Object.entries(d.fields ?? {})) {
        if (!NAME_RE.test(fname)) throw new Error(`${where}: invalid field name "${fname}"`);
        const f = { name: fname, t: resolveType(spec, `${where}, field "${fname}"`) };
        fields.push(f);
        fieldMap.set(fname, f);
      }
      const def = {
        name,
        id: d.id,
        fields,
        fieldMap,
        payload: !!d.payload,
        reply: d.reply ?? null,
        hasTs: fields.some((f) => f.t.isTs), // encoded bytes differ per connection if true
      };
      this._byName.set(name, def);
      this._byId.set(d.id, def);
    }
    for (const def of this._byName.values()) {
      if (def.reply !== null && !this._byName.has(def.reply)) {
        throw new Error(`message "${def.name}": reply type "${def.reply}" does not exist`);
      }
    }
  }

  /** Look up a message definition by name. */
  def(name) {
    const d = this._byName.get(name);
    if (!d) throw new Error(`Unknown message type "${name}"`);
    return d;
  }

  has(name) {
    return this._byName.has(name);
  }

  /**
   * @param {string} name
   * @param {object} [fields]
   * @param {ArrayBuffer|ArrayBufferView} [payload]  only for messages declared `payload: true`
   * @param {{ flags?: number, reqId?: number, base?: number, now?: number }} [opts]
   * @returns {ArrayBuffer}
   */
  encode(name, fields = {}, payload, opts = {}) {
    const def = this.def(name);
    const flags = opts.flags ?? 0;
    const st = { base: opts.base ?? 0, now: opts.now ?? Date.now() };
    const hasReq = (flags & (FLAG.REQUEST | FLAG.RESPONSE)) !== 0;
    if (hasReq && !(Number.isInteger(opts.reqId) && opts.reqId >= 0 && opts.reqId <= 0xffff)) {
      throw new RangeError('reqId must be an integer 0..65535');
    }
    if (this.strict && fields) {
      for (const k of Object.keys(fields)) {
        if (!def.fieldMap.has(k)) throw new TypeError(`Message "${name}": unknown field "${k}"`);
      }
    }

    let pay = null;
    if (def.payload) pay = payload == null ? EMPTY : binary(payload, 'payload');
    else if (payload != null) throw new TypeError(`Message "${name}" does not carry a payload`);

    const prepped = new Array(def.fields.length);
    let size = 2 + (hasReq ? 2 : 0) + (pay ? pay.byteLength : 0);
    for (let i = 0; i < def.fields.length; i++) {
      const f = def.fields[i];
      const v = fields?.[f.name];
      if (v === undefined && !f.t.auto) throw new TypeError(`Message "${name}": missing field "${f.name}"`);
      prepped[i] = f.t.prep(v, f.name, st);
      size += f.t.size(prepped[i]);
    }

    const w = new Writer(size);
    w.u8[0] = (this.version << 4) | flags;
    w.u8[1] = def.id;
    w.o = 2;
    if (hasReq) {
      w.dv.setUint16(2, opts.reqId, true);
      w.o = 4;
    }
    for (let i = 0; i < def.fields.length; i++) def.fields[i].t.write(w, prepped[i]);
    if (pay) w.u8.set(pay, w.o);
    return w.buf;
  }

  /** Error response to a request of type `name`: [hdr][type][reqId][utf8 text]. */
  encodeError(name, reqId, text) {
    const def = this.def(name);
    const body = enc.encode(String(text).slice(0, 1000));
    const w = new Writer(4 + body.length);
    w.u8[0] = (this.version << 4) | FLAG.RESPONSE | FLAG.ERROR;
    w.u8[1] = def.id;
    w.dv.setUint16(2, reqId, true);
    w.u8.set(body, 4);
    return w.buf;
  }

  /**
   * Check the version byte and return the packet as bytes plus its flags.
   * Throws ProtocolVersionError if the version differs.
   */
  peek(data) {
    const u8 = toBytes(data);
    if (u8.byteLength < 1) throw new ProtocolError('Empty packet');
    const version = u8[0] >> 4;
    if (version !== this.version) throw new ProtocolVersionError(version, this.version);
    return { u8, flags: u8[0] & 15 };
  }

  /**
   * Decode a non-chunk packet.
   * @param {ArrayBuffer|ArrayBufferView} data
   * @param {{ base?: number, copyPayload?: boolean }} [opts]
   *   copyPayload: false (default) returns the payload as a zero-copy view into `data`
   * @returns {{ type: string, id: number, fields: object, payload?: Uint8Array,
   *             request: boolean, response: boolean, error?: string, reqId?: number }}
   */
  decode(data, { base = 0, copyPayload = false } = {}) {
    const { u8, flags } = this.peek(data);
    if (flags & FLAG.CHUNK) throw new ProtocolError('Chunk packet passed to decode(); reassemble first');
    if (u8.byteLength < 2) throw new ProtocolError('Truncated packet');
    const def = this._byId.get(u8[1]);
    if (!def) throw new ProtocolError(`Unknown message id ${u8[1]}`);

    const r = new Reader(u8);
    r.o = 2;
    const msg = {
      type: def.name,
      id: def.id,
      fields: {},
      request: (flags & FLAG.REQUEST) !== 0,
      response: (flags & FLAG.RESPONSE) !== 0,
    };
    if (msg.request || msg.response) {
      r.need(2);
      msg.reqId = r.dv.getUint16(r.o, true);
      r.o += 2;
    }
    if (flags & FLAG.ERROR) {
      msg.error = dec.decode(u8.subarray(r.o));
      return msg;
    }

    const st = { base };
    for (const f of def.fields) msg.fields[f.name] = f.t.read(r, st);
    if (def.payload) {
      const view = u8.subarray(r.o);
      msg.payload = copyPayload ? view.slice() : view;
    } else if (r.o !== u8.byteLength) {
      throw new ProtocolError(`Message "${def.name}" has ${u8.byteLength - r.o} unexpected trailing byte(s)`);
    }
    return msg;
  }

  /** Split an encoded packet into chunk packets no larger than `maxPacket`. */
  *chunks(data, maxPacket, transferId) {
    const u8 = toBytes(data);
    const room = maxPacket - CHUNK_HEADER_SIZE;
    if (room < 1) throw new RangeError('maxPacket is too small to chunk');
    const total = Math.ceil(u8.byteLength / room);
    if (total > 0xffff) throw new RangeError(`Message too large to chunk (${u8.byteLength} bytes needs ${total} chunks, max 65535)`);
    for (let i = 0; i < total; i++) {
      const slice = u8.subarray(i * room, Math.min((i + 1) * room, u8.byteLength));
      const buf = new ArrayBuffer(CHUNK_HEADER_SIZE + slice.byteLength);
      const b = new Uint8Array(buf);
      const dv = new DataView(buf);
      b[0] = (this.version << 4) | FLAG.CHUNK;
      dv.setUint16(1, transferId, true);
      dv.setUint16(3, i, true);
      dv.setUint16(5, total, true);
      b.set(slice, CHUNK_HEADER_SIZE);
      yield buf;
    }
  }

  decodeChunk(data) {
    const u8 = toBytes(data);
    if (u8.byteLength < CHUNK_HEADER_SIZE) throw new ProtocolError('Truncated chunk');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return {
      transferId: dv.getUint16(1, true),
      index: dv.getUint16(3, true),
      total: dv.getUint16(5, true),
      data: u8.subarray(CHUNK_HEADER_SIZE),
    };
  }
}