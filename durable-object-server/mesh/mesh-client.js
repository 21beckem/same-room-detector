import { AudioCompare } from '../../exports/compare/compare.js';
import { ProtocolClient } from '../src/protocol/client.js';
import { Geo } from './geo.js';
import { Emitter } from './emitter.js';
const isHostedLocally = (/(localhost)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/gm).test(window.location.hostname);
const WebSocketServerUri = isHostedLocally ? `ws://${location.hostname}:8787` : 'wss://colocation.beckersuite.com';

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


class MeshClientClass extends Emitter {
    #locationReady = false;
    #audioReady = false;
    #initialized = false;
    #ready = false;
    #peers = new Map();
    async init() {
        try {
            await link.ready;
        } catch (err) {
            console.error('Failed to initialize MeshClient link:', err);
            return;
        }
        try {
            await analyzer.ready();
        } catch (err) {
            console.error('Failed to initialize MeshClient analyzer:', err);
            return;
        }

        link.on('tsUpdate', (msg, ctx) => {
            console.log('tsUpdate received:', msg.fields.ts);
            analyzer.currentTimestampMs = msg.fields.ts;
        });
        link.handle('audioRequest', async (msg, ctx) => {
            this.emit('audioRequest', msg.fields);
            console.log('got audioRequest');
            try {
                const packet = analyzer.getLocalPacket();
                return { fields: { ts: packet.timestamp }, payload: packet.buffer };
            } catch (err) {
                console.error('Failed to wait for local packet:', err);
            }
        });
        link.on('togglePeer', (msg, ctx) => {
            console.log('togglePeer message received:', msg.fields);
            if (msg.fields.add) {
                this.#peers.set(msg.fields.uid, {
                    ts: link.now(),
                    score: msg.fields.score
                });
                this.emit('peerAdded', msg.fields);
            } else {
                this.#peers.delete(msg.fields.uid);
                this.emit('peerRemoved', msg.fields);
            }
            this.emit('peersUpdated');
        });

        this.#initialized = true;
    }
    get peers() { return Array.from(this.#peers.keys()); }
    assertInitialized() { if (!this.#initialized) throw new Error('MeshClient is not initialized'); }
    assertReady() { this.assertInitialized(); if (!this.#ready) throw new Error('MeshClient is not ready'); }
    async begin() {
        this.assertInitialized();
        const [audioResult, locationResult] = await Promise.all([
            this.#beginPipeMicAudio(),
            this.#beginLocation()
        ]);

        this.#audioReady = audioResult.success;
        this.#locationReady = locationResult.success;

        if (!audioResult.success)
            throw new Error('Failed to begin audio stream: ' + audioResult.error);
        if (!locationResult.success)
            throw new Error('Failed to begin location stream: ' + locationResult.error);

        this.#ready = this.#audioReady && this.#locationReady;
        if (this.#ready) {
            const { lat, lng } = locationResult;
            try {
                await link.request('ready', { lat, lng });
            } catch (error) {
                console.error('Failed to send ready message:', error);
                throw error;
            }
            this.emit('ready');
        }
        keepAlive.enable();

        return { success: this.#ready };
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