// Small public API for the packetized same-room analyzer.
//
// The only data that crosses the public pair-comparison boundary is an
// ArrayBuffer containing a serialized mel packet. Raw audio is sent only to
// this instance's private worker during prepare().

const DEFAULT_MODEL_URL = new URL("../../model_output/model.json", import.meta.url).href;
const DEFAULT_WASM_URL = new URL("../../web-calibration/wasm_parity/wasm/same_room.wasm", import.meta.url).href;

function resolveResourceUrl(value) {
  const base = typeof location === "undefined" ? import.meta.url : location.href;
  return new URL(String(value), base).href;
}

function asFloat64Samples(audio) {
  if (audio && typeof audio.getChannelData === "function") {
    if (audio.sampleRate !== undefined && audio.sampleRate !== 16000) {
      throw new Error(`AudioCompare expects 16 kHz samples; got ${audio.sampleRate} Hz. Resample before prepare().`);
    }
    const channels = audio.numberOfChannels || 1;
    const length = audio.length ?? audio.getChannelData(0).length;
    const result = new Float64Array(length);
    for (let channel = 0; channel < channels; channel += 1) {
      const values = audio.getChannelData(channel);
      for (let i = 0; i < length; i += 1) result[i] += values[i] / channels;
    }
    return result;
  }
  if (audio instanceof ArrayBuffer) {
    throw new TypeError("prepare() needs audio samples, not an untyped ArrayBuffer. Pass Float32Array, Float64Array, or an AudioBuffer.");
  }
  if (ArrayBuffer.isView(audio)) return Float64Array.from(audio);
  if (Array.isArray(audio) || audio?.[Symbol.iterator]) return Float64Array.from(audio);
  throw new TypeError("prepare() needs mono 16 kHz audio samples as Float32Array, Float64Array, an array, or an AudioBuffer.");
}

function asPacketBuffer(packet) {
  if (packet instanceof ArrayBuffer) return packet;
  if (ArrayBuffer.isView(packet)) {
    return packet.byteOffset === 0 && packet.byteLength === packet.buffer.byteLength
      ? packet.buffer
      : packet.slice().buffer;
  }
  throw new TypeError("compare() needs packet ArrayBuffers returned by prepare().");
}

export class AudioComparison {
  constructor(data) {
    this.score = data.score;
    this.label = data.label;
    this.windowScores = data.windowScores || [];
    this.features = data.features || {};
    this.lags = data.lags || {};
    this.quality = data.quality || {};
    this.seconds = data.seconds;
    this.pairMs = data.pairMs ?? 0;
    this.deviceMs = data.deviceMs ?? 0;
    this.totalMs = data.totalMs ?? this.pairMs;

    // Compatibility aliases make the object convenient to use from existing
    // code that consumed the demo's original worker response.
    this.window_scores = this.windowScores;
    this.pair_ms = this.pairMs;
    this.wasm_ms = this.pairMs;
    this.device_ms = this.deviceMs;
    this.total_ms = this.totalMs;
  }
}

export class AudioCompare {
  constructor({
    modelUrl = DEFAULT_MODEL_URL,
    wasmUrl = DEFAULT_WASM_URL,
    workerUrl = new URL("./compare-worker.js", import.meta.url),
    bitDepth = 8,
    quantize = true,
  } = {}) {
    this.modelUrl = resolveResourceUrl(modelUrl);
    this.wasmUrl = resolveResourceUrl(wasmUrl);
    this.defaultPrepareOptions = { bitDepth, quantize };
    this.worker = new Worker(workerUrl, { type: "module", name: "AudioCompare" });
    this.nextId = 1;
    this.pending = new Map();
    this.disposed = false;
    this.config = null;
    this.model = null;
    this.loadPromise = null;
    this.worker.onmessage = (event) => this.#handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "AudioCompare worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  static async fromObject(options = {}) {
    const instance = new AudioCompare(options);
    try {
      await instance.ready();
      return instance;
    } catch (error) {
      instance.dispose();
      throw error;
    }
  }

  #request(message, transfer = []) {
    if (this.disposed) return Promise.reject(new Error("AudioCompare has been disposed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  #handleMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message.result);
  }

  async ready() {
    if (!this.loadPromise) {
      this.loadPromise = this.#request({ type: "init", modelUrl: this.modelUrl, wasmUrl: this.wasmUrl })
        .then((result) => {
          this.config = result.config;
          this.model = result;
          return this.config;
        });
    }
    return this.loadPromise;
  }

  async prepare(audio, options = {}) {
    await this.ready();
    const samples = asFloat64Samples(audio);
    const result = await this.#request(
      {
        type: "prepare",
        audio: samples.buffer,
        globalStartSample: options.globalStartSample ?? 0,
        bitDepth: options.bitDepth ?? this.defaultPrepareOptions.bitDepth,
        quantize: options.quantize ?? this.defaultPrepareOptions.quantize,
      },
      [samples.buffer],
    );
    return result.packet;
  }

  async compare(preparedA, preparedB) {
    await this.ready();
    const started = performance.now();
    const result = await this.#request({
      type: "compare",
      packetA: asPacketBuffer(preparedA),
      packetB: asPacketBuffer(preparedB),
    });
    const comparison = new AudioComparison({ ...result, totalMs: performance.now() - started });
    return comparison;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("AudioCompare disposed"));
    this.pending.clear();
  }
}

