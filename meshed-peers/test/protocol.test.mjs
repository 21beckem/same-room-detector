import assert from "node:assert/strict";
import { MeshedPeers } from "../src/MeshedPeers.js";
import { prepareSamples } from "../src/audio/audio.js";

const SAMPLE_RATE = 16_000;
const testMeshes = [];

class TestBuffer {
  constructor(seconds, value) {
    this.sampleRate = SAMPLE_RATE;
    this.samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
    this.fill(value);
  }

  get seconds() {
    return this.samples.length / this.sampleRate;
  }

  snapshot(maxSeconds) {
    return this.samples.slice(Math.max(0, this.samples.length - Math.floor(maxSeconds * this.sampleRate)));
  }

  setSeconds(seconds, value) {
    this.samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
    this.fill(value);
  }

  fill(value) {
    for (let index = 0; index < this.samples.length; index += 1) {
      this.samples[index] = typeof value === "function" ? value(index) : value;
    }
  }
}

class FakeManager {
  constructor(peerId) {
    this.peerId = peerId;
    this.remote = null;
    this.controlMessages = [];
    this.audioMessages = [];
    this.dropControl = () => false;
    this.dropAudio = () => false;
    this.audioDelayMs = 0;
  }

  send(_peerId, message) {
    this.controlMessages.push(message);
    if (!this.dropControl(message)) this.remote.handleMessage(this.peerId, message);
  }

  sendAudio(_peerId, payload) {
    const message = { payload, dropped: this.dropAudio(payload) };
    this.audioMessages.push(message);
    if (message.dropped) return;
    setTimeout(() => this.remote.handleAudioData(this.peerId, payload), this.audioDelayMs);
  }

  close() {}

  async stop() {}
}

function createPeer(peerId, seconds = 0.2, value = 1, timing = {}) {
  const calls = [];
  const mesh = MeshedPeers.fromObject({
    timing: {
      comparisonWindowSeconds: 0.1,
      minimumAudioSeconds: 0.1,
      reassessSeconds: 60,
      retrySeconds: 0.01,
      snapshotRequestTimeoutMs: 100,
      snapshotExchangeTimeoutMs: 200,
      ...timing,
    },
  });
  mesh.active = true;
  mesh.peerId = peerId;
  mesh.localBuffer = new TestBuffer(seconds, value);
  mesh.manager = new FakeManager(peerId);
  mesh.analyzer = {
    async compareBuffers(local, remote) {
      calls.push({ local, remote });
      return { score: 0.99, label: "same-room" };
    },
    dispose() {},
  };
  mesh.testCalls = calls;
  testMeshes.push(mesh);
  return mesh;
}

function connectManagers(left, right) {
  left.manager.remote = right;
  right.manager.remote = left;
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for protocol state");
}

async function connectPair(left, right) {
  connectManagers(left, right);
  const coordinator = left.peerId < right.peerId ? left : right;
  const responder = coordinator === left ? right : left;
  await coordinator.handleSessionReady({ peerId: responder.peerId });
  await responder.handleSessionReady({ peerId: coordinator.peerId });
  await waitFor(() => left.testCalls.length >= 1 && right.testCalls.length >= 1);
  return { coordinator, responder };
}

async function testExactSnapshotPairing() {
  const initialSignal = (index) => Math.sin(index / 11);
  const coordinator = createPeer("a", 0.2, initialSignal);
  const responder = createPeer("b", 0.2, 2);
  responder.manager.audioDelayMs = 30;
  const expectedCoordinator = prepareSamples(coordinator.localBuffer.snapshot(0.1), SAMPLE_RATE);
  await connectPair(coordinator, responder);

  coordinator.localBuffer.setSeconds(0.2, (index) => Math.cos(index / 7));
  await waitFor(() => coordinator.testCalls.length >= 1 && responder.testCalls.length >= 1);
  assert.deepEqual([...coordinator.testCalls[0].local], [...expectedCoordinator]);
  assert.equal(coordinator.nearbyPeers[0].score, 0.99);
}

async function testDelayedBufferReadiness() {
  const coordinator = createPeer("a", 0.2, 1);
  const responder = createPeer("b", 0.02, 2);
  connectManagers(coordinator, responder);
  await coordinator.handleSessionReady({ peerId: responder.peerId });
  await responder.handleSessionReady({ peerId: coordinator.peerId });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(coordinator.testCalls.length, 0);
  responder.localBuffer.setSeconds(0.2, 2);
  await waitFor(() => coordinator.testCalls.length >= 1 && responder.testCalls.length >= 1);
}

async function testDroppedReadyRetriesWithNewCycle() {
  const coordinator = createPeer("a", 0.2, 1, { snapshotRequestTimeoutMs: 40 });
  const responder = createPeer("b", 0.2, 2);
  let droppedReady = false;
  responder.manager.dropControl = (message) => {
    if (message.type === "audio-snapshot-ready" && !droppedReady) {
      droppedReady = true;
      return true;
    }
    return false;
  };
  const { coordinator: activeCoordinator } = await (async () => {
    connectManagers(coordinator, responder);
    await coordinator.handleSessionReady({ peerId: responder.peerId });
    await responder.handleSessionReady({ peerId: coordinator.peerId });
    return { coordinator };
  })();
  await waitFor(() => activeCoordinator.testCalls.length >= 1);
  const requestIds = activeCoordinator.manager.controlMessages
    .filter((message) => message.type === "audio-snapshot-request")
    .map((message) => message.requestId);
  assert.equal(droppedReady, true);
  assert.ok(new Set(requestIds).size >= 2, "a dropped ready message must cause a new cycle");
  assert.equal(activeCoordinator.nearbyPeers[0].score, 0.99);
}

async function testDroppedSnapshotRetriesWithNewCycle() {
  const coordinator = createPeer("a", 0.2, 1, { snapshotExchangeTimeoutMs: 40 });
  const responder = createPeer("b", 0.2, 2);
  let droppedSnapshot = false;
  responder.manager.dropAudio = () => {
    if (!droppedSnapshot) {
      droppedSnapshot = true;
      return true;
    }
    return false;
  };
  connectManagers(coordinator, responder);
  await coordinator.handleSessionReady({ peerId: responder.peerId });
  await responder.handleSessionReady({ peerId: coordinator.peerId });
  await waitFor(() => coordinator.testCalls.length >= 1);
  const requestIds = coordinator.manager.controlMessages
    .filter((message) => message.type === "audio-snapshot-request")
    .map((message) => message.requestId);
  assert.equal(droppedSnapshot, true);
  assert.ok(new Set(requestIds).size >= 2, "a dropped snapshot must cause a new cycle");
}

async function testStaleSnapshotCannotSatisfyNewCycle() {
  const coordinator = createPeer("a", 0.2, 1, { reassessSeconds: 0.04 });
  const responder = createPeer("b", 0.2, 2, { reassessSeconds: 0.04 });
  responder.manager.audioDelayMs = 100;
  await connectPair(coordinator, responder);
  const oldSnapshot = responder.manager.audioMessages[0].payload;
  const firstComparisonCount = coordinator.testCalls.length;
  await waitFor(() => coordinator.manager.controlMessages.filter((message) => message.type === "audio-snapshot-request").length >= 2);
  await coordinator.handleAudioData("b", oldSnapshot);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(coordinator.testCalls.length, firstComparisonCount);
  assert.equal(coordinator.links.get("b").snapshotReceived, false);
  await waitFor(() => coordinator.testCalls.length >= firstComparisonCount + 1);
}

async function testRepeatedReassessmentHasNoIndependentResponderTimer() {
  const coordinator = createPeer("a", 0.2, 1, { reassessSeconds: 0.04 });
  const responder = createPeer("b", 0.2, 2, { reassessSeconds: 0.04 });
  await connectPair(coordinator, responder);
  await waitFor(() => coordinator.testCalls.length >= 4 && responder.testCalls.length >= 4, 1000);
  assert.equal(coordinator.testCalls.length, responder.testCalls.length);
  assert.ok(coordinator.testCalls.every(({ local }) => local.length === Math.floor(0.1 * SAMPLE_RATE)));
  assert.ok(responder.testCalls.every(({ local }) => local.length === Math.floor(0.1 * SAMPLE_RATE)));
}

await testExactSnapshotPairing();
await testDelayedBufferReadiness();
await testDroppedReadyRetriesWithNewCycle();
await testDroppedSnapshotRetriesWithNewCycle();
await testStaleSnapshotCannotSatisfyNewCycle();
await testRepeatedReassessmentHasNoIndependentResponderTimer();
for (const mesh of testMeshes) await mesh.stop();
console.log("meshed-peers-protocol-ok");
