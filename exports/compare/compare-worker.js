import loader from "./assemblyscript-loader.js";

let wasm = null;
let model = null;

function label(value) { return value === 2 ? "close" : value === 1 ? "middle" : "unrelated"; }

function qualityNotes(flags, windowSeconds) {
  const notes = [];
  if (flags & 1) notes.push("very quiet input");
  if (flags & 2) notes.push("very steady sound: little happening to compare");
  if (flags & 4) notes.push(`shorter than the ${windowSeconds.toFixed(0)} s training window`);
  if (flags & 8) notes.push("windows disagree with each other");
  return notes;
}

async function initialize(modelUrl, wasmUrl) {
  const [modelResponse, wasmResponse] = await Promise.all([fetch(modelUrl), fetch(wasmUrl)]);
  if (!modelResponse.ok) throw new Error(`Could not load model (${modelResponse.status}): ${modelUrl}`);
  if (!wasmResponse.ok) throw new Error(`Could not load WASM (${wasmResponse.status}): ${wasmUrl}`);
  const [loadedModel, wasmBytes] = await Promise.all([modelResponse.json(), wasmResponse.arrayBuffer()]);
  const instance = await loader.instantiate(wasmBytes, {});
  wasm = instance.exports;
  model = loadedModel;
  const c = model.config;
  wasm.configure(model.intercept, model.mean[0], model.mean[1], model.std[0], model.std[1], model.coef[0], model.coef[1], c.window_sec, c.hop_sec, c.max_lag, c.min_sec);
  return { config: model.config, targets: model.targets || {}, cv: model.cv || null };
}

function packetBytes(handle) {
  const bytes = new Uint8Array(wasm.getPacketByteLength(handle));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = wasm.getPacketByte(handle, i);
  return bytes;
}

function readResult(pairMs) {
  const flags = wasm.getQualityFlags();
  const windowScores = [];
  for (let i = 0; i < wasm.getWindowCount(); i += 1) windowScores.push(wasm.getWindowScore(i));
  return {
    score: wasm.getScore(),
    label: label(wasm.getLabel()),
    windowScores,
    features: { mel_peak: wasm.getFeature(0), flux_peak: wasm.getFeature(1) },
    lags: { mel: wasm.getLag(0), flux: wasm.getLag(1) },
    quality: {
      ok: flags === 0,
      notes: qualityNotes(flags, model.config.window_sec),
      level_dbfs: wasm.getLevel(),
      activity_db: wasm.getActivity(),
    },
    seconds: wasm.getSeconds(),
    pairMs,
  };
}

function prepare(message) {
  const samples = new Float64Array(message.audio);
  let handle;
  try {
    const input = wasm.__newArray(wasm.FLOAT64ARRAY_ID, samples);
    handle = wasm.prepareDevice(input, message.globalStartSample, message.bitDepth, message.quantize);
    return { packet: packetBytes(handle).buffer };
  } finally {
    if (handle !== undefined) wasm.releaseDevice(handle);
    wasm.__collect?.();
  }
}

function compare(message) {
  let handleA;
  let handleB;
  try {
    const bytesA = new Uint8Array(message.packetA);
    const bytesB = new Uint8Array(message.packetB);
    for (const [name, bytes] of [["A", bytesA], ["B", bytesB]]) {
      if (bytes.byteLength < 688) throw new Error(`Prepared packet ${name} is too short (${bytes.byteLength} bytes)`);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const frameCount = view.getInt32(28, true);
      if (frameCount < 0 || frameCount > 100000) throw new Error(`Prepared packet ${name} has invalid frame count ${frameCount}`);
      const quantized = view.getInt32(8, true) !== 0;
      const expectedBytes = 688 + 40 * frameCount * (quantized ? 1 : 8);
      if (expectedBytes > bytes.byteLength) throw new Error(`Prepared packet ${name} is truncated (${bytes.byteLength} of ${expectedBytes} bytes)`);
    }
    handleA = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, bytesA));
    handleB = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, bytesB));
    const started = performance.now();
    wasm.compareDevices(handleA, handleB);
    return readResult(performance.now() - started);
  } finally {
    if (handleA !== undefined) wasm.releaseDevice(handleA);
    if (handleB !== undefined) wasm.releaseDevice(handleB);
    wasm.__collect?.();
  }
}

self.onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    let result;
    if (type === "init") result = await initialize(event.data.modelUrl, event.data.wasmUrl);
    else if (type === "prepare") result = prepare(event.data);
    else if (type === "compare") result = compare(event.data);
    else throw new Error(`Unknown AudioCompare worker message: ${type}`);
    self.postMessage({ id, type: "result", result }, result?.packet ? [result.packet] : []);
  } catch (error) {
    self.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

