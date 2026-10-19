import { DurableObject } from 'cloudflare:workers';
import loader from '@assemblyscript/loader';
import sameRoomModel from './same_room.wasm';
import model from './model.json';

let wasmInstancePromise;
function getWasmInstance() {
	wasmInstancePromise ??= loader.instantiate(sameRoomModel, {}).then(({ exports }) => {
		const config = model.config;
		exports.configure(
			model.intercept,
			model.mean[0],
			model.mean[1],
			model.std[0],
			model.std[1],
			model.coef[0],
			model.coef[1],
			config.window_sec,
			config.hop_sec,
			config.max_lag,
			config.min_sec,
		);
		return exports;
	});
	return wasmInstancePromise;
}


function niceJSONParse(str) {
	try {
		return JSON.parse(str);
	} catch (error) {
		console.error('Failed to parse JSON:', error);
		return null;
	}
}

async function compareAudioPackets(first, second) {
	if (!(first instanceof ArrayBuffer) || !(second instanceof ArrayBuffer)) {
		throw new Error('Both arguments must be ArrayBuffers');
	}

	const wasm = await getWasmInstance();
	let firstHandle;
	let secondHandle;
	try {
		firstHandle = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, new Uint8Array(first)));
		secondHandle = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, new Uint8Array(second)));
		return wasm.compareDevices(firstHandle, secondHandle);
	} finally {
		if (firstHandle !== undefined) wasm.releaseDevice(firstHandle);
		if (secondHandle !== undefined) wasm.releaseDevice(secondHandle);
		wasm.__collect();
	}
}

export class WebSocketServer extends DurableObject {
	async fetch(request) {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade request.', { status: 426 });
		}

		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);
		const clientId = crypto.randomUUID();

		server.serializeAttachment({ clientId, audioPacket: null });

		// Calling `acceptWebSocket()` connects the WebSocket to the Durable Object, allowing the WebSocket to send and receive messages.
		// Unlike `ws.accept()`, `state.acceptWebSocket(ws)` allows the Durable Object to be hibernated
		// When the Durable Object receives a message during Hibernation, it will run the `constructor` to be re-initialized
		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify({ type: 'connected', id: clientId }));

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws, message) {
		const attachment = ws.deserializeAttachment() ?? {};

		// if message is binary data
		if (message instanceof ArrayBuffer) {
			ws.serializeAttachment({ ...attachment, audioPacket: message });
			return;
		}

		// else convert to JSON
		if (typeof message !== 'string') return;
		const msg = niceJSONParse(message);
		if (!msg || typeof msg !== 'object') return;

		if (msg.type === 'compare') {
			if (typeof msg.with !== 'string') return;

			if (msg.with === attachment.clientId) {
				ws.send(JSON.stringify({ type: 'compare', error: 'Cannot compare with self' }));
				return;
			}

			if (!(attachment.audioPacket instanceof ArrayBuffer)) {
				ws.send(JSON.stringify({ type: 'compare', error: 'No audio packet received yet' }));
				return;
			}

			const otherSocket = this.ctx
				.getWebSockets()
				.find((socket) => socket.deserializeAttachment()?.clientId === msg.with);
			if (!otherSocket) {
				ws.send(JSON.stringify({ type: 'compare', error: 'Other client not found' }));
				return;
			}

			const otherAttachment = otherSocket.deserializeAttachment();
			if (!(otherAttachment?.audioPacket instanceof ArrayBuffer)) {
				ws.send(JSON.stringify({ type: 'compare', error: 'Other client has no audio packet' }));
				return;
			}

			const result = await compareAudioPackets(attachment.audioPacket, otherAttachment.audioPacket);
			ws.send(JSON.stringify({
				type: 'compare',
				result,
				clients: [attachment.clientId, otherAttachment.clientId],
			}));
		}
	}

	async webSocketClose(ws, code, reason, wasClean) {
		// With web_socket_auto_reply_to_close (compat date >= 2026-04-07), the runtime
		// auto-replies to Close frames. Calling close() is safe but no longer required.
		ws.close(code, reason);
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const id = env.MY_DURABLE_OBJECT.idFromName(url.pathname || '/');
		return env.MY_DURABLE_OBJECT.get(id).fetch(request);
	},
};