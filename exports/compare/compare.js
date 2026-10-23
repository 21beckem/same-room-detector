// Small public API for the packetized same-room analyzer.
//
// The only data that crosses the public pair-comparison boundary is a
// timestamped object containing an ArrayBuffer with a serialized mel packet.
// Raw audio is sent only to this instance's private worker during prepare().

const DEFAULT_MODEL_URL = new URL("../../model_output/model.json", import.meta.url).href;
const DEFAULT_WASM_URL = new URL("../../web-calibration/wasm_parity/wasm/same_room.wasm", import.meta.url).href;
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_MIC_HISTORY_SECONDS = 30;
const DEFAULT_MIC_PACKET_INTERVAL_MS = 250;
const MIC_CAPTURE_STALL_MS = 1500;

function resolveResourceUrl(value) {
  const base = typeof location === "undefined" ? import.meta.url : location.href;
  return new URL(String(value), base).href;
}

function nowMilliseconds() {
  if (typeof performance !== "undefined") {
    return (performance.timeOrigin ?? Date.now() - performance.now()) + performance.now();
  }
  return Date.now();
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
  if (packet && packet.buffer instanceof ArrayBuffer) return packet.buffer;
  if (packet && packet.packet instanceof ArrayBuffer) return packet.packet;
  if (ArrayBuffer.isView(packet)) {
    return packet.byteOffset === 0 && packet.byteLength === packet.buffer.byteLength
      ? packet.buffer
      : packet.slice().buffer;
  }
  throw new TypeError("compare() needs packets returned by prepare() or a packet ArrayBuffer.");
}

function copyPacket(packet) {
  return { timestamp: packet.timestamp, buffer: packet.buffer.slice(0) };
}

function latestSamples(chunks, totalSamples, sampleCount) {
  const result = new Float32Array(Math.min(totalSamples, sampleCount));
  let remaining = result.length;
  let destination = result.length;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index];
    const take = Math.min(chunk.length, remaining);
    result.set(chunk.subarray(chunk.length - take), destination - take);
    destination -= take;
    remaining -= take;
  }
  return result;
}

const PACKET_HEADER_BYTES = 688;
const N_MELS = 40;

function packetBufferForDrawing(packet) {
  if (packet instanceof ArrayBuffer) return packet;
  if (packet?.buffer instanceof ArrayBuffer) return packet.buffer;
  if (packet?.packet instanceof ArrayBuffer) return packet.packet;
  return null;
}

function parsePacketForDrawing(packet) {
  const buffer = packetBufferForDrawing(packet);
  if (!buffer || buffer.byteLength < PACKET_HEADER_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const quantized = view.getInt32(8, true) !== 0;
  const bits = view.getInt32(12, true);
  const frameCount = view.getInt32(28, true);
  const rms = view.getFloat64(32, true);
  const activity = view.getFloat64(40, true);
  if (frameCount < 1 || frameCount > 100000) return null;

  const valuesPerSample = quantized ? 1 : 8;
  const expectedBytes = PACKET_HEADER_BYTES + N_MELS * frameCount * valuesPerSample;
  if (expectedBytes > bytes.length) return null;

  const mel = new Float32Array(N_MELS * frameCount);
  const offsets = new Float64Array(N_MELS);
  const scales = new Float64Array(N_MELS);
  let offset = 48 + N_MELS * 8;
  for (let band = 0; band < N_MELS; band += 1) offsets[band] = view.getFloat64(48 + band * 8, true);
  for (let band = 0; band < N_MELS; band += 1) scales[band] = view.getFloat64(offset + band * 8, true);
  offset += N_MELS * 8;

  for (let band = 0; band < N_MELS; band += 1) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const index = band * frameCount + frame;
      mel[index] = quantized
        ? offsets[band] + scales[band] * bytes[offset + index] / ((1 << bits) - 1)
        : view.getFloat64(offset + index * 8, true);
    }
  }
  return { mel, frameCount, rms, activity, quantized, bits };
}

function packetColor(value) {
  const stops = [[8, 20, 48], [20, 110, 180], [70, 210, 190], [250, 220, 80], [220, 40, 30]];
  const scaled = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  const lower = Math.min(stops.length - 2, Math.floor(scaled));
  const amount = scaled - lower;
  const from = stops[lower];
  const to = stops[lower + 1];
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

function renderPacket(canvas, summary, packet) {
  const parsed = parsePacketForDrawing(packet);
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width || 640));
  const cssHeight = Math.max(80, Math.floor(rect.height || 160));
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(cssWidth * pixelRatio));
  const height = Math.max(1, Math.floor(cssHeight * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#081430";
  context.fillRect(0, 0, width, height);
  if (!parsed) {
    context.fillStyle = "#aab7ca";
    context.font = `${13 * pixelRatio}px system-ui, sans-serif`;
    context.fillText("Waiting for a prepared packet…", 12 * pixelRatio, 24 * pixelRatio);
    summary.textContent = "Waiting for packet data";
    return;
  }

  const rowRanges = Array.from({ length: N_MELS }, (_, band) => {
    let low = Infinity;
    let high = -Infinity;
    for (let frame = 0; frame < parsed.frameCount; frame += 1) {
      const value = parsed.mel[band * parsed.frameCount + frame];
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    return [low, high];
  });
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const band = N_MELS - 1 - Math.min(N_MELS - 1, Math.floor(y * N_MELS / height));
    const [low, high] = rowRanges[band];
    for (let x = 0; x < width; x += 1) {
      const frame = Math.min(parsed.frameCount - 1, Math.floor(x * parsed.frameCount / width));
      const value = parsed.mel[band * parsed.frameCount + frame];
      const rgb = packetColor((value - low) / Math.max(high - low, 1e-6));
      const index = (y * width + x) * 4;
      image.data[index] = rgb[0];
      image.data[index + 1] = rgb[1];
      image.data[index + 2] = rgb[2];
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  summary.textContent = `${parsed.frameCount} frames · ${parsed.rms.toFixed(1)} dBFS · activity ${parsed.activity.toFixed(1)} dB · ${parsed.quantized ? `${parsed.bits}-bit` : "raw"} mel`;
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
    currentTimestampMs,
  } = {}) {
    this.modelUrl = resolveResourceUrl(modelUrl);
    this.wasmUrl = resolveResourceUrl(wasmUrl);
    this.defaultPrepareOptions = { bitDepth, quantize };
    this.timestampOffsetMs = 0;
    if (currentTimestampMs !== undefined) this.currentTimestampMs = currentTimestampMs;
    this.worker = new Worker(workerUrl, { type: "module", name: "AudioCompare" });
    this.nextId = 1;
    this.pending = new Map();
    this.disposed = false;
    this.config = null;
    this.model = null;
    this.loadPromise = null;
    this.micState = null;
    this.worker.onmessage = (event) => this.#handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "AudioCompare worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  /**
   * The current timestamp in the caller's synchronized clock. Assigning a
   * server timestamp samples the local clock and stores only their difference,
   * so later reads and generated packet timestamps remain inexpensive.
   */
  get currentTimestampMs() {
    return nowMilliseconds() + this.timestampOffsetMs;
  }

  set currentTimestampMs(synchronizedTimestampMs) {
    if (!Number.isFinite(synchronizedTimestampMs)) {
      throw new TypeError("currentTimestampMs must be a finite millisecond timestamp.");
    }
    const nextOffsetMs = synchronizedTimestampMs - nowMilliseconds();
    const offsetChangeMs = nextOffsetMs - this.timestampOffsetMs;
    this.timestampOffsetMs = nextOffsetMs;

    // Existing microphone packets were timestamped with the previous offset.
    // Rebase them too, so a later synchronization update does not leave stale
    // history behind or pause the capture loop waiting for the old timestamp.
    if (offsetChangeMs !== 0 && this.micState) {
      for (const packet of this.micState.packetHistory) packet.timestamp += offsetChangeMs;
      if (Number.isFinite(this.micState.lastPreparedTimestamp)) {
        this.micState.lastPreparedTimestamp += offsetChangeMs;
      }
    }
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
    const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : this.currentTimestampMs;
    return { timestamp, buffer: result.packet };
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

  /** Draws a compact packet's mel payload for diagnostics without exposing audio. */
  drawPacket(canvas, summary, packet) {
    renderPacket(canvas, summary, packet);
  }

  /**
   * Starts a raw microphone pipeline. The browser asks for permission here,
   * so call this from a user gesture such as a button click. Audio is reduced
   * to the model's sample rate, prepared in the existing private worker, and
   * retained as timestamped packets for getLocalPacket().
   */
  async pipeMicAudio({
    historySeconds = DEFAULT_MIC_HISTORY_SECONDS,
    packetIntervalMs = DEFAULT_MIC_PACKET_INTERVAL_MS,
    prepareOnPacket = true,
    sampleRate = DEFAULT_SAMPLE_RATE,
    constraints = {},
    audioContextOptions = {},
    workletUrl = new URL("./mic-capture-worklet.js", import.meta.url),
    onPacket,
    onError,
  } = {}) {
    await this.ready();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("AudioCompare microphone capture requires navigator.mediaDevices.getUserMedia().");
    }
    if (!Number.isFinite(historySeconds) || historySeconds <= 0) {
      throw new RangeError("pipeMicAudio() historySeconds must be greater than zero.");
    }
    if (!Number.isFinite(packetIntervalMs) || packetIntervalMs <= 0) {
      throw new RangeError("pipeMicAudio() packetIntervalMs must be greater than zero.");
    }
    if (sampleRate !== DEFAULT_SAMPLE_RATE) {
      throw new RangeError(`AudioCompare currently supports microphone capture at ${DEFAULT_SAMPLE_RATE} Hz.`);
    }

    await this.stopMicAudio();

    const requestedAudio = {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: sampleRate },
      sampleSize: { ideal: 16 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...constraints,
    };
    let stream;
    let context;
    let source;
    let captureNode;
    let silentGain;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: requestedAudio, video: false });
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) throw new Error("AudioCompare microphone capture requires Web Audio support.");
      context = new AudioContextClass({ sampleRate, latencyHint: "interactive", ...audioContextOptions });
      if (context.sampleRate !== sampleRate) {
        throw new Error(`The browser created a ${context.sampleRate} Hz audio context; ${sampleRate} Hz is required.`);
      }
      await context.audioWorklet.addModule(resolveResourceUrl(workletUrl));
      await context.resume();

      source = context.createMediaStreamSource(stream);
      captureNode = new AudioWorkletNode(context, "audio-compare-capture");
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      source.connect(captureNode).connect(silentGain).connect(context.destination);

      const state = {
        stream,
        context,
        source,
        captureNode,
        silentGain,
        sampleRate,
        historySeconds,
        packetIntervalMs,
        prepareOnPacket,
        analysisSamples: Math.ceil((this.config.window_sec ?? 5) * sampleRate),
        rawChunks: [],
        rawSampleCount: 0,
        packetHistory: [],
        lastPreparedTimestamp: -Infinity,
        prepareInFlight: false,
        preparePromise: null,
        packetWaiters: [],
        lastCaptureAt: 0,
        onPacket,
        onError,
      };
      this.micState = state;
      captureNode.port.onmessage = (event) => {
        if (this.micState !== state) return;
        const payload = event.data || {};
        const samples = payload.samples instanceof Float32Array
          ? payload.samples
          : new Float32Array(payload.samples || payload);
        state.lastCaptureAt = nowMilliseconds();
        this.#consumeMicChunk(state, samples);
      };
      return this;
    } catch (error) {
      captureNode?.disconnect();
      source?.disconnect();
      silentGain?.disconnect();
      for (const track of stream?.getTracks?.() || []) track.stop();
      await context?.close?.();
      throw error;
    }
  }

  #consumeMicChunk(state, samples) {
    if (!samples.length) return;
    const chunk = Float32Array.from(samples);
    state.rawChunks.push(chunk);
    state.rawSampleCount += chunk.length;

    const maxRawSamples = state.analysisSamples + Math.ceil(state.sampleRate * 0.5);
    while (state.rawChunks.length > 1 && state.rawSampleCount > maxRawSamples) {
      state.rawSampleCount -= state.rawChunks.shift().length;
    }

    // Use the adjusted wall clock at delivery time instead of extending one
    // AudioContext frame-clock anchor forever. Independent microphone/audio
    // clocks can drift apart over a long session; wall-clock timestamps keep
    // the packet pairing clock aligned while the chunk delivery delay is only
    // one worklet block.
    const timestamp = this.currentTimestampMs;
    if (!state.prepareOnPacket) {
      this.#prepareWaitingMicPacket(state);
      return;
    }
    if (
      state.rawSampleCount < state.analysisSamples
      || state.prepareInFlight
      || timestamp - state.lastPreparedTimestamp < state.packetIntervalMs
    ) return;

    const audio = latestSamples(state.rawChunks, state.rawSampleCount, state.analysisSamples);
    state.prepareInFlight = true;
    this.prepare(audio, { timestamp })
      .then((packet) => {
        if (this.micState !== state) return;
        this.#storeMicPacket(state, packet);
      })
      .catch((error) => {
        if (this.micState === state) {
          state.onError?.(error);
          for (const waiter of state.packetWaiters.splice(0)) waiter.reject(error);
        }
      })
      .finally(() => {
        state.prepareInFlight = false;
        this.#prepareWaitingMicPacket(state);
      });
  }

  #storeMicPacket(state, packet) {
    state.lastPreparedTimestamp = packet.timestamp;
    state.packetHistory.push(packet);
    const cutoff = packet.timestamp - state.historySeconds * 1000;
    state.packetHistory = state.packetHistory.filter((item) => item.timestamp >= cutoff);
    state.onPacket?.(copyPacket(packet));
    for (const waiter of state.packetWaiters.splice(0)) {
      const localPacket = this.getLocalPacket(waiter.desiredTimestamp);
      if (localPacket) waiter.resolve(localPacket);
      else waiter.reject(new Error("The prepared microphone packet is no longer available."));
    }
  }

  #prepareWaitingMicPacket(state) {
    if (this.micState !== state || state.prepareOnPacket || !state.packetWaiters.length) return;
    if (state.rawSampleCount < state.analysisSamples || state.prepareInFlight) return;
    this.prepareMicPacket().catch((error) => {
      if (this.micState !== state) return;
      for (const waiter of state.packetWaiters.splice(0)) waiter.reject(error);
    });
  }

  /**
   * Prepares exactly one packet from the most recent microphone window.
   * This is useful for request-driven applications that want to keep capture
   * local but avoid repeatedly preparing packets while no comparison is needed.
   */
  async prepareMicPacket(timestamp = this.currentTimestampMs) {
    const state = this.micState;
    if (!state) throw new Error("No microphone pipeline is running.");
    let resumed = false;
    if (state.context.state !== "running") {
      try {
        await state.context.resume();
        resumed = true;
      } catch (error) {
        throw new Error(`Microphone audio is not running (${state.context.state}): ${error.message}`);
      }
    }
    const captureAge = state.lastCaptureAt ? nowMilliseconds() - state.lastCaptureAt : Infinity;
    if (resumed || captureAge > MIC_CAPTURE_STALL_MS) {
      // Do not score an old window after a background tab or suspended audio
      // context. The caller must collect a fresh model-sized window first.
      state.rawChunks = [];
      state.rawSampleCount = 0;
      state.lastCaptureAt = 0;
      throw new Error("Microphone capture was paused or stalled; it has been resumed. Wait for a fresh 5-second window and try again.");
    }
    if (state.rawSampleCount < state.analysisSamples) {
      throw new Error(`Still collecting microphone audio; need ${this.config.window_sec ?? 5} seconds first.`);
    }
    if (state.prepareInFlight) {
      return state.preparePromise;
    }
    const audio = latestSamples(state.rawChunks, state.rawSampleCount, state.analysisSamples);
    state.prepareInFlight = true;
    const packetPromise = this.prepare(audio, {
      timestamp: Number.isFinite(timestamp) ? timestamp : this.currentTimestampMs,
    })
      .then((packet) => {
        if (this.micState !== state) return packet;
        this.#storeMicPacket(state, packet);
        return copyPacket(packet);
      })
      .finally(() => {
        state.prepareInFlight = false;
      });
    state.preparePromise = packetPromise;
    return packetPromise;
  }

  /**
   * Waits for a prepared microphone packet, collecting enough audio first when
   * packet preparation is configured on demand.
   */
  async waitForLocalPacket(desiredTimestamp = this.currentTimestampMs) {
    if (!Number.isFinite(desiredTimestamp)) {
      throw new TypeError("waitForLocalPacket() needs a finite timestamp.");
    }
    const existingPacket = this.getLocalPacket(desiredTimestamp);
    if (existingPacket) return existingPacket;
    const state = this.micState;
    if (!state) throw new Error("No microphone pipeline is running.");

    const packet = await new Promise((resolve, reject) => {
      state.packetWaiters.push({ desiredTimestamp, resolve, reject });
      this.#prepareWaitingMicPacket(state);
    });
    return packet;
  }

  /** Returns a copy of the microphone packet nearest to the requested time. */
  getLocalPacket(desiredTimestamp = this.currentTimestampMs) {
    const history = this.micState?.packetHistory;
    if (!history?.length) return null;
    let closest = history[0];
    let distance = Math.abs(closest.timestamp - desiredTimestamp);
    for (let index = 1; index < history.length; index += 1) {
      const candidate = history[index];
      const candidateDistance = Math.abs(candidate.timestamp - desiredTimestamp);
      if (candidateDistance < distance) {
        closest = candidate;
        distance = candidateDistance;
      }
    }
    return copyPacket(closest);
  }

  /** Compares a peer packet with the closest locally prepared microphone packet. */
  async compareToSelf(packetFromOtherDevice) {
    if (!Number.isFinite(packetFromOtherDevice?.timestamp)) {
      throw new TypeError("compareToSelf() needs a timestamped packet from the other device.");
    }
    const localPacket = this.getLocalPacket(packetFromOtherDevice.timestamp);
    if (!localPacket) {
      throw new Error("No prepared local microphone packet is available yet.");
    }
    return this.compare(localPacket, packetFromOtherDevice);
  }

  /** Stops microphone capture and clears its local packet history. */
  async stopMicAudio() {
    const state = this.micState;
    if (!state) return;
    this.micState = null;
    for (const waiter of state.packetWaiters) {
      waiter.reject(new Error("Microphone capture stopped before a packet was ready."));
    }
    state.packetWaiters = [];
    state.captureNode.port.onmessage = null;
    state.captureNode.disconnect();
    state.source.disconnect();
    state.silentGain.disconnect();
    for (const track of state.stream.getTracks()) track.stop();
    await state.context.close();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    void this.stopMicAudio();
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("AudioCompare disposed"));
    this.pending.clear();
  }
}
