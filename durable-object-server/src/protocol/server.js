// protocol/server.js  (Cloudflare Durable Object side, hibernation API)
//
//   import { ProtocolServer } from './protocol/server.js';
//   import { DurableObject } from 'cloudflare:workers';
//
//   export class MyDO extends DurableObject {
//     constructor(state, env) {
//       super(state, env);
//       this.link = new ProtocolServer(state);
//       this.link.on('begin', (msg, ctx) => {
//         this.link.broadcast('update', { uid: ctx.uid, slot: 1 }, null, { except: ctx.uid });
//       });
//     }
//     fetch(request) { return this.link.accept(); }
//     webSocketMessage(ws, data)            { return this.link.handleMessage(ws, data); }
//     webSocketClose(ws, code, reason, ok)  { return this.link.handleClose(ws, code, reason, ok); }
//     webSocketError(ws, err)               { return this.link.handleError(ws, err); }
//   }
//
// Register listeners/handlers in the constructor: after hibernation the constructor runs
// again, which is how they get re-registered. Per-socket state that must survive
// hibernation lives in the socket attachment (uid + base time are stored there; 2 KB max).

import { schema as defaultSchema } from './schema.js';
import { Codec, ProtocolError, ProtocolVersionError } from './codec.js';
import { Endpoint, Router } from './endpoint.js';

const RESERVED = new Set(['uid', 'base']);

export class ProtocolServer extends Router {
  /**
   * @param {DurableObjectState} state
   * @param {{ schema?: object, strict?: boolean }} [options]
   */
  constructor(state, { schema = defaultSchema, strict } = {}) {
    super(new Codec(schema, { strict }));
    this.state = state;
    this.schema = schema;
    this._eps = new WeakMap(); // ws -> Endpoint (rebuilt lazily after hibernation)
    
    const maxRelay = schema.maxRelay ?? 104_857_600;
    this.handlers.set('relayStart', async (msg, ctx) => {
      const { peer, ...rest } = msg.fields;
      if (rest.size > maxRelay) throw new Error(`Relay too large (max ${maxRelay} bytes)`);
      await this.request(peer, 'relayStart', { ...rest, peer: ctx.uid }, { timeout: 30_000 });
      return { fields: {} };
    });
    this.handlers.set('relayChunk', async (msg, ctx) => {
      const { peer, ...rest } = msg.fields;
      await this.request(peer, 'relayChunk', { ...rest, peer: ctx.uid }, { payload: msg.payload, timeout: 30_000 });
      return { fields: {} };
    });
  }

  // ----- connections ------------------------------------------------------

  /** Call from fetch(). Accepts the upgrade and returns the 101 Response. */
  accept(req, options) {
    const ip = req.headers.get('CF-Connecting-IP');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.attach(server, { ...options, ip });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Register an already-created server-side socket: assigns a uid and sends `hello`. */
  attach(ws, { tags, ip } = {}) {
    const used = new Set();
    for (const w of this.state.getWebSockets()) {
      const uid = w.deserializeAttachment()?.uid;
      if (uid) used.add(uid);
    }
    let uid;
    do uid = crypto.getRandomValues(new Uint32Array(1))[0];
    while (uid === 0 || used.has(uid)); // 0 is reserved for "the server"

    const base = Date.now();
    this.state.acceptWebSocket(ws, tags);
    ws.serializeAttachment({ uid, base, ip });

    const ep = this._endpoint(ws);
    ep.send('hello', { uid, base, now: Date.now() });
    ep.emit('socket:open', { ws, uid });
    return uid;
  }

  _endpoint(ws) {
    let ep = this._eps.get(ws);
    if (ep) return ep;
    const att = ws.deserializeAttachment();
    if (!att || !att.uid) throw new Error('Socket was not accepted through ProtocolServer.accept()/attach()');
    ep = new Endpoint({
      codec: this.codec,
      schema: this.schema,
      role: 'server',
      send: (buf) => ws.send(buf),
      listeners: this.listeners,
      handlers: this.handlers,
      base: att.base,
    });
    ep.uid = att.uid;
    Object.assign(ep.ctx, { ws, uid: att.uid, server: this });
    this._eps.set(ws, ep);
    return ep;
  }

  /** Resolve a uid or a ws to its Endpoint. */
  _target(target) {
    if (typeof target === 'number') {
      for (const ws of this.state.getWebSockets()) {
        const ep = this._endpoint(ws);
        if (ep.uid === target) return ep;
      }
      throw new Error(`No connected client with uid ${target}`);
    }
    return this._endpoint(target);
  }

  /** All live connections as { ws, uid }. */
  get sockets() {
    return this.state.getWebSockets().map((ws) => ({ ws, uid: this._endpoint(ws).uid }));
  }
  getSocket(uid) {
    return this.sockets.find((s) => s.uid === uid)?.ws;
  }

  has(uid) {
    return this.sockets.some((s) => s.uid === uid);
  }

  /** Read your own data from the attachment (uid/base are included). */
  getAttachment(ws) {
    return ws.deserializeAttachment();
  }

  /** Merge extra data into the attachment without clobbering uid/base. Keep it under ~2 KB. */
  updateAttachment(ws, patch) {
    for (const k of Object.keys(patch)) if (RESERVED.has(k)) throw new Error(`"${k}" is reserved by the protocol`);
    ws.serializeAttachment({ ...ws.deserializeAttachment(), ...patch });
  }

  close(target, code = 1000, reason = '') {
    this._target(target).ctx.ws.close(code, reason);
  }

  // ----- messaging --------------------------------------------------------

  /** @param {number|WebSocket} target  a client's uid or its socket */
  send(target, type, fields, payload) {
    this._target(target).send(type, fields, payload);
  }

  /** Request/response to one client. Same options as the client's request(). */
  request(target, type, fields, opts) {
    try {
      return this._target(target).request(type, fields, opts);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /**
   * Send to every connected client if `to` is not specified, otherwise only to the clients listed in `to`.
   * @param {{ to?:Array<number|WebSocket>, except?: number|WebSocket|Array<number|WebSocket> }} [opts]
   * @returns {number} how many clients it was sent to
   */
  broadcast(type, fields = {}, payload, { to=null, except } = {}) {
    const skip = new Set([].concat(except ?? []).map((x) => (typeof x === 'number' ? x : this._endpoint(x).uid)));
    const def = this.codec.def(type);
    // With no `ts` fields every client gets identical bytes, so encode just once.
    const shared = def.hasTs ? null : this.codec.encode(type, fields, payload, { now: Date.now() });
    let n = 0;
    for (const ws of this.state.getWebSockets()) {
      let ep;
      try {
        ep = this._endpoint(ws);
      } catch {
        continue;
      }
      if (ep.closed || skip.has(ep.uid)) continue;
      if (to && !to.includes(ep.uid)) continue;
      try {
        if (shared) ep.sendEncoded(shared);
        else ep.send(type, fields, payload);
        n++;
      } catch (e) {
        ep.reportError(e);
      }
    }
    return n;
  }

  // ----- Durable Object event forwarding ---------------------------------

  /** Call from webSocketMessage(ws, data). Await it so handlers finish before the DO idles. */
  async handleMessage(ws, data) {
    let ep;
    try {
      ep = this._endpoint(ws);
      await ep.receive(data);
    } catch (err) {
      if (ep) ep.reportError(err);
      else console.error('[protocol]', err);
      if (err instanceof ProtocolVersionError) {
        try {
          ws.close(1002, 'Protocol version mismatch');
        } catch {}
      }
    }
  }

  /** Call from webSocketClose(). Fails that client's in-flight requests. */
  async handleClose(ws, code, reason, wasClean) {
    let ep;
    try {
      ep = this._endpoint(ws);
    } catch {
      return;
    }
    ep.closeAll();
    await ep.emit('socket:close', { code, reason, wasClean });
  }

  /** Call from webSocketError(). */
  async handleError(ws, error) {
    try {
      await this._endpoint(ws).emit('socket:error', error);
    } catch {
      console.error('[protocol]', error);
    }
  }
}

export { ProtocolError };