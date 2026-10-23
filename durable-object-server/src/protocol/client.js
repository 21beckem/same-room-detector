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
import { Codec, ProtocolVersionError } from './codec.js';
import { Endpoint, Router, ConnectionClosedError } from './endpoint.js';

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