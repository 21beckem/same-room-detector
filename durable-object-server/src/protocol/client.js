// protocol/client.js  (browser / frontend side)
//
//   import { ProtocolClient } from './protocol/client.js';
//   const link = new ProtocolClient('wss://example.com/ws');
//   await link.ready;                                   // resolves after the server's `hello`
//   link.on('update', (msg, ctx) => {});
//   link.handle('getData', async (msg) => ({ fields: { slot: msg.fields.slot }, payload: buf }));
//   link.send('begin', { kind: 1 });
//   const reply = await link.request('getData', { slot: 2 });

import { schema as defaultSchema } from './schema.js';
import { Codec, ProtocolVersionError, toBytes } from './codec.js';
import { Endpoint, Router, ConnectionClosedError } from './endpoint.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ProtocolClient extends Router {
  /**
   * @param {string|URL|WebSocket} target  a URL to connect to, or an existing WebSocket
   * @param {{ schema?: object, WebSocket?: Function, strict?: boolean }} [options]
   */
  constructor(target, { schema = defaultSchema, WebSocket: WS = globalThis.WebSocket, strict } = {}) {
    super(new Codec(schema, { strict }));
    this.uid = null; // set by the server's hello
    this.base = 0; // server epoch (ms) that `ts` fields are relative to
    this.offset = 0; // serverClock - localClock, estimated at hello

    const ws = typeof target === 'string' || target instanceof URL ? new WS(String(target)) : target;
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.endpoint = new Endpoint({
      codec: this.codec,
      schema,
      role: 'client',
      send: (buf) => ws.send(buf),
      listeners: this.listeners,
      handlers: this.handlers,
      now: () => this.now(),
      ready: false, // sends are queued until hello arrives
    });
    this.endpoint.ctx.client = this;

    this._relayHandler = null;
    this._relayMsgHandler = null;
    this._incoming = new Map();
    this._xfer = 0;
    this._maxRelay = schema.maxRelay ?? 104_857_600;
    this.handlers.set('relayStart', (msg) => this._relayStart(msg));
    this.handlers.set('relayChunk', (msg) => this._relayChunk(msg));

    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    this.ready.catch(() => {}); // callers who never await it shouldn't see unhandled rejections

    this.endpoint.onHello = ({ fields }) => {
      this.uid = fields.uid;
      this.base = fields.base;
      this.offset = fields.now - Date.now();
      this.endpoint.base = fields.base;
      this.endpoint.ctx.uid = fields.uid;
      this.endpoint.markReady();
      this._resolveReady(this);
    };

    ws.addEventListener('open', () => this.endpoint.emit('socket:open', {}));
    ws.addEventListener('error', (e) => this.endpoint.emit('socket:error', e));
    ws.addEventListener('close', (e) => {
      const err = new ConnectionClosedError(`Connection closed (${e.code}${e.reason ? ': ' + e.reason : ''})`);
      this.endpoint.closeAll(err);
      this._rejectReady(err);
      this.endpoint.emit('socket:close', { code: e.code, reason: e.reason, wasClean: e.wasClean });
    });
    ws.addEventListener('message', (e) => {
      this.endpoint.receive(e.data).catch((err) => {
        this.endpoint.reportError(err);
        if (err instanceof ProtocolVersionError) ws.close(1002, 'Protocol version mismatch');
      });
    });
  }

  handle(type, fn) {
    if (type !== 'relay' && type !== 'relayMsg') return super.handle(type, fn);
    if (typeof fn !== 'function') throw new TypeError('Handler must be a function');
    if (type === 'relayMsg') {
      this._relayMsgHandler = fn;
      return () => { if (this._relayMsgHandler === fn) this._relayMsgHandler = null; };
    } else {
      this._relayHandler = fn;
      return () => { if (this._relayHandler === fn) this._relayHandler = null; };
    }
  }
  
  relayMsg(peer, msg) {
    if (typeof msg !== 'object' || msg === null) throw new TypeError('msg must be an object');
    const arr = textEncoder.encode(JSON.stringify(msg));
    return this.relay(peer, arr, { isMsg: true });
  }

  async relay(peer, data, { meta, chunkSize = 512 * 1024, timeout = 30_000, isMsg = false } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError('chunkSize must be a positive integer');
    const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
    const bytes = isBlob ? null : toBytes(data);
    const size = isBlob ? data.size : bytes.byteLength;
    if (size > this._maxRelay) throw new RangeError(`Relay too large (max ${this._maxRelay} bytes)`);

    if (isBlob && (data.name || data.type)) {
      const auto = { ...(data.name && { name: data.name }), ...(data.type && { type: data.type }) };
      meta = meta && typeof meta === 'object' && !Array.isArray(meta) ? { ...auto, ...meta } : (meta ?? auto);
    }

    const xfer = (this._xfer = (this._xfer + 1) & 0xffff);
    const total = Math.max(1, Math.ceil(size / chunkSize));
    await this.request('relayStart', { peer, xfer, total, size, meta: meta ?? null, isMsg }, { timeout });
    for (let i = 0; i < total; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const slice = isBlob ? new Uint8Array(await data.slice(start, end).arrayBuffer()) : bytes.subarray(start, end);
      await this.request('relayChunk', { peer, xfer, index: i, isMsg }, { payload: slice, timeout });
    }
  }

  _relayStart({ fields }) {
    const isMsg = fields.isMsg ?? false;
    if (isMsg) {
      if (!this._relayMsgHandler) throw new Error('Receiver has no handler for relayMsg');
    } else {
      if (!this._relayHandler) throw new Error('Receiver has no handler for relay');
    }
    if (fields.size > this._maxRelay) throw new Error(`Relay too large (max ${this._maxRelay} bytes)`);
    const now = Date.now();
    for (const [k, t] of this._incoming) if (now - t.t > 60_000) this._incoming.delete(k); // abandoned
    this._incoming.set(`${fields.peer}:${fields.xfer}`, {
      from: fields.peer, total: fields.total, size: fields.size, meta: fields.meta,
      buf: new Uint8Array(fields.size), off: 0, next: 0, t: now,
    });
    return { fields: {} };
  }

  async _relayChunk({ fields, payload }) {
    const key = `${fields.peer}:${fields.xfer}`;
    const t = this._incoming.get(key);
    if (!t) throw new Error('Unknown or expired relay transfer');
    if (fields.index !== t.next || t.off + payload.byteLength > t.size) {
      this._incoming.delete(key);
      throw new Error('Relay chunk out of order or oversized');
    }
    t.buf.set(payload, t.off);
    t.off += payload.byteLength;
    t.next++;
    t.t = Date.now();
    if (t.next === t.total) {
      this._incoming.delete(key);
      if (t.off !== t.size) throw new Error('Relay size mismatch');
      if (fields.isMsg) {
        if (!this._relayMsgHandler) throw new Error('Receiver has no handler for relay');
        let msg;
        try {
          msg = JSON.parse(textDecoder.decode(t.buf));
        } catch (err) {
          throw new Error('Client failed to parse relayMsg JSON: ' + err.message);
        }
        await this._relayMsgHandler({ from: t.from, msg }, this.endpoint.ctx);
      } else {
        if (!this._relayHandler) throw new Error('Receiver has no handler for relay');
        await this._relayHandler({ from: t.from, payload: t.buf, meta: t.meta, size: t.size }, this.endpoint.ctx);
      }
    }
    return { fields: {} };
  }

  /** Current time on the server's clock, in ms (what `ts` fields are expressed in). */
  now() {
    return Date.now() + this.offset;
  }

  send(type, fields, payload) {
    this.endpoint.send(type, fields, payload);
  }

  request(type, fields, opts) {
    return this.endpoint.request(type, fields, opts);
  }

  close(code, reason) {
    this.ws.close(code, reason);
  }
}