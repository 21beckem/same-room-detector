// protocol/endpoint.js
//
// Transport-agnostic logic shared by client and server: sending, chunking,
// reassembly, events, and request/response. An Endpoint is one end of ONE socket.

import { Codec, FLAG, ProtocolError, ProtocolVersionError } from './codec.js';

export class RequestError extends Error {
  /** The remote handler threw (or no handler was registered). `message` is its error text. */
  constructor(message) {
    super(message);
    this.name = 'RequestError';
  }
}
export class RequestTimeoutError extends RequestError {
  constructor(type, ms) {
    super(`Request "${type}" timed out after ${ms}ms`);
    this.name = 'RequestTimeoutError';
  }
}
export class ConnectionClosedError extends RequestError {
  constructor(message = 'Connection closed') {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

/** Holds on()/handle() registrations. Client and Server extend this. */
export class Router {
  constructor(codec) {
    this.codec = codec;
    this.listeners = new Map(); // type -> Set<fn>
    this.handlers = new Map(); // type -> fn
  }

  _checkEventName(type) {
    if (typeof type === 'string' && type.startsWith('socket:')) return;
    this.codec.def(type); // throws for unknown message types
  }

  /** Listen for a message type. Returns an unsubscribe function. */
  on(type, fn) {
    this._checkEventName(type);
    if (typeof fn !== 'function') throw new TypeError('Listener must be a function');
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      return fn(...args);
    });
    return off;
  }

  off(type, fn) {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(fn);
    if (!set.size) this.listeners.delete(type);
  }

  /**
   * Answer requests of a type that declares `reply` in the schema.
   * fn(msg, ctx) returns (or resolves to) { fields, payload? } for the reply type.
   * Throwing sends the error message back to the requester.
   */
  handle(type, fn) {
    const def = this.codec.def(type);
    if (!def.reply) throw new Error(`"${type}" has no \`reply\` in the schema, so it cannot be handled as a request`);
    if (typeof fn !== 'function') throw new TypeError('Handler must be a function');
    this.handlers.set(type, fn);
    return () => {
      if (this.handlers.get(type) === fn) this.handlers.delete(type);
    };
  }
}

export class Endpoint {
  /**
   * @param {object} o
   * @param {Codec} o.codec
   * @param {object} o.schema        for maxPacket / requestTimeout / chunkTimeout / maxMessage
   * @param {'client'|'server'} o.role
   * @param {(buf: ArrayBuffer) => void} o.send   raw socket send
   * @param {Map} o.listeners  @param {Map} o.handlers   (usually from a Router)
   * @param {number} [o.base]        ms epoch that `ts` fields are relative to
   * @param {() => number} [o.now]   current server-clock ms
   * @param {boolean} [o.ready]      false queues sends until markReady()
   */
  constructor(o) {
    this.codec = o.codec;
    this.role = o.role;
    this._tx = o.send;
    this.listeners = o.listeners;
    this.handlers = o.handlers;
    this.base = o.base ?? 0;
    this.now = o.now ?? Date.now;
    this.ready = o.ready ?? true;
    this.closed = false;
    this.onHello = null;

    const s = o.schema ?? {};
    this.maxPacket = s.maxPacket ?? 1_048_576;
    this.requestTimeout = s.requestTimeout ?? 10_000;
    this.chunkTimeout = s.chunkTimeout ?? 30_000;
    this.maxMessage = s.maxMessage ?? 33_554_432;
    if (!Number.isInteger(this.maxPacket) || this.maxPacket < 64) throw new Error('schema.maxPacket must be an integer >= 64');

    this.pending = new Map(); // reqId -> { resolve, reject, timer, expect }
    this.assemblies = new Map(); // transferId -> partial chunked message
    this._queue = [];
    this._req = 0;
    this._xfer = 0;

    /** Passed to listeners and handlers. Owners may add fields (ws, uid, ...). */
    this.ctx = {
      send: (...a) => this.send(...a),
      request: (...a) => this.request(...a),
    };
  }

  // ----- sending ----------------------------------------------------------

  /** Fire-and-forget message. Payload (if the type has one) is the 3rd argument. */
  send(type, fields = {}, payload) {
    this.codec.def(type);
    if (this.closed) throw new ConnectionClosedError();
    if (!this.ready) {
      this._queue.push({ run: () => this._emitPacket(type, fields, payload, 0), fail: (e) => this.reportError(e) });
      return;
    }
    this._emitPacket(type, fields, payload, 0);
  }

  /**
   * Send a request and await the reply.
   * @param {string} type  a message type with `reply` in the schema
   * @param {object} [fields]
   * @param {{ payload?: ArrayBuffer|ArrayBufferView, timeout?: number }} [opts]
   * @returns {Promise<{type, fields, payload}>} the decoded reply message
   */
  request(type, fields = {}, opts = {}) {
    const def = this.codec.def(type);
    if (!def.reply) throw new Error(`"${type}" has no \`reply\` in the schema, so it cannot be used with request()`);
    if (this.closed) return Promise.reject(new ConnectionClosedError());

    return new Promise((resolve, reject) => {
      const id = this._allocReq();
      const timeout = opts.timeout ?? this.requestTimeout;
      const p = { resolve, reject, expect: def.reply, timer: null };
      if (timeout > 0 && Number.isFinite(timeout)) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RequestTimeoutError(type, timeout));
        }, timeout);
      }
      this.pending.set(id, p);

      const fail = (e) => {
        if (this.pending.get(id) !== p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(e);
      };
      const run = () => this._emitPacket(type, fields, opts.payload, FLAG.REQUEST, id);
      if (!this.ready) this._queue.push({ run, fail });
      else {
        try {
          run();
        } catch (e) {
          fail(e);
        }
      }
    });
  }

  _allocReq() {
    if (this.pending.size >= 0x10000) throw new Error('Too many requests in flight');
    do this._req = (this._req + 1) & 0xffff;
    while (this.pending.has(this._req));
    return this._req;
  }

  _emitPacket(name, fields, payload, flags, reqId) {
    const buf = this.codec.encode(name, fields, payload, { flags, reqId, base: this.base, now: this.now() });
    this.sendEncoded(buf);
  }

  /** Send an already-encoded packet, chunking if it is too large. */
  sendEncoded(buf) {
    if (this.closed) throw new ConnectionClosedError();
    if (buf.byteLength <= this.maxPacket) {
      this._tx(buf);
      return;
    }
    this._xfer = (this._xfer + 1) & 0xffff;
    for (const chunk of this.codec.chunks(buf, this.maxPacket, this._xfer)) this._tx(chunk);
  }

  /** Called by the owner once it can send (the client calls this after `hello`). */
  markReady() {
    this.ready = true;
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) {
      try {
        q.run();
      } catch (e) {
        q.fail(e);
      }
    }
  }

  // ----- receiving --------------------------------------------------------

  /**
   * Feed one raw socket message in. Resolves once every listener/handler has finished,
   * so a Durable Object can `await` it inside webSocketMessage().
   * Rejects with ProtocolError / ProtocolVersionError for bad packets.
   */
  async receive(data) {
    if (typeof data === 'string') throw new ProtocolError('Text frames are not supported; send binary');
    const { u8, flags } = this.codec.peek(data);
    let packet = u8;
    if (flags & FLAG.CHUNK) {
      packet = this._addChunk(this.codec.decodeChunk(u8));
      if (!packet) return; // more chunks to come
    }
    const msg = this.codec.decode(packet, { base: this.base });
    await this._dispatch(msg);
  }

  _addChunk(c) {
    const now = Date.now();
    for (const [id, a] of this.assemblies) if (now - a.t > this.chunkTimeout) this.assemblies.delete(id);
    if (c.total < 1 || c.index >= c.total) throw new ProtocolError('Bad chunk header');

    let a = this.assemblies.get(c.transferId);
    if (a && a.total !== c.total) {
      this.assemblies.delete(c.transferId);
      throw new ProtocolError('Chunk total changed mid-transfer');
    }
    if (!a) {
      a = { total: c.total, parts: new Array(c.total), got: 0, bytes: 0, t: now };
      this.assemblies.set(c.transferId, a);
    }
    a.t = now;
    if (!a.parts[c.index]) {
      a.parts[c.index] = c.data;
      a.got++;
      a.bytes += c.data.byteLength;
      if (a.bytes > this.maxMessage) {
        this.assemblies.delete(c.transferId);
        throw new ProtocolError(`Chunked message exceeds maxMessage (${this.maxMessage} bytes)`);
      }
    }
    if (a.got < a.total) return null;

    this.assemblies.delete(c.transferId);
    const out = new Uint8Array(a.bytes);
    let o = 0;
    for (const part of a.parts) {
      out.set(part, o);
      o += part.byteLength;
    }
    return out;
  }

  async _dispatch(msg) {
    if (msg.error !== undefined && !msg.response) throw new ProtocolError('Error flag set on a non-response packet');
    if (msg.response) return this._onResponse(msg);
    if (msg.request) return this._onRequest(msg);

    if (msg.type === 'hello') {
      if (this.role === 'server') return; // a client must never be able to set its own identity
      this.onHello?.(msg);
    }
    await this.emit(msg.type, msg);
  }

  _onResponse(msg) {
    const p = this.pending.get(msg.reqId);
    if (!p) return; // timed out, or lost to hibernation
    this.pending.delete(msg.reqId);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new RequestError(msg.error));
    else if (msg.type !== p.expect) p.reject(new ProtocolError(`Expected a "${p.expect}" reply, got "${msg.type}"`));
    else p.resolve(msg);
  }

  async _onRequest(msg) {
    try {
      const handler = this.handlers.get(msg.type);
      if (!handler) throw new Error(`No handler registered for "${msg.type}"`);
      const result = (await handler(msg, this.ctx)) ?? {};
      if (this.closed) return;
      this._emitPacket(this.codec.def(msg.type).reply, result.fields ?? {}, result.payload, FLAG.RESPONSE, msg.reqId);
    } catch (e) {
      if (this.closed) return;
      try {
        this.sendEncoded(this.codec.encodeError(msg.type, msg.reqId, e?.message ?? e));
      } catch (e2) {
        this.reportError(e2);
      }
    }
  }

  /** Run every listener for `type`. Listener errors are reported, never thrown. */
  async emit(type, ...args) {
    const set = this.listeners.get(type);
    if (!set || !set.size) return;
    await Promise.all(
      [...set].map(async (fn) => {
        try {
          await fn(...args, this.ctx);
        } catch (e) {
          if (type === 'socket:error') console.error('[protocol] error listener threw:', e);
          else this.reportError(e);
        }
      }),
    );
  }

  reportError(err) {
    const set = this.listeners.get('socket:error');
    if (set && set.size) {
      for (const fn of [...set]) {
        try {
          fn(err, this.ctx);
        } catch (e) {
          console.error('[protocol] error listener threw:', e);
        }
      }
    } else {
      console.error('[protocol]', err);
    }
  }

  /** Socket is gone: fail everything outstanding and refuse further sends. */
  closeAll(err = new ConnectionClosedError()) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.assemblies.clear();
    const queued = this._queue;
    this._queue = [];
    for (const q of queued) q.fail(err);
  }
}

export { Codec, ProtocolError, ProtocolVersionError };