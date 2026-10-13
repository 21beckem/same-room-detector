import Peer from "peerjs";
import { EventEmitter } from "./EventEmitter.js";
import { PeerConnectionManager } from "./PeerConnectionManager.js";
import { SameRoomAnalyzer } from "./audio/SameRoomAnalyzer.js";
import { prepareSamples } from "./audio/audio.js";
import { decodeAudioSnapshot, encodeAudioSnapshot } from "./audio/audio-snapshot.js";
import { RawStreamCapture, RollingAudioBuffer } from "./audio/live-audio.js";
import { alignTimestampedSnapshots } from "./audio/live-sync.js";

const STATUS = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  REQUESTING_MICROPHONE: "requesting-microphone",
  CONNECTING: "connecting",
  DISCOVERING: "discovering",
  CONNECTING_TO_PEER: "connecting-to-peer",
  COMPARING: "comparing",
  CONNECTED: "connected",
  STOPPING: "stopping",
  STOPPED: "stopped",
  ERROR: "error",
});

const DEFAULTS = {
  peerServer: { },
  meshServerUrl: null,
  modelUrl: "../model_output/model.json",
  wasmUrl: "../web-calibration/wasm_parity/wasm/same_room.wasm",
  timing: {
    reassessSeconds: 30,
    retrySeconds: 10,
    comparisonWindowSeconds: 12,
    alignmentSeconds: 5,
    minimumAudioSeconds: 8,
    connectionTimeoutMs: 25_000,
    snapshotRequestTimeoutMs: 5_000,
    snapshotExchangeTimeoutMs: 25_000,
    maxSnapshotAgeSeconds: 2.5,
  },
  limits: { maxNearbyPeers: 5 },
  audio: {
    constraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  },
  thresholds: { nearby: 0.75 },
};

function mergeConfig(input = {}) {
  return {
    ...DEFAULTS,
    ...input,
    peerServer: { ...DEFAULTS.peerServer, ...(input.peerServer || {}) },
    timing: { ...DEFAULTS.timing, ...(input.timing || {}) },
    limits: { ...DEFAULTS.limits, ...(input.limits || {}) },
    audio: { ...DEFAULTS.audio, ...(input.audio || {}) },
    thresholds: { ...DEFAULTS.thresholds, ...(input.thresholds || {}) },
  };
}

function randomId(prefix = "mesh") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

export class MeshedPeers extends EventEmitter {
  static STATUS = STATUS;

  static fromObject(config = {}) {
    return new MeshedPeers(config);
  }

  constructor(input = {}) {
    super();
    this.config = mergeConfig(input);
    this.requiredAudioSeconds = Math.max(
      this.config.timing.minimumAudioSeconds,
      this.config.timing.comparisonWindowSeconds,
    );
    this.PeerClass = input.PeerClass || Peer;
    this.active = false;
    this.status = STATUS.IDLE;
    this.peerId = null;
    this.localStream = null;
    this.audioContext = null;
    this.localCapture = null;
    this.analyzer = null;
    this.manager = null;
    this.discoveryTimer = null;
    this.discoveryInFlight = false;
    this.pendingPeers = new Set();
    this.cooldowns = new Map();
    this.pendingAudioSnapshots = new Map();
    this.pendingSnapshotRequests = new Map();
    this.pendingSnapshotReady = new Map();
    this.pendingSnapshotStarts = new Map();
    this.nearby = new Map();
    this.links = new Map();
    this.requests = new Map();
    this.nextRequestId = 1;
    this.nextSnapshotId = 1;
  }

  get nearbyPeers() {
    return [...this.nearby.values()].map((peer) => ({ ...peer }));
  }

  get id() {
    return this.peerId;
  }

  setStatus(status, details = {}) {
    this.status = status;
    this.emit("status-change", status, { status, ...details });
  }

  matchmakingUrl(path) {
    const base = this.config.meshServerUrl || this.deriveMeshServerUrl();
    return `${base.replace(/\/$/, "")}${path}`;
  }

  deriveMeshServerUrl() {
    const { host, port, path, secure } = this.config.peerServer;
    const protocol = secure ? "https" : "http";
    return `${protocol}://${host}${port ? `:${port}` : ""}${path || "/"}`;
  }

  async begin() {
    if (this.active) return this;
    this.active = true;
    this.setStatus(STATUS.STARTING, { message: "starting mesh client" });
    try {
      this.setStatus(STATUS.REQUESTING_MICROPHONE, { message: "requesting microphone permission" });
      this.localStream = await this.requestMicrophone();
      await this.startAudioCapture();

      this.analyzer = new SameRoomAnalyzer({
        modelUrl: this.config.modelUrl,
        wasmUrl: this.config.wasmUrl,
        workerUrl: this.config.workerUrl || new URL("./audio/analysis-worker.js", import.meta.url),
      });
      await this.analyzer.ready();

      this.setStatus(STATUS.CONNECTING, { message: "connecting to mesh-peer-server" });
      this.manager = new PeerConnectionManager({
        PeerClass: this.PeerClass,
        options: this.config.peerServer,
        connectionTimeoutMs: this.config.timing.connectionTimeoutMs,
      });
      this.attachManager();
      this.peerId = await this.manager.start();
      this.setStatus(STATUS.CONNECTED, { message: "connected to mesh-peer-server", peerId: this.peerId });
      this.emit("ready", this.peerId);
      this.scheduleDiscovery(0);
      return this;
    } catch (error) {
      this.setStatus(STATUS.ERROR, { message: error.message || String(error), error });
      await this.stop();
      throw error;
    }
  }

  async requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture requires HTTPS or localhost");
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: this.config.audio.constraints, video: false });
    } catch (error) {
      if (error.name !== "OverconstrainedError") throw error;
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  }

  async startAudioCapture() {
    const sampleRate = this.localStream.getAudioTracks()[0]?.getSettings?.().sampleRate;
    try {
      this.audioContext = new AudioContext({ latencyHint: "interactive", ...(sampleRate ? { sampleRate } : {}) });
    } catch {
      this.audioContext = new AudioContext({ latencyHint: "interactive" });
    }
    await this.audioContext.audioWorklet.addModule(new URL("./audio/capture-worklet.js", import.meta.url));
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    const bufferSeconds = this.requiredAudioSeconds + 1;
    this.localBuffer = new RollingAudioBuffer(bufferSeconds);
    this.localCapture = new RawStreamCapture(
      this.audioContext,
      this.localStream,
      new URL("./audio/capture-worklet.js", import.meta.url),
      (samples, rate, startFrame, captureEndMs) => this.localBuffer.append(samples, rate, startFrame, captureEndMs),
    );
  }

  attachManager() {
    this.manager.on("ready", (session) => this.handleSessionReady(session));
    this.manager.on("data", (peerId, message) => this.handleMessage(peerId, message));
    this.manager.on("audio-data", (peerId, payload) => this.handleAudioData(peerId, payload));
    this.manager.on("audio-error", (peerId, error) => this.handlePeerError(peerId, error));
    this.manager.on("closed", (peerId, reason) => this.handlePeerClosed(peerId, reason));
    this.manager.on("session-error", (peerId, error) => this.handlePeerError(peerId, error));
    this.manager.on("error", (error) => {
      this.emit("error", null, error);
      this.setStatus(STATUS.ERROR, { message: error.message || String(error), error });
    });
    this.manager.on("disconnected", () => this.setStatus(STATUS.ERROR, { message: "mesh-peer-server disconnected" }));
  }

  scheduleDiscovery(delayMs = this.config.timing.retrySeconds * 1000) {
    if (!this.active || this.discoveryTimer || this.discoveryInFlight) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      this.discoverPeer().catch((error) => {
        this.emit("error", null, error);
        this.scheduleDiscovery();
      });
    }, Math.max(0, delayMs));
  }

  async discoverPeer() {
    if (!this.active || this.discoveryInFlight || this.nearby.size >= this.config.limits.maxNearbyPeers) return;
    this.discoveryInFlight = true;
    this.setStatus(STATUS.DISCOVERING, { message: "discovering peers" });
    try {
      const excluded = [
        ...this.nearby.keys(),
        ...this.links.keys(),
        ...this.pendingPeers,
        ...[...this.cooldowns.entries()].filter(([, expires]) => expires > Date.now()).map(([id]) => id),
      ];
      const response = await fetch(this.matchmakingUrl("/mesh/random-peer"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requesterId: this.peerId, excluded }),
      });
      if (response.status === 204) {
        this.discoveryInFlight = false;
        this.setStatus(STATUS.DISCOVERING, { message: "no untested peers are available" });
        this.scheduleDiscovery();
        return;
      }
      if (!response.ok) throw new Error(`Peer discovery failed (${response.status})`);
      const match = await response.json();
      const targetId = match.peerId;
      if (!targetId || !this.active) return;
      this.pendingPeers.add(targetId);
      this.setStatus(STATUS.CONNECTING_TO_PEER, { message: `connecting to ${targetId}`, peerId: targetId });
      try {
        await this.manager.connect(targetId);
      } catch (error) {
        this.handlePeerError(targetId, error);
      } finally {
        this.pendingPeers.delete(targetId);
        this.releaseLease(match.leaseId).catch(() => {});
      }
    } finally {
      this.discoveryInFlight = false;
    }
  }

  async releaseLease(leaseId) {
    if (!leaseId || !this.peerId) return;
    await fetch(this.matchmakingUrl("/mesh/release-peer"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requesterId: this.peerId, leaseId }),
    });
  }

  async handleSessionReady(session) {
    if (!this.active) return;
    const peerId = session.peerId;
    let link = this.links.get(peerId);
    if (link) return;
    const bufferSeconds = this.requiredAudioSeconds + 1;
    const remoteBuffer = new RollingAudioBuffer(bufferSeconds);
    link = {
      peerId,
      session,
      remoteBuffer,
      comparing: false,
      hasCompared: false,
      snapshotReceived: false,
      isCoordinator: String(this.peerId) < String(peerId),
      activeSnapshotId: null,
      remoteReady: false,
      readySent: false,
      exchangeStarted: false,
      localSnapshotSent: false,
      localSamples: null,
      localSampleRate: null,
      localSnapshot: null,
      remoteSnapshot: null,
      requestSentAt: 0,
      requestReceivedAt: 0,
      remoteToLocalOffsetMs: null,
      targetCaptureEndMs: null,
      snapshotRequestedAt: 0,
      cycleCompared: false,
      comparisonTimer: null,
    };
    this.links.set(peerId, link);
    const pendingRequest = this.pendingSnapshotRequests.get(peerId);
    if (pendingRequest) {
      this.pendingSnapshotRequests.delete(peerId);
      this.activateSnapshotCycle(link, pendingRequest);
    }
    const pendingReady = this.pendingSnapshotReady.get(peerId);
    if (pendingReady) {
      this.pendingSnapshotReady.delete(peerId);
      this.handleSnapshotReady(peerId, pendingReady);
    }
    const pendingStart = this.pendingSnapshotStarts.get(peerId);
    if (pendingStart) {
      this.pendingSnapshotStarts.delete(peerId);
      this.handleSnapshotStart(peerId, pendingStart);
    }
    this.compareWhenReady(link);
  }

  async handleAudioData(peerId, payload) {
    try {
      const snapshot = await decodeAudioSnapshot(payload);
      if (!snapshot) return;
      const link = this.links.get(peerId);
      if (link) this.applyAudioSnapshot(link, snapshot);
      else this.storePendingSnapshot(peerId, snapshot);
    } catch (error) {
      this.emit("error", peerId, error);
    }
  }

  applyAudioSnapshot(link, snapshot) {
    if (this.links.get(link.peerId) !== link) return;
    if (!snapshot.snapshotId || snapshot.snapshotId !== link.activeSnapshotId) {
      this.storePendingSnapshot(link.peerId, snapshot);
      return;
    }
    link.remoteBuffer.replace(snapshot.samples, snapshot.sampleRate, snapshot);
    link.remoteSnapshot = snapshot;
    link.snapshotReceived = true;
    this.compareWhenReady(link);
  }

  storePendingSnapshot(peerId, snapshot) {
    let snapshots = this.pendingAudioSnapshots.get(peerId);
    if (!snapshots) {
      snapshots = new Map();
      this.pendingAudioSnapshots.set(peerId, snapshots);
    }
    snapshots.set(snapshot.snapshotId, snapshot);
    while (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
  }

  activateSnapshotCycle(link, snapshotOrId) {
    const snapshotId = typeof snapshotOrId === "object" ? Number(snapshotOrId.requestId) >>> 0 : Number(snapshotOrId) >>> 0;
    if (!snapshotId || this.links.get(link.peerId) !== link) return;
    if (link.activeSnapshotId === snapshotId) return;
    link.activeSnapshotId = snapshotId;
    link.snapshotReceived = false;
    link.remoteReady = false;
    link.readySent = false;
    link.exchangeStarted = false;
    link.localSnapshotSent = false;
    link.localSamples = null;
    link.localSampleRate = null;
    link.localSnapshot = null;
    link.remoteSnapshot = null;
    link.requestSentAt = finiteNumber(snapshotOrId?.sentAt) ?? link.requestSentAt;
    link.requestReceivedAt = finiteNumber(snapshotOrId?.receivedAt) ?? link.requestReceivedAt;
    link.remoteToLocalOffsetMs = null;
    link.targetCaptureEndMs = null;
    link.cycleCompared = false;
    link.snapshotRequestedAt = nowMs();
    const snapshots = this.pendingAudioSnapshots.get(link.peerId);
    const pendingSnapshot = snapshots?.get(snapshotId);
    if (pendingSnapshot) {
      snapshots.delete(snapshotId);
      if (!snapshots.size) this.pendingAudioSnapshots.delete(link.peerId);
      this.applyAudioSnapshot(link, pendingSnapshot);
    }
  }

  captureLocalSnapshot(targetEndMs = null) {
    if (!this.localBuffer?.sampleRate || this.localBuffer.seconds < this.requiredAudioSeconds) return null;
    const snapshot = this.localBuffer.snapshotWithMetadata
      ? this.localBuffer.snapshotWithMetadata(this.requiredAudioSeconds, targetEndMs)
      : {
        samples: this.localBuffer.snapshot(this.requiredAudioSeconds),
        sampleRate: this.localBuffer.sampleRate,
      };
    if (!snapshot?.samples?.length) return null;
    if (snapshot.captureEndMs !== null && snapshot.captureEndMs !== undefined
      && !this.localBuffer.isFresh(this.config.timing.maxSnapshotAgeSeconds, nowMs())) return null;
    return snapshot;
  }

  sendLocalSnapshot(link, requestedSnapshot = null) {
    if (link.localSnapshotSent || !link.activeSnapshotId || (!link.isCoordinator && !link.exchangeStarted)) return false;
    const targetEndMs = link.isCoordinator ? null : link.targetCaptureEndMs;
    const snapshot = requestedSnapshot || this.captureLocalSnapshot(targetEndMs);
    if (!snapshot) return false;
    link.localSnapshotSent = true;
    link.localSnapshot = snapshot;
    link.localSamples = snapshot.samples;
    link.localSampleRate = snapshot.sampleRate;
    try {
      this.manager.sendAudio(
        link.peerId,
        encodeAudioSnapshot(snapshot.samples, snapshot.sampleRate, link.activeSnapshotId, snapshot),
      );
    } catch (error) {
      this.handleInternalSendError(link, error);
      return false;
    }
    return true;
  }

  sendSnapshotReady(link) {
    if (link.isCoordinator || !link.activeSnapshotId || link.readySent || !this.captureLocalSnapshot()) return false;
    link.readySent = true;
    try {
      this.manager.send(link.peerId, {
        type: "audio-snapshot-ready",
        requestId: link.activeSnapshotId,
        receivedAt: link.requestReceivedAt,
        sentAt: nowMs(),
      });
    } catch (error) {
      this.handleInternalSendError(link, error);
      return false;
    }
    return true;
  }

  startSnapshotExchange(link) {
    if (!link.isCoordinator || !link.activeSnapshotId || !link.remoteReady || link.exchangeStarted) return false;
    const localSnapshot = this.captureLocalSnapshot();
    if (!localSnapshot) return false;
    link.localSnapshot = localSnapshot;
    link.localSamples = localSnapshot.samples;
    link.localSampleRate = localSnapshot.sampleRate;
    link.exchangeStarted = true;
    link.targetCaptureEndMs = localSnapshot.captureEndMs;
    const sentAt = nowMs();
    try {
      this.manager.send(link.peerId, {
        type: "audio-snapshot-start",
        requestId: link.activeSnapshotId,
        sentAt,
        targetCaptureEndMs: localSnapshot.captureEndMs,
        clockOffsetMs: link.remoteToLocalOffsetMs,
      });
    } catch (error) {
      this.handleInternalSendError(link, error);
      return false;
    }
    link.snapshotRequestedAt = nowMs();
    this.sendLocalSnapshot(link, localSnapshot);
    return true;
  }

  startCoordinatorCycle(link) {
    if (!link.isCoordinator || link.activeSnapshotId) return false;
    if (!this.captureLocalSnapshot()) return false;
    const snapshotId = this.nextSnapshotId++ >>> 0 || (this.nextSnapshotId++ >>> 0);
    const sentAt = nowMs();
    this.activateSnapshotCycle(link, { requestId: snapshotId, sentAt });
    link.requestSentAt = sentAt;
    try {
      this.manager.send(link.peerId, { type: "audio-snapshot-request", requestId: snapshotId, sentAt });
    } catch (error) {
      this.handleInternalSendError(link, error);
      return false;
    }
    return true;
  }

  handleInternalSendError(link, error) {
    if (this.links.get(link.peerId) !== link) return;
    link.suppressCloseFailure = true;
    this.removeNearby(link.peerId);
    this.closeLink(link.peerId);
    this.scheduleDiscovery(0);
    const message = String(error?.message || error);
    const expectedTransportRace = message.includes("not ready for messages") || message.includes("is not connected");
    if (!expectedTransportRace) {
      this.emit("error", link.peerId, error);
    }
  }

  compareWhenReady(link) {
    if (!this.active || this.links.get(link.peerId) !== link) return;
    if (link.cycleCompared) return;
    if (link.comparisonTimer) {
      clearTimeout(link.comparisonTimer);
      link.comparisonTimer = null;
    }
    const required = this.requiredAudioSeconds;
    const localReady = this.localBuffer.seconds >= required
      && (this.localBuffer.latestCaptureEndMs === null
        || this.localBuffer.latestCaptureEndMs === undefined
        || this.localBuffer.isFresh(this.config.timing.maxSnapshotAgeSeconds, nowMs()));
    if (link.isCoordinator && link.activeSnapshotId && !link.snapshotReceived) {
      const elapsed = nowMs() - link.snapshotRequestedAt;
      const timeout = link.exchangeStarted
        ? this.config.timing.snapshotExchangeTimeoutMs
        : this.config.timing.snapshotRequestTimeoutMs;
      if (elapsed >= timeout) {
        this.resetSnapshotCycle(link);
      }
    }
    if (link.isCoordinator && !link.activeSnapshotId) this.startCoordinatorCycle(link);
    if (this.links.get(link.peerId) !== link) return;

    if (link.isCoordinator) {
      if (link.activeSnapshotId && link.remoteReady) this.startSnapshotExchange(link);
    } else if (link.activeSnapshotId) {
      this.sendSnapshotReady(link);
      if (link.exchangeStarted) this.sendLocalSnapshot(link);
    }
    if (this.links.get(link.peerId) !== link) return;

    const remoteReady = link.snapshotReceived && link.remoteBuffer.seconds >= required;
    if (!localReady || !remoteReady || link.cycleCompared) {
      let message;
      if (!localReady) {
        message = link.hasCompared
          ? `waiting for enough buffered audio from ${link.peerId}`
          : `collecting initial audio for ${link.peerId}`;
      } else if (!link.activeSnapshotId) {
        message = `waiting for ${link.peerId} to start audio comparison`;
      } else if (link.isCoordinator && !link.remoteReady) {
        message = `waiting for ${link.peerId} to have enough buffered audio`;
      } else if (!link.exchangeStarted) {
        message = `waiting for ${link.peerId} to start audio comparison`;
      } else if (!remoteReady) {
        message = `waiting for an audio snapshot from ${link.peerId}`;
      } else if (link.cycleCompared) {
        message = link.hasCompared
          ? `connected to mesh; ${link.peerId} is nearby`
          : `waiting for ${link.peerId} to start audio comparison`;
      }
      this.setStatus(STATUS.COMPARING, { message, peerId: link.peerId });
      if (!localReady || (link.activeSnapshotId && !remoteReady)) {
        link.comparisonTimer = setTimeout(() => this.compareWhenReady(link), 500);
      }
      return;
    }
    this.runComparison(link).catch((error) => this.handlePeerError(link.peerId, error));
  }

  async runComparison(link) {
    if (!this.active || link.comparing || this.links.get(link.peerId) !== link) return;
    if (!link.localSamples || !link.localSampleRate || !link.snapshotReceived) return;
    link.comparing = true;
    this.setStatus(STATUS.COMPARING, { message: `comparing audio with ${link.peerId}`, peerId: link.peerId });
    try {
      const localSnapshot = link.localSnapshot || {
        samples: link.localSamples,
        sampleRate: link.localSampleRate,
      };
      const remoteSnapshot = link.remoteSnapshot || {
        samples: link.remoteBuffer.snapshot(this.requiredAudioSeconds),
        sampleRate: link.remoteBuffer.sampleRate,
      };
      const aligned = alignTimestampedSnapshots(
        localSnapshot,
        remoteSnapshot,
        link.remoteToLocalOffsetMs,
        this.config.timing.comparisonWindowSeconds,
        this.config.timing.minimumAudioSeconds,
      );
      if (!aligned.usable) {
        this.setStatus(STATUS.COMPARING, {
          message: `waiting for timestamp-aligned audio from ${link.peerId}`,
          peerId: link.peerId,
        });
        if (link.isCoordinator) {
          this.resetSnapshotCycle(link);
          link.comparisonTimer = setTimeout(() => {
            link.comparisonTimer = null;
            this.compareWhenReady(link);
          }, 500);
        }
        return;
      }
      const local = prepareSamples(aligned.audioA, localSnapshot.sampleRate);
      const remote = prepareSamples(aligned.audioB, remoteSnapshot.sampleRate);
      const result = await this.analyzer.compareBuffers(local, remote, {
        live: true,
        maxAlignmentSeconds: this.config.timing.alignmentSeconds,
      });
      result.timestamp_alignment = {
        used_timestamps: aligned.usedTimestamps,
        overlap_seconds: aligned.overlapSeconds,
        offset_ms: aligned.offsetMs,
      };
      link.hasCompared = true;
      link.cycleCompared = true;
      link.snapshotRequestedAt = 0;
      const checkedAt = Date.now();
      const details = {
        score: result.score,
        confidence: clamp(result.score),
        result,
        checkedAt,
        reason: null,
      };
      if (result.score >= this.config.thresholds.nearby) {
        const wasNearby = this.nearby.has(link.peerId);
        const record = {
          peerId: link.peerId,
          score: result.score,
          confidence: details.confidence,
          label: result.label,
          lastCheckedAt: checkedAt,
          nextCheckAt: checkedAt + this.config.timing.reassessSeconds * 1000,
          connectionState: "connected",
        };
        this.nearby.set(link.peerId, record);
        this.setStatus(STATUS.CONNECTED, { message: `connected to mesh; ${link.peerId} is nearby`, peerId: link.peerId });
        if (!wasNearby) this.emit("new-nearby-peer", link.peerId, { ...record, result });
        else this.emit("nearby-peer-updated", link.peerId, { ...record, result });
        if (link.isCoordinator) this.scheduleReassessment(link);
      } else {
        details.reason = "not-nearby";
        this.removeNearby(link.peerId);
        this.emit("peer-failed", link.peerId, details);
        this.cooldowns.set(link.peerId, checkedAt + this.config.timing.retrySeconds * 1000);
        this.closeLink(link.peerId);
        this.scheduleDiscovery(this.config.timing.retrySeconds * 1000);
      }
    } finally {
      link.comparing = false;
    }
  }

  scheduleReassessment(link) {
    if (!link.isCoordinator) return;
    if (link.comparisonTimer) clearTimeout(link.comparisonTimer);
    link.comparisonTimer = setTimeout(() => {
      link.comparisonTimer = null;
      this.resetSnapshotCycle(link);
      this.compareWhenReady(link);
    }, this.config.timing.reassessSeconds * 1000);
  }

  resetSnapshotCycle(link) {
    link.activeSnapshotId = null;
    link.snapshotReceived = false;
    link.remoteReady = false;
    link.readySent = false;
    link.exchangeStarted = false;
    link.localSnapshotSent = false;
    link.localSamples = null;
    link.localSampleRate = null;
    link.localSnapshot = null;
    link.remoteSnapshot = null;
    link.remoteToLocalOffsetMs = null;
    link.targetCaptureEndMs = null;
    link.cycleCompared = false;
    link.snapshotRequestedAt = 0;
  }

  removeNearby(peerId) {
    this.nearby.delete(peerId);
  }

  closeLink(peerId) {
    const link = this.links.get(peerId);
    if (link?.comparisonTimer) clearTimeout(link.comparisonTimer);
    this.removeNearby(peerId);
    this.pendingAudioSnapshots.delete(peerId);
    this.pendingSnapshotRequests.delete(peerId);
    this.pendingSnapshotReady.delete(peerId);
    this.pendingSnapshotStarts.delete(peerId);
    this.links.delete(peerId);
    this.manager?.close(peerId);
  }

  handlePeerClosed(peerId, reason) {
    if (!peerId) return;
    const wasNearby = this.nearby.has(peerId);
    this.removeNearby(peerId);
    const link = this.links.get(peerId);
    if (link?.comparisonTimer) clearTimeout(link.comparisonTimer);
    const suppressFailure = link?.suppressCloseFailure;
    this.links.delete(peerId);
    this.pendingAudioSnapshots.delete(peerId);
    this.pendingSnapshotRequests.delete(peerId);
    this.pendingSnapshotReady.delete(peerId);
    this.pendingSnapshotStarts.delete(peerId);
    if (!suppressFailure && (wasNearby || reason !== "closed-by-client")) {
      this.emit("peer-failed", peerId, { reason: reason || "disconnected", checkedAt: Date.now() });
    }
    this.scheduleDiscovery(0);
  }

  handlePeerError(peerId, error) {
    this.emit("error", peerId, error);
    this.emit("peer-failed", peerId, { reason: "connection-error", error, checkedAt: Date.now() });
    this.cooldowns.set(peerId, Date.now() + this.config.timing.retrySeconds * 1000);
    this.closeLink(peerId);
    this.scheduleDiscovery(this.config.timing.retrySeconds * 1000);
  }

  handleMessage(peerId, message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "broadcast") this.emit("broadcast", peerId, message.payload);
    else if (message.type === "message") this.emit("peer-message", peerId, message.payload);
    else if (message.type === "response") this.resolveRequest(message);
    else if (message.type === "request") this.handleRequest(peerId, message);
    else if (message.type === "audio-snapshot-request") this.handleSnapshotRequest(peerId, message);
    else if (message.type === "audio-snapshot-ready") this.handleSnapshotReady(peerId, message);
    else if (message.type === "audio-snapshot-start") this.handleSnapshotStart(peerId, message);
  }

  handleRequest(peerId, message) {
    let settled = false;
    const resolve = (value) => {
      if (settled) return;
      settled = true;
      this.manager.send(peerId, { type: "response", requestId: message.requestId, ok: true, value });
    };
    const reject = (error) => {
      if (settled) return;
      settled = true;
      this.manager.send(peerId, {
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    if (!this.listeners.get("request")?.size) reject(new Error("No request handler is registered"));
    else this.emit("request", peerId, message.requestType, message.args || [], resolve, reject);
  }

  resolveRequest(message) {
    const request = this.requests.get(message.requestId);
    if (!request) return;
    this.requests.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error || "Remote request failed"));
  }

  broadcastMessage(message) {
    let sent = 0;
    for (const peerId of this.nearby.keys()) {
      try {
        this.manager.send(peerId, { type: "broadcast", payload: message });
        sent += 1;
      } catch (error) {
        this.emit("error", peerId, error);
      }
    }
    return sent;
  }

  directMessage(peerId, message) {
    if (!this.nearby.has(peerId)) throw new Error(`Peer ${peerId} is not in nearbyPeers`);
    this.manager.send(peerId, { type: "message", payload: message });
  }

  directRequest(peerId, requestType, args = []) {
    if (!this.nearby.has(peerId)) return Promise.reject(new Error(`Peer ${peerId} is not in nearbyPeers`));
    const requestId = `${this.peerId || "local"}-${this.nextRequestId++}-${randomId("request")}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(`Request ${requestType} to ${peerId} timed out`));
      }, this.config.timing.connectionTimeoutMs);
      this.requests.set(requestId, { resolve, reject, timer });
      try {
        this.manager.send(peerId, { type: "request", requestId, requestType, args });
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(requestId);
        reject(error);
      }
    });
  }

  handleSnapshotRequest(peerId, message) {
    const requestId = Number(message.requestId) >>> 0;
    if (!requestId) return;
    const request = {
      requestId,
      sentAt: finiteNumber(message.sentAt),
      receivedAt: nowMs(),
    };
    const link = this.links.get(peerId);
    if (!link) {
      this.pendingSnapshotRequests.set(peerId, request);
      return;
    }
    this.activateSnapshotCycle(link, request);
    this.compareWhenReady(link);
  }

  handleSnapshotReady(peerId, message) {
    const requestId = Number(message.requestId) >>> 0;
    const link = this.links.get(peerId);
    if (!requestId) return;
    if (!link) {
      this.pendingSnapshotReady.set(peerId, message);
      return;
    }
    if (!link.isCoordinator || link.activeSnapshotId !== requestId) return;
    const receivedAt = nowMs();
    const requestReceivedAt = finiteNumber(message.receivedAt);
    const readySentAt = finiteNumber(message.sentAt);
    if (finiteNumber(link.requestSentAt) !== null && requestReceivedAt !== null && readySentAt !== null) {
      link.remoteToLocalOffsetMs = (
        (link.requestSentAt - requestReceivedAt) + (receivedAt - readySentAt)
      ) / 2;
    }
    link.remoteReady = true;
    this.compareWhenReady(link);
  }

  handleSnapshotStart(peerId, message) {
    const requestId = Number(message.requestId) >>> 0;
    const link = this.links.get(peerId);
    if (!requestId) return;
    if (!link) {
      this.pendingSnapshotStarts.set(peerId, message);
      return;
    }
    if (link.isCoordinator || link.activeSnapshotId !== requestId) return;
    const coordinatorToResponderOffset = finiteNumber(message.clockOffsetMs);
    link.remoteToLocalOffsetMs = coordinatorToResponderOffset === null ? null : -coordinatorToResponderOffset;
    const targetCaptureEndMs = finiteNumber(message.targetCaptureEndMs);
    link.targetCaptureEndMs = targetCaptureEndMs === null || link.remoteToLocalOffsetMs === null
      ? null
      : targetCaptureEndMs + link.remoteToLocalOffsetMs;
    link.exchangeStarted = true;
    this.compareWhenReady(link);
  }

  async stop() {
    if (!this.active && !this.manager) return;
    this.active = false;
    this.setStatus(STATUS.STOPPING, { message: "stopping mesh client" });
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Mesh stopped"));
    }
    this.requests.clear();
    for (const link of this.links.values()) {
      if (link.comparisonTimer) clearTimeout(link.comparisonTimer);
    }
    this.links.clear();
    this.pendingAudioSnapshots.clear();
    this.pendingSnapshotRequests.clear();
    this.pendingSnapshotReady.clear();
    this.pendingSnapshotStarts.clear();
    this.nearby.clear();
    await this.manager?.stop();
    this.manager = null;
    this.localCapture?.dispose();
    this.localCapture = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    await this.audioContext?.close();
    this.audioContext = null;
    this.analyzer?.dispose();
    this.analyzer = null;
    this.peerId = null;
    this.setStatus(STATUS.STOPPED, { message: "mesh client stopped" });
  }
}

export { STATUS };
