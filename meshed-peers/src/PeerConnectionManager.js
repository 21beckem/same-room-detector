import Peer from "peerjs";
import { EventEmitter } from "./EventEmitter.js";

const AUDIO_CHUNK_MAGIC = 0x4d504331; // "MPC1"
const AUDIO_CHUNK_HEADER_BYTES = 20;
const AUDIO_CHUNK_PAYLOAD_BYTES = 64 * 1024;
const MAX_AUDIO_CHUNKS = 2048;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const AUDIO_HIGH_WATER_BYTES = 512 * 1024;
const AUDIO_PUMP_DELAY_MS = 25;

function asArrayBuffer(payload) {
  if (payload instanceof ArrayBuffer) return payload;
  if (ArrayBuffer.isView(payload)) {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }
  return null;
}

export class PeerConnectionManager extends EventEmitter {
  constructor({ PeerClass = Peer, options = {}, connectionTimeoutMs = 25_000 } = {}) {
    super();
    this.PeerClass = PeerClass;
    this.options = options;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.peer = null;
    this.sessions = new Map();
    this.nextAudioMessageId = 1;
  }

  async start() {
    if (this.peer) return this.peer.id;
    this.peer = new this.PeerClass(undefined, this.options);
    this.peer.on("connection", (connection) => this.attachData(connection));
    this.peer.on("error", (error) => this.emit("error", error));
    this.peer.on("disconnected", () => this.emit("disconnected"));
    this.peer.on("close", () => this.emit("closed"));
    return new Promise((resolve, reject) => {
      const onOpen = (id) => {
        cleanup();
        resolve(id);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.peer?.off?.("open", onOpen);
        this.peer?.off?.("error", onError);
      };
      this.peer.on("open", onOpen);
      this.peer.on("error", onError);
    });
  }

  get id() {
    return this.peer?.id || null;
  }

  attachData(connection) {
    const session = this.getOrCreateSession(connection.peer);
    const isAudio = connection.metadata?.meshedPeersChannel === "audio";
    const slot = isAudio ? "audioData" : "data";
    if (session[slot] && session[slot] !== connection) session[slot].close();
    session[slot] = connection;
    if (isAudio) {
      connection.on("open", () => {
        if (this.sessions.get(session.peerId) !== session) return;
        session.audioDataOpen = true;
        this.pumpAudioQueue(session);
        this.emit("audio-ready", session.peerId);
      });
      connection.on("data", (payload) => {
        this.receiveAudioPayload(session, payload).catch((error) => this.emit("audio-error", session.peerId, error));
      });
      connection.on("close", () => {
        if (session.audioData !== connection) return;
        session.audioData = null;
        session.audioDataOpen = false;
        session.audioChunks.clear();
        if (session.audioPumpTimer) clearTimeout(session.audioPumpTimer);
        session.audioPumpTimer = null;
        session.audioPumpPromise = null;
        this.closeIfCurrent(session, "audio-data-closed");
      });
      connection.on("error", (error) => this.emit("audio-error", session.peerId, error));
      return session;
    }
    connection.on("open", () => {
      if (this.sessions.get(session.peerId) !== session) return;
      session.dataOpen = true;
      this.maybeReady(session);
    });
    connection.on("data", (message) => this.emit("data", session.peerId, message));
    connection.on("error", (error) => this.emit("session-error", session.peerId, error));
    connection.on("close", () => this.closeIfCurrent(session, "data-closed"));
    return session;
  }

  getOrCreateSession(peerId) {
    let session = this.sessions.get(peerId);
    if (!session) {
      session = {
        peerId,
        data: null,
        audioData: null,
        audioQueue: [],
        audioChunks: new Map(),
        audioPumpTimer: null,
        audioPumpPromise: null,
        dataOpen: false,
        audioDataOpen: false,
        ready: false,
      };
      this.sessions.set(peerId, session);
    }
    return session;
  }

  maybeReady(session) {
    if (session.ready || !session.dataOpen) return;
    session.ready = true;
    this.emit("ready", session);
  }

  async connect(peerId) {
    if (!this.peer?.open) throw new Error("PeerJS client is not open");
    const session = this.getOrCreateSession(peerId);
    if (!session.data) this.attachData(this.peer.connect(peerId, { reliable: true, serialization: "json" }));
    if (!session.audioData) {
      this.attachData(this.peer.connect(peerId, {
        reliable: true,
        serialization: "binary",
        metadata: { meshedPeersChannel: "audio" },
      }));
    }
    if (session.ready) return session;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribeReady();
        unsubscribeError();
        reject(new Error(`Timed out connecting to ${peerId}`));
      }, this.connectionTimeoutMs);
      const unsubscribeReady = this.on("ready", (readySession) => {
        if (readySession !== session) return;
        clearTimeout(timer);
        unsubscribeReady();
        unsubscribeError();
        resolve(session);
      });
      const unsubscribeError = this.on("session-error", (failedPeerId, error) => {
        if (failedPeerId !== peerId) return;
        clearTimeout(timer);
        unsubscribeReady();
        unsubscribeError();
        reject(error);
      });
    });
  }

  send(peerId, message) {
    const session = this.sessions.get(peerId);
    if (!session?.dataOpen || !session.data?.open) throw new Error(`Peer ${peerId} is not ready for messages`);
    session.data.send(message);
  }

  sendAudio(peerId, payload) {
    const session = this.sessions.get(peerId);
    if (!session) throw new Error(`Peer ${peerId} is not connected`);
    const buffer = asArrayBuffer(payload);
    if (!buffer) throw new Error("Audio payload must be an ArrayBuffer or typed-array view");
    const messageId = this.nextAudioMessageId++;
    const chunks = [];
    for (let offset = 0; offset < buffer.byteLength; offset += AUDIO_CHUNK_PAYLOAD_BYTES) {
      const payloadBytes = Math.min(AUDIO_CHUNK_PAYLOAD_BYTES, buffer.byteLength - offset);
      const chunk = new ArrayBuffer(AUDIO_CHUNK_HEADER_BYTES + payloadBytes);
      const header = new DataView(chunk, 0, AUDIO_CHUNK_HEADER_BYTES);
      header.setUint32(0, AUDIO_CHUNK_MAGIC, true);
      header.setUint32(4, messageId, true);
      header.setUint32(8, chunks.length, true);
      header.setUint32(12, Math.ceil(buffer.byteLength / AUDIO_CHUNK_PAYLOAD_BYTES), true);
      header.setUint32(16, buffer.byteLength, true);
      new Uint8Array(chunk, AUDIO_CHUNK_HEADER_BYTES).set(new Uint8Array(buffer, offset, payloadBytes));
      chunks.push(chunk);
    }
    if (!chunks.length) chunks.push(new ArrayBuffer(AUDIO_CHUNK_HEADER_BYTES));
    session.audioQueue.push(...chunks);
    this.pumpAudioQueue(session);
  }

  pumpAudioQueue(session) {
    if (session.audioPumpPromise) return session.audioPumpPromise;
    const connection = session.audioData;
    const pump = (async () => {
      if (!session.audioDataOpen || !connection?.open) return;
      const dataChannel = connection._dc;
      if (dataChannel) dataChannel.bufferedAmountLowThreshold = AUDIO_HIGH_WATER_BYTES / 2;
      while (session.audioQueue.length
        && session.audioData === connection
        && session.audioDataOpen
        && connection.open) {
        if (dataChannel && dataChannel.bufferedAmount >= AUDIO_HIGH_WATER_BYTES) break;
        connection.send(session.audioQueue.shift());
        await new Promise((resolve) => setTimeout(resolve, AUDIO_PUMP_DELAY_MS));
      }
    })();
    session.audioPumpPromise = pump;
    pump.catch((error) => this.emit("audio-error", session.peerId, error)).finally(() => {
      if (session.audioPumpPromise === pump) session.audioPumpPromise = null;
      if (session.audioQueue.length
        && session.audioData === connection
        && session.audioDataOpen
        && connection.open
        && !session.audioPumpTimer) {
        session.audioPumpTimer = setTimeout(() => {
          session.audioPumpTimer = null;
          this.pumpAudioQueue(session);
        }, AUDIO_PUMP_DELAY_MS);
      }
    });
    return pump;
  }

  async receiveAudioPayload(session, payload) {
    const buffer = typeof Blob !== "undefined" && payload instanceof Blob
      ? await payload.arrayBuffer()
      : asArrayBuffer(payload);
    if (!buffer) throw new Error("Received unsupported audio payload");
    if (buffer.byteLength < AUDIO_CHUNK_HEADER_BYTES) {
      this.emit("audio-data", session.peerId, buffer);
      return;
    }
    const header = new DataView(buffer, 0, AUDIO_CHUNK_HEADER_BYTES);
    if (header.getUint32(0, true) !== AUDIO_CHUNK_MAGIC) {
      this.emit("audio-data", session.peerId, buffer);
      return;
    }
    const messageId = header.getUint32(4, true);
    const index = header.getUint32(8, true);
    const count = header.getUint32(12, true);
    const totalBytes = header.getUint32(16, true);
    if (!count || count > MAX_AUDIO_CHUNKS || !totalBytes || totalBytes > MAX_AUDIO_BYTES || index >= count) {
      throw new Error("Invalid audio snapshot chunk metadata");
    }
    let message = session.audioChunks.get(messageId);
    if (!message) {
      message = { count, totalBytes, parts: new Map(), receivedBytes: 0 };
      session.audioChunks.set(messageId, message);
    }
    if (message.count !== count || message.totalBytes !== totalBytes) {
      session.audioChunks.delete(messageId);
      throw new Error("Inconsistent audio snapshot chunk metadata");
    }
    if (!message.parts.has(index)) {
      const part = buffer.slice(AUDIO_CHUNK_HEADER_BYTES);
      message.parts.set(index, part);
      message.receivedBytes += part.byteLength;
    }
    if (message.parts.size !== message.count) return;
    if (message.receivedBytes !== message.totalBytes) {
      session.audioChunks.delete(messageId);
      throw new Error("Incomplete audio snapshot");
    }
    const complete = new Uint8Array(message.totalBytes);
    let offset = 0;
    for (let partIndex = 0; partIndex < message.count; partIndex += 1) {
      const part = message.parts.get(partIndex);
      if (!part) return;
      complete.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    session.audioChunks.delete(messageId);
    this.emit("audio-data", session.peerId, complete.buffer);
  }

  closeIfCurrent(session, reason) {
    if (this.sessions.get(session.peerId) !== session) return;
    this.sessions.delete(session.peerId);
    const data = session.data;
    const audioData = session.audioData;
    session.data = null;
    session.audioData = null;
    session.dataOpen = false;
    session.audioDataOpen = false;
    session.audioChunks.clear();
    session.audioQueue.length = 0;
    if (session.audioPumpTimer) clearTimeout(session.audioPumpTimer);
    session.audioPumpTimer = null;
    session.audioPumpPromise = null;
    if (data?.open) data.close();
    if (audioData?.open) audioData.close();
    this.emit("closed", session.peerId, reason);
  }

  close(peerId) {
    const session = this.sessions.get(peerId);
    if (session) this.closeIfCurrent(session, "closed-by-client");
  }

  async stop() {
    for (const peerId of [...this.sessions.keys()]) this.close(peerId);
    this.peer?.destroy();
    this.peer = null;
  }
}
