import loader from "/vendor/assemblyscript-loader.js";

function label(value) { return value === 2 ? "close" : value === 1 ? "middle" : "unrelated"; }
function qualityNotes(flags, windowSeconds) {
  const notes = [];
  if (flags & 1) notes.push("very quiet input");
  if (flags & 2) notes.push("very steady sound: little happening to compare");
  if (flags & 4) notes.push(`shorter than the ${windowSeconds.toFixed(0)} s training window`);
  if (flags & 8) notes.push("windows disagree with each other");
  return notes;
}

export class SameRoomModel {
  constructor(model, wasmInstance) {
    this.model = model;
    this.exports = wasmInstance.exports;
    const c = model.config;
    this.exports.configure(model.intercept, model.mean[0], model.mean[1], model.std[0], model.std[1], model.coef[0], model.coef[1], c.window_sec, c.hop_sec, c.max_lag, c.min_sec);
  }

  static async load({ modelUrl = "/model.json", wasmUrl = "/same_room.wasm" } = {}) {
    const [modelResponse, wasmResponse] = await Promise.all([fetch(modelUrl), fetch(wasmUrl)]);
    if (!modelResponse.ok) throw new Error(`Could not load model (${modelResponse.status})`);
    if (!wasmResponse.ok) throw new Error(`Could not load WASM (${wasmResponse.status})`);
    const [model, wasmBytes] = await Promise.all([modelResponse.json(), wasmResponse.arrayBuffer()]);
    return new SameRoomModel(model, await loader.instantiate(wasmBytes, {}));
  }

  prepareDevice(audio, { globalStartSample = 0, bitDepth = 8, quantize = true } = {}) {
    const values = audio instanceof Float64Array ? audio : Float64Array.from(audio);
    const input = this.exports.__newArray(this.exports.FLOAT64ARRAY_ID, values);
    let handle;
    try {
      handle = this.exports.prepareDevice(input, globalStartSample, bitDepth, quantize);
    } finally {
      this.exports.__collect?.();
    }
    return { handle, bytes: this.packetBytes(handle), byteLength: this.exports.getPacketByteLength(handle), frameCount: this.exports.getPacketFrameCount(handle), quantized: this.exports.getPacketQuantized(handle), bitDepth: this.exports.getPacketBitDepth(handle) };
  }

  loadDevicePacket(bytes) {
    const values = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    const input = this.exports.__newArray(this.exports.UINT8ARRAY_ID, values);
    let handle;
    try {
      handle = this.exports.loadDevicePacket(input);
    } finally {
      this.exports.__collect?.();
    }
    return { handle, bytes: values, byteLength: values.length, frameCount: this.exports.getPacketFrameCount(handle), quantized: this.exports.getPacketQuantized(handle), bitDepth: this.exports.getPacketBitDepth(handle) };
  }

  releaseDevice(packet) {
    if (packet?.handle !== undefined) this.exports.releaseDevice(packet.handle);
    else if (Number.isInteger(packet)) this.exports.releaseDevice(packet);
    this.exports.__collect?.();
  }

  packetBytes(handle) {
    const bytes = new Uint8Array(this.exports.getPacketByteLength(handle));
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = this.exports.getPacketByte(handle, i);
    return bytes;
  }

  result(wasmMs) {
    const flags = this.exports.getQualityFlags();
    const windowScores = [];
    for (let i = 0; i < this.exports.getWindowCount(); i += 1) windowScores.push(this.exports.getWindowScore(i));
    return {
      score: this.exports.getScore(), label: label(this.exports.getLabel()), window_scores: windowScores,
      features: { mel_peak: this.exports.getFeature(0), flux_peak: this.exports.getFeature(1) },
      lags: { mel: this.exports.getLag(0), flux: this.exports.getLag(1) },
      quality: { ok: flags === 0, notes: qualityNotes(flags, this.model.config.window_sec), level_dbfs: this.exports.getLevel(), activity_db: this.exports.getActivity() },
      seconds: this.exports.getSeconds(), wasm_ms: wasmMs,
    };
  }

  comparePackets(packetA, packetB) {
    const loadedA = packetA?.handle === undefined ? this.loadDevicePacket(packetA) : null;
    const loadedB = packetB?.handle === undefined ? this.loadDevicePacket(packetB) : null;
    const a = loadedA?.handle ?? packetA.handle;
    const b = loadedB?.handle ?? packetB.handle;
    try {
      const started = performance.now();
      this.exports.compareDevices(a, b);
      const pairMs = performance.now() - started;
      const result = this.result(pairMs);
      result.pair_ms = pairMs;
      return result;
    } finally {
      if (loadedA) this.releaseDevice(loadedA);
      if (loadedB) this.releaseDevice(loadedB);
      this.exports.__collect?.();
    }
  }

  scoreBuffers(audioA, audioB, options = {}) {
    const a = audioA instanceof Float64Array ? audioA : Float64Array.from(audioA);
    const b = audioB instanceof Float64Array ? audioB : Float64Array.from(audioB);
    const n = Math.min(a.length, b.length), minSamples = this.model.config.min_sec * 16000;
    if (n < minSamples) throw new Error(`Need at least ${this.model.config.min_sec.toFixed(0)} s of audio from each device (got ${(n / 16000).toFixed(1)} s).`);
    const started = performance.now();
    const packetA = this.prepareDevice(a, options), packetB = this.prepareDevice(b, options);
    try {
      const result = this.comparePackets(packetA, packetB);
      result.wasm_ms = performance.now() - started;
      result.device_ms = result.wasm_ms - result.pair_ms;
      return result;
    } finally {
      this.releaseDevice(packetA);
      this.releaseDevice(packetB);
    }
  }
}
