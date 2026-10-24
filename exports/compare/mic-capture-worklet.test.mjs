import assert from "node:assert/strict";
import { test } from "node:test";

let CaptureProcessor;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.messages = []; this.port = { postMessage: (message) => this.messages.push(message) }; }
};
globalThis.registerProcessor = (_name, processor) => { CaptureProcessor = processor; };
const { StreamingResampler } = await import("./mic-capture-worklet.js");

function convert(input, inputRate, chunkSize) {
  const converter = new StreamingResampler(inputRate, 16000);
  const output = [];
  for (let start = 0; start < input.length; start += chunkSize) {
    converter.process(input.subarray(start, start + chunkSize), (value) => output.push(value));
  }
  return { output, converter };
}

function tone(rate, frequency, seconds = 1) {
  return Float32Array.from({ length: rate * seconds }, (_, frame) => 0.7 * Math.sin(2 * Math.PI * frequency * frame / rate));
}

for (const rate of [48000, 44100]) {
  test(`${rate} Hz conversion preserves duration, phase, gain and chunk continuity`, () => {
    const input = tone(rate, 1000, 2);
    const { output, converter } = convert(input, rate, 128);
    const whole = convert(input, rate, input.length).output;
    assert.deepEqual(output, whole, "chunk boundaries must not change any output samples");
    const expected = Math.ceil((input.length - converter.radius) * 16000 / rate);
    assert.equal(output.length, expected, "only the fixed filter lookahead may remain pending");
    let error = 0;
    for (let frame = 200; frame < output.length; frame += 1) {
      error += (output[frame] - 0.7 * Math.sin(2 * Math.PI * 1000 * frame / 16000)) ** 2;
    }
    assert.ok(Math.sqrt(error / (output.length - 200)) < 0.001, "1 kHz timing and amplitude must be preserved");
  });

  test(`${rate} Hz conversion rejects frequencies above the 16 kHz Nyquist limit`, () => {
    const { output } = convert(tone(rate, 10000), rate, 128);
    const rms = Math.sqrt(output.slice(200).reduce((sum, value) => sum + value ** 2, 0) / (output.length - 200));
    assert.ok(rms < 0.001, `aliased RMS was ${rms}`);
  });
}

for (const rate of [16000, 48000, 44100]) {
  test(`worklet at ${rate} Hz emits contiguous 2048-frame 16 kHz chunks`, () => {
    globalThis.sampleRate = rate;
    globalThis.currentFrame = 0;
    const processor = new CaptureProcessor({ processorOptions: { diagnostics: true, outputSampleRate: 16000 } });
    const input = tone(rate, 1000);
    for (let frame = 0; frame < input.length; frame += 128) {
      globalThis.currentFrame = frame;
      processor.process([[input.subarray(frame, frame + 128)]], [[new Float32Array(128)]]);
    }
    assert.equal(processor.messages.length, 7);
    processor.messages.forEach((message, sequence) => {
      assert.equal(message.sequence, sequence);
      assert.equal(message.frameStart, sequence * 2048);
      assert.equal(message.frameEnd, (sequence + 1) * 2048);
      assert.equal(message.buffer.byteLength, 2048 * 4);
      assert.equal(message.inputSampleRate, rate);
      assert.equal(message.outputSampleRate, 16000);
      assert.equal(message.audioTimeEnd, message.frameEnd / 16000);
    });
    if (rate === 16000) {
      assert.deepEqual(new Float32Array(processor.messages[0].buffer), input.subarray(0, 2048), "baseline samples must be unchanged");
    }
  });
}

test("default worklet messages remain raw ArrayBuffers", () => {
  globalThis.sampleRate = 16000;
  globalThis.currentFrame = 0;
  const processor = new CaptureProcessor();
  processor.process([[new Float32Array(2048)]], []);
  assert.equal(processor.messages.length, 1);
  assert.ok(processor.messages[0] instanceof ArrayBuffer);
});

test("input-only worklet preserves samples and metadata with no output buffers", () => {
  globalThis.sampleRate = 16000;
  const processor = new CaptureProcessor({ processorOptions: { diagnostics: true, outputSampleRate: 16000 } });
  const input = tone(16000, 1000);
  for (let frame = 0; frame < input.length; frame += 128) {
    globalThis.currentFrame = frame;
    assert.equal(processor.process([[input.subarray(frame, frame + 128)]], []), true);
  }
  assert.equal(processor.messages.length, 7);
  processor.messages.forEach((message, sequence) => {
    assert.equal(message.sequence, sequence);
    assert.equal(message.frameStart, sequence * 2048);
    assert.equal(message.frameEnd, (sequence + 1) * 2048);
    assert.deepEqual(new Float32Array(message.buffer), input.subarray(sequence * 2048, (sequence + 1) * 2048));
  });
});
