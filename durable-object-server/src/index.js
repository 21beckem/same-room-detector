import { DurableObject } from 'cloudflare:workers';
import { compareAudioPackets } from './wasm.js';
import { ProtocolServer } from './protocol/server.js';
import modelJson from './model.json' with { type: 'json' };

const MIN_SCORE = 0.6;

export class WebSocketServer extends DurableObject {
	constructor(state, env) {
		super(state, env);
		this.link = new ProtocolServer(state);
		if (this.tsUpdateId) clearInterval(this.tsUpdateId);
		this.tsUpdateId = setInterval(() => {
			this.link.broadcast('tsUpdate', { ts: Date.now() });
		}, modelJson.config.min_sec * 1000);

		this.geoGrid = new Map(); // key: `${lat}_${lng}`, value: Set of uid

		this.link.on('socket:open', ({ ws, uid }) => this._registerNewClient(ws, uid));

		this.link.on('location', (msg, ctx) => {
			const { lat, lng } = msg.fields;
			const gridKey = this._getGridKey(lat, lng);
			if (!this.geoGrid.has(gridKey))
				this.geoGrid.set(gridKey, new Set());
			this.geoGrid.get(gridKey).add(ctx.uid);

			this.link.updateAttachment(ctx.ws, {
				lat, lng, gridKey,
				neighbors: [],
				ready: true
			});
		});

		this.discover();
	}
	_registerNewClient(ws, uid) {
		const { ip } = this.link.getAttachment(ws);
		console.log(`Client ${uid} connected from IP ${ip}`);
	}
	_getGridKey(lat, lng) {
		const latKey = Math.round(lat * 100) / 100;
		const lngKey = Math.round(lng * 100) / 100;
		return `${latKey}_${lngKey}`;
	}
	_findPossibleNeighbors(gridKey, allSockets) {
		const [latStr, lngStr] = gridKey.split('_');
		const lat = parseFloat(latStr);
		const lng = parseFloat(lngStr);
		const closeUids = [];
		for (let dLat = -0.01; dLat <= 0.01; dLat += 0.01) {
			for (let dLng = -0.01; dLng <= 0.01; dLng += 0.01) {
				const neighborKey = this._getGridKey(lat + dLat, lng + dLng);
				if (this.geoGrid.has(neighborKey)) {
					closeUids.push(...this.geoGrid.get(neighborKey));
				}
			}
		}
		return allSockets.filter(s => closeUids.includes(s.uid));
	}
	async discover() {
		const attachments = this.link.sockets.map((s) => ({
			uid: s.uid,
			ws: s.ws,
			...this.link.getAttachment(s.ws),
		}));
		const readyPeers = attachments.filter((p) => p.ready);
		console.log(`Found ${readyPeers.length} ready peers for colocation discovery`);
		if (readyPeers.length < 2) {
			setTimeout(() => this.discover(), 5_000);
			return;
		}

		const testedPairs = new Set();

		for (const peer of readyPeers) {
			const possibleNeighbors = this._findPossibleNeighbors(peer.gridKey, readyPeers);
			
			const scores = await Promise.all(possibleNeighbors.map(async (other) => {
				if (testedPairs.has([peer.uid, other.uid].sort().join('-'))) {
					return { other, score: null };
				}
				if (peer.uid === other.uid) return { other, score: null };
				console.log(`Comparing audio packets between:`, peer, other);
				const score = await this._compare(
					this.link.getSocket(peer.uid),
					this.link.getSocket(other.uid)
				);
				testedPairs.add(
					[peer.uid, other.uid].sort().join('-')
				);
				return { other, score };
			}));
			console.log(`Scores for peers ${peer.uid}, :`, scores.map(s => ({ other: s.other.uid, score: s.score })));

			for (const { other, score } of scores) {
				if (score === null || score === undefined) continue;
				// if (score >= MIN_SCORE) {
				this.link.send(peer.ws, 'colocation', { score, peer: other.uid });
				this.link.send(other.ws, 'colocation', { score, peer: peer.uid });
				// }
			}
		}
		
		setTimeout(() => this.discover(), 5_000);
	}
	async _compare(client1Ws, client2Ws) {
		let [res1, res2] = await Promise.all([
			this.link.request(client1Ws, 'audioRequest', { }),
			this.link.request(client2Ws, 'audioRequest', { }),
		]);

		if (Math.abs(res1.fields.ts - res2.fields.ts) > 2000) {
			// audio packets are too far apart in time to be meaningfully compared
			// this may be because one of the clients wasn't ready when we first requested
			// try one more time
			[res1, res2] = await Promise.all([
				this.link.request(client1Ws, 'audioRequest', { }),
				this.link.request(client2Ws, 'audioRequest', { }),
			]);
			if (Math.abs(res1.fields.ts - res2.fields.ts) > 2000) {
				console.log('Audio packets are too far apart in time');
				return;
			}
		}

		return compareAudioPackets(res1.payload, res2.payload);
	}
	_distance(lat1, lng1, otherAttachment) {
		const oLat = otherAttachment.lat;
		const oLng = otherAttachment.lng;
		if (oLat === undefined || oLng === undefined) return Infinity;
		
		return Math.sqrt(Math.pow(lat - oLat, 2) + Math.pow(lng - oLng, 2));
	}
	fetch(req) { return this.link.accept(req); }
	webSocketMessage(ws, data) { return this.link.handleMessage(ws, data); }
	webSocketClose(ws, code, reason, ok) { return this.link.handleClose(ws, code, reason, ok); }
	webSocketError(ws, err) { return this.link.handleError(ws, err); }
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const id = env.MY_DURABLE_OBJECT.idFromName(url.pathname || '/');
		return env.MY_DURABLE_OBJECT.get(id).fetch(request);
	},
};