import { DurableObject } from 'cloudflare:workers';
import { compareAudioPackets } from './wasm.js';
import { ProtocolServer } from './protocol/server.js';
import modelJson from './model.json' with { type: 'json' };

export class WebSocketServer extends DurableObject {
	constructor(state, env) {
		super(state, env);
		this.link = new ProtocolServer(state);
		if (this.tsUpdateId) clearInterval(this.tsUpdateId);
		this.tsUpdateId = setInterval(() => {
			this.link.broadcast('tsUpdate', { ts: Date.now() });
		}, modelJson.config.min_sec * 1000);

		this.link.on('socket:open', ({ ws, uid }) => {
			const { ip } = this.link.getAttachment(ws);
			console.log(`Client ${uid} connected from IP ${ip}`);

			setTimeout(async () => {
				const startMs = performance.now();
				const res = await this.link.request(ws, 'getLocation', {}, { timeout: 10_000 });
				const endMs = performance.now();
				console.log(`Client ${uid} location request took ${endMs - startMs} ms`);
				this.link.updateAttachment(ws, { lat: res.fields.lat, lng: res.fields.lng });
			}, 500);
		});

		this.link.handle('getNearbyPeers', async (msg, ctx) => {
			const { options } = msg.fields;
			const except = new Set(options?.except || []);
			const { lat, lng } = this.link.getAttachment(ctx.ws);
			if (lat === undefined || lng === undefined) {
				console.log(`Client ${ctx.uid} has no location data. Cannot find nearby peers.`);
				return { fields: { peers: [] } };
			}
			function calculateDistance(otherAttachment) {
				const oLat = otherAttachment.lat;
				const oLng = otherAttachment.lng;
				if (oLat === undefined || oLng === undefined) return Infinity;
				
				return Math.sqrt(Math.pow(lat - oLat, 2) + Math.pow(lng - oLng, 2));
			}
			const nearbyPeers = [];
			// TODO: Implement logic to find nearby peers based on location and options
			for (const socket of this.link.sockets) {
				if (socket.ws === ctx.ws) continue; // Skip self
				if (except.has(socket.uid)) continue;
				const distance = calculateDistance(this.link.getAttachment(socket.ws));
				if (distance < 0.01) { // Example threshold for "nearby"
					console.log(`Client ${ctx.uid} is near client ${socket.uid} (distance: ${distance})`);
					nearbyPeers.push(socket.uid);
				}
			}
			return { fields: { peers: nearbyPeers } };
		});

		this.link.on('trigger', async (msg, ctx) => {
			if (this.link.sockets.length < 2) {
				console.log('Not enough clients connected to trigger colocation');
				return;
			}
			const [client1, client2] = this.link.sockets;
			let [res1, res2] = await Promise.all([
				this.link.request(client1.ws, 'audioRequest', { }),
				this.link.request(client2.ws, 'audioRequest', { }),
			]);

			if (Math.abs(res1.fields.ts - res2.fields.ts) > 2000) {
				// audio packets are too far apart in time to be meaningfully compared
				// this may be because one of the clients wasn't ready when we first requested
				// try one more time
				[res1, res2] = await Promise.all([
					this.link.request(client1.ws, 'audioRequest', { }),
					this.link.request(client2.ws, 'audioRequest', { }),
				]);
				if (Math.abs(res1.fields.ts - res2.fields.ts) > 2000) {
					console.log('Audio packets are too far apart in time');
					return;
				}
			}

			const score = await compareAudioPackets(res1.payload, res2.payload);
			this.link.send(client1.ws, 'colocation', { score, peer: client2.uid });
			this.link.send(client2.ws, 'colocation', { score, peer: client1.uid });
		});
	}
	fetch(req) { return this.link.accept(req); }
	webSocketMessage(ws, data) { return this.link.handleMessage(ws, data); }
	webSocketClose(ws, code, reason, ok) { return this.link.handleClose(ws, code, reason, ok); }
	webSocketError(ws, err) { return this.link.handleError(ws, err); }
}





// async function handleCompareRequest(ws, msg) {
// 	if (typeof msg.with !== 'string') return;

// 	if (msg.with === attachment.clientId) {
// 		ws.send(JSON.stringify({ type: 'compare', error: 'Cannot compare with self' }));
// 		return;
// 	}

// 	const otherSocket = this.ctx
// 		.getWebSockets()
// 		.find((socket) => socket.deserializeAttachment()?.clientId === msg.with);
// 	if (!otherSocket) {
// 		ws.send(JSON.stringify({ type: 'compare', error: 'Other client not found' }));
// 		return;
// 	}

// 	const result = await compareAudioPackets(attachment.audioPacket, otherAttachment.audioPacket);
// 	const output = JSON.stringify({
// 		type: 'compare',
// 		result,
// 		clients: [attachment.clientId, otherAttachment.clientId],
// 	});
// 	ws.send(output);
// 	otherSocket.send(output);
// }

// export class WebSocketServer extends DurableObject {
// 	async fetch(request) {
// 		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
// 			return new Response('Expected a WebSocket upgrade request.', { status: 426 });
// 		}

// 		// Creates two ends of a WebSocket connection.
// 		const webSocketPair = new WebSocketPair();
// 		const [client, server] = Object.values(webSocketPair);
// 		const clientId = crypto.randomUUID();

// 		server.serializeAttachment({ clientId, audioPacket: null });

// 		// Calling `acceptWebSocket()` connects the WebSocket to the Durable Object, allowing the WebSocket to send and receive messages.
// 		// Unlike `ws.accept()`, `state.acceptWebSocket(ws)` allows the Durable Object to be hibernated
// 		// When the Durable Object receives a message during Hibernation, it will run the `constructor` to be re-initialized
// 		this.ctx.acceptWebSocket(server);
// 		server.send(JSON.stringify({ type: 'connected', id: clientId }));

// 		return new Response(null, {
// 			status: 101,
// 			webSocket: client,
// 		});
// 	}

// 	async webSocketMessage(ws, message) {
// 		const attachment = ws.deserializeAttachment() ?? {};

// 		// if message is binary data
// 		if (message instanceof ArrayBuffer) {
// 			ws.serializeAttachment({ ...attachment, audioPacket: message });
// 			return;
// 		}

// 		// else convert to JSON
// 		if (typeof message !== 'string') return;
// 		const msg = niceJSONParse(message);
// 		if (!msg || typeof msg !== 'object') return;

// 		if (msg.requestId && awaitingResults.has(msg.requestId)) {
// 			const resolve = awaitingResults.get(msg.requestId);
// 			resolve(msg);
// 			awaitingResults.delete(msg.requestId);
// 		}

// 		if (msg.type === 'compare') {
// 			handleCompareRequest(ws, msg);
// 		}
// 	}

// 	async webSocketClose(ws, code, reason, wasClean) {
// 		// With web_socket_auto_reply_to_close (compat date >= 2026-04-07), the runtime
// 		// auto-replies to Close frames. Calling close() is safe but no longer required.
// 		ws.close(code, reason);
// 	}
// }

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const id = env.MY_DURABLE_OBJECT.idFromName(url.pathname || '/');
		return env.MY_DURABLE_OBJECT.get(id).fetch(request);
	},
};