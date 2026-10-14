import assert from "node:assert/strict";
import { RawStreamCapture, RollingAudioBuffer } from "../src/audio/live-audio.js";

const SAMPLE_RATE = 16_000;

function samples(count) {
  return new Float32Array(count).fill(0.25);
}

function testArrivalFreshnessIsIndependentOfAudioClock() {
  const buffer = new RollingAudioBuffer(4);
  buffer.append(samples(SAMPLE_RATE), SAMPLE_RATE, 0, 1_000, 1_000);

  assert.equal(buffer.isFresh(2.5, 5_000), false, "audio-clock timestamp should be stale");
  assert.equal(buffer.isCaptureFresh(2.5, 1_500), true, "recently received audio should be live");

  buffer.append(samples(SAMPLE_RATE), SAMPLE_RATE, SAMPLE_RATE, 1_000, 5_000);
  assert.equal(buffer.isFresh(2.5, 5_000), false, "a paused audio clock must remain distinguishable");
  assert.equal(buffer.isCaptureFresh(2.5, 5_500), true, "a new chunk should restore capture liveness");
}

class FakeNode {
  constructor() {
    this.port = { onmessage: null };
  }

  connect(target) {
    return target;
  }

  disconnect() {}
}

class FakeAudioContext extends EventTarget {
  constructor() {
    super();
    this.currentTime = 10;
    this.sampleRate = SAMPLE_RATE;
    this.state = "running";
    this.destination = {};
  }

  createMediaStreamSource() {
    return new FakeNode();
  }

  createGain() {
    return { gain: { value: 1 }, connect: (target) => target, disconnect() {} };
  }
}

function testAudioClockRebasesAfterSuspension() {
  const previousAudioWorkletNode = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = FakeNode;
  try {
    const context = new FakeAudioContext();
    const capture = new RawStreamCapture(context, {}, null, () => {});

    context.state = "suspended";
    context.dispatchEvent(new Event("statechange"));
    assert.equal(capture.clockRebasePending, true);

    context.currentTime = 12;
    context.state = "running";
    context.dispatchEvent(new Event("statechange"));
    capture.rebaseClock(12_000);
    assert.equal(capture.clockRebasePending, false);
    assert.equal(capture.clockOriginMs, 0, "the resumed audio clock should be anchored to the resume time");

    capture.dispose();
  } finally {
    globalThis.AudioWorkletNode = previousAudioWorkletNode;
  }
}

testArrivalFreshnessIsIndependentOfAudioClock();
testAudioClockRebasesAfterSuspension();
console.log("audio-capture-lifecycle-ok");
