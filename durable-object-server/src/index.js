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

		this.link.handle('ready', (msg, ctx) => {
			const { lat, lng } = msg.fields;
			const gridKey = this._getGridKey(lat, lng);
			if (!this.geoGrid.has(gridKey))
				this.geoGrid.set(gridKey, new Set());
			this.geoGrid.get(gridKey).add(ctx.uid);

			this.link.updateAttachment(ctx.ws, {
				lat, lng, gridKey,
				peers: [],
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
		console.log(`Discovered ${attachments.length} attachments`);
		const readyPeers = attachments.filter((p) => p.ready);
		console.log(`Found ${readyPeers.length} ready peers for colocation discovery`);
		if (readyPeers.length < 2) {
			setTimeout(() => this.discover(), 5_000);
			return;
		}

		const testedPairs = new Set();
		const beenTested = (uid1, uid2) => testedPairs.has([uid1, uid2].sort().join('-'));
		const markTested = (uid1, uid2) => testedPairs.add([uid1, uid2].sort().join('-'));

		const promises = [];

		for (const peer of readyPeers) {
			const possibleNeighbors = this._findPossibleNeighbors(peer.gridKey, readyPeers);
			
			promises.push(Promise.all(possibleNeighbors.map(async (other) => {
				const { score } = await (async()=>{
					if (peer.uid === other.uid) return { other, score: null };
					if (beenTested(peer.uid, other.uid)) {
						return { other, score: null };
					}
					console.log(`Comparing audio packets between:`, peer.uid, other.uid);
					markTested(peer.uid, other.uid);
					const score = await this._compare(
						this.link.getSocket(peer.uid),
						this.link.getSocket(other.uid)
					);
					return { other, score };
				})();
				
				try {
					if (score === null || score === undefined) return;
					if (score < MIN_SCORE) {
						if (peer.peers.includes(other.uid)) {
							this.link.send(peer.ws, 'togglePeer', { score, uid: other.uid, add: false });
							peer.peers = peer.peers.filter(uid => uid !== other.uid);
						}
						if (other.peers.includes(peer.uid)) {
							this.link.send(other.ws, 'togglePeer', { score, uid: peer.uid, add: false });
							other.peers = other.peers.filter(uid => uid !== peer.uid);
						}
					} else {
						if (!peer.peers.includes(other.uid)) {
							this.link.send(peer.ws, 'togglePeer', { score, uid: other.uid, add: true });
							peer.peers.push(other.uid);
						}
						if (!other.peers.includes(peer.uid)) {
							this.link.send(other.ws, 'togglePeer', { score, uid: peer.uid, add: true });
							other.peers.push(peer.uid);
						}
					}
				} catch (error) {
					console.error('Failed to send togglePeer to peer:', error);
				}
				return { peer, other, score };
			})));
			const scores = (await Promise.all(promises.flat(1)));
		}
		
		setTimeout(() => this.discover(), 5_000);
	}
	async _compare(client1Ws, client2Ws) {
		let [res1, res2] = await Promise.all([
			this.link.request(client1Ws, 'audioRequest', { }),
			this.link.request(client2Ws, 'audioRequest', { }),
		]);
		if (!res1 || !res2) {
			console.log('Failed to get audio packets in time');
			return;
		}
		if (Math.abs(res1.fields.ts - res2.fields.ts) > 2_000) {
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
		
		return Math.sqrt(Math.pow(lat1 - oLat, 2) + Math.pow(lng1 - oLng, 2));
	}
	fetch(req) { return this.link.accept(req); }
	webSocketMessage(ws, data) { return this.link.handleMessage(ws, data); }
	webSocketClose(ws, code, reason, ok) { return this.link.handleClose(ws, code, reason, ok); }
	webSocketError(ws, err) { return this.link.handleError(ws, err); }
}

export default {
	async fetch(request, env) {
		if (request.url.endsWith('/health')) {
			return new Response('OK', { status: 200 });
		}
		const url = new URL(request.url);
		const id = env.MY_DURABLE_OBJECT.idFromName(url.pathname || '/');
		return env.MY_DURABLE_OBJECT.get(id).fetch(request);
	},
};