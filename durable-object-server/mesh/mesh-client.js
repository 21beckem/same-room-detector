import { AudioCompare } from '../../exports/compare/compare.js';
import { ProtocolClient } from '../src/protocol/client.js';
import { Geo } from './geo.js';
import { Emitter } from './emitter.js';
const isHostedLocally = (/(localhost)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/gm).test(window.location.hostname);
const WebSocketServerUri = isHostedLocally ? `ws://${location.hostname}:8787` : 'wss://same-room-detector.beckersuite.com';

const keepAlive = (() => {
    const keepAwake = new NoSleep();
    function handleBeforeUnload(event) { if (!isHostedLocally) { event.preventDefault(); event.returnValue = ''; } }
    return {
        enable:  () => { keepAwake.enable();  window.addEventListener   ('beforeunload', handleBeforeUnload); },
        disable: () => { keepAwake.disable(); window.removeEventListener('beforeunload', handleBeforeUnload); },
    };
})();

const link = new ProtocolClient(WebSocketServerUri);
const analyzer = await AudioCompare.fromObject({});


/**
 * Browser-facing mesh API.
 *
 * Events include connected, disconnected, serverError/connectionError,
 * tsUpdate, peerAdded, peerRemoved, peersUpdated, audioRequest, audioPacket,
 * relay, relayMessage, relaySending, relaySent, relayMessageSending,
 * relayMessageSent, and relayError.
 */
class MeshClientClass extends Emitter {
    #locationReady = false;
    #audioReady = false;
    #initialized = false;
    #ready = false;
    #connected = false;
    #peers = new Map();

    constructor() {
        super();
        this.#bindLinkEvents();
    }

    #bindLinkEvents() {
        // These are installed in the constructor so short-lived socket events
        // cannot be missed while init() is waiting for the analyzer.
        link.on('socket:open', (details) => {
            this.emit('connecting', {
                ...details,
                url: WebSocketServerUri,
            });
        });
        link.on('socket:error', (error) => {
            const event = { error };
            this.emit('serverError', event);
            this.emit('connectionError', event);
            this.emit('error', event);
        });
        link.on('socket:close', (details) => {
            const wasConnected = this.#connected;
            const wasReady = this.#ready;
            this.#connected = false;
            this.#ready = false;
            this.#audioReady = false;
            this.#locationReady = false;
            keepAlive.disable();

            const hadPeers = this.#peers.size > 0;
            this.#peers.clear();

            this.emit('disconnected', {
                ...details,
                uid: link.uid,
                wasConnected,
                wasReady,
            });
            if (hadPeers) this.emit('peersUpdated', this.peerDetails);
        });

        link.on('tsUpdate', (msg) => {
            const timestamp = msg.fields.ts;
            analyzer.currentTimestampMs = timestamp;
            this.emit('tsUpdate', { timestamp });
        });
        link.handle('audioRequest', async (msg) => {
            this.emit('audioRequest', msg.fields);
            try {
                const packet = analyzer.getLocalPacket();
                const event = {
                    timestamp: packet.timestamp,
                    byteLength: packet.buffer.byteLength,
                };
                this.emit('audioPacket', event);
                return { fields: { ts: packet.timestamp }, payload: packet.buffer };
            } catch (error) {
                const event = { error, fields: msg.fields };
                this.emit('audioError', event);
                console.error('Failed to get local packet:', error);
                throw error;
            }
        });
        link.on('togglePeer', (msg) => {
            const { uid, add, score } = msg.fields;
            const peer = { uid, score, ts: link.now() };
            if (add) {
                this.#peers.set(uid, peer);
                this.emit('peerAdded', peer);
            } else {
                this.#peers.delete(uid);
                this.emit('peerRemoved', peer);
            }
            this.emit('peersUpdated', this.peerDetails);
        });
        link.on('broadcast', (msg) => this.emit('broadcast', msg.fields));

        // These messages are already part of the shared protocol and may be
        // useful to a page even though the current demo does not use them.
        link.on('colocation', (msg) => this.emit('colocation', msg.fields));
        link.on('trigger', (msg) => this.emit('trigger', msg.fields));

        link.handle('relay', async (transfer, ctx) => {
            this.emit('relay', transfer, ctx);
        });
        link.handle('relayMsg', async (transfer, ctx) => {
            this.emit('relayMessage', transfer, ctx);
            // relayMsg is kept as an event alias for callers that use the
            // underlying ProtocolClient name.
            this.emit('relayMsg', transfer, ctx);
        });
    }

    async init() {
        try {
            await link.ready;
        } catch (err) {
            console.error('Failed to initialize MeshClient link:', err);
            this.emit('initError', { stage: 'server-connection', error: err });
            return;
        }

        if (!this.#connected) {
            this.#connected = true;
            this.emit('connected', {
                uid: link.uid,
                base: link.base,
                offset: link.offset,
                serverTime: link.now(),
            });
        }

        try {
            await analyzer.ready();
        } catch (err) {
            console.error('Failed to initialize MeshClient analyzer:', err);
            this.emit('initError', { stage: 'analyzer', error: err });
            return;
        }

        this.#initialized = true;
        this.emit('initialized');
    }
    get peers() { return Array.from(this.#peers.keys()); }
    get peerDetails() { return Array.from(this.#peers.values()).map((peer) => ({ ...peer })); }
    get connected() { return this.#connected; }
    get ready() { return this.#ready; }
    get uid() { return link.uid; }
    get serverTime() { return link.now(); }
    assertInitialized() { if (!this.#initialized) throw new Error('MeshClient is not initialized'); }
    assertReady() { this.assertInitialized(); if (!this.#ready) throw new Error('MeshClient is not ready'); }
    async begin() {
        this.assertInitialized();
        this.emit('starting');
        const [audioResult, locationResult] = await Promise.all([
            this.#beginPipeMicAudio(),
            this.#beginLocation()
        ]);

        this.#audioReady = audioResult.success;
        this.#locationReady = locationResult.success;

        this.emit('audioReady', audioResult);
        this.emit('locationReady', locationResult);

        if (!audioResult.success) {
            const error = new Error('Failed to begin audio stream: ' + audioResult.error);
            this.emit('startError', { stage: 'audio', error, result: audioResult });
            throw error;
        }
        if (!locationResult.success) {
            const error = new Error('Failed to begin location stream: ' + locationResult.error);
            this.emit('startError', { stage: 'location', error, result: locationResult });
            throw error;
        }

        this.#ready = this.#audioReady && this.#locationReady;
        if (this.#ready) {
            const { lat, lng } = locationResult;
            try {
                await link.request('ready', { lat, lng });
            } catch (error) {
                console.error('Failed to send ready message:', error);
                this.emit('startError', { stage: 'server-ready', error });
                throw error;
            }
            this.emit('ready');
        }
        keepAlive.enable();

        return { success: this.#ready };
    }

    /** Send binary data to a peer through the server. */
    async relay(peer, data, options) {
        this.assertReady();
        const event = { peer, data, options };
        this.emit('relaySending', event);
        try {
            const result = await link.relay(peer, data, options);
            this.emit('relaySent', event);
            return result;
        } catch (error) {
            this.emit('relayError', { ...event, error });
            throw error;
        }
    }

    /** Send a JSON-compatible message to a peer through the server. */
    async relayMessage(peer, message, options) {
        this.assertReady();
        const event = { peer, message, options };
        this.emit('relayMessageSending', event);
        try {
            const result = await link.relayMsg(peer, message, options);
            this.emit('relayMessageSent', event);
            return result;
        } catch (error) {
            this.emit('relayError', { ...event, error, isMessage: true });
            throw error;
        }
    }

    // Alias matching ProtocolClient's older method name.
    relayMsg(peer, message, options) {
        return this.relayMessage(peer, message, options);
    }

    /** Close the server connection and stop the keep-alive behavior. */
    disconnect(code, reason) {
        keepAlive.disable();
        link.close(code, reason);
    }

    async broadcast(msgJson) {
        this.assertReady();
        try {
            const result = await link.request('broadcast', { message: msgJson });
            return result;
        } catch (error) {
            console.error('Failed to broadcast message:', error);
            throw error;
        }
    }
    async #beginPipeMicAudio() {
        try {
            await analyzer.pipeMicAudio();
        } catch (error) {
            return { success: false, error };
        }
        try {
            await analyzer.waitForLocalPacket();
        } catch (error) {
            return { success: false, error };
        }
        return { success: true };
    }
    async #beginLocation() {
        let location;
        try {
            location = await Geo.getLocation();
        } catch (error) {
            return { success: false, error };
        }
        return { success: true, ...location };
    }
}

export const MeshClient = new MeshClientClass();
