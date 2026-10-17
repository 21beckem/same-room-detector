#!/usr/bin/env node
/* Validate the packetized WASM core against the Python mel+flux reference. */

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const loader = require("@assemblyscript/loader");
const parity = require("../js_parity/parity_javascript.js");

const ROOT = path.resolve(__dirname, "..", "..");
const MODEL_PATH = path.join(ROOT, "model_output", "model.json");
const PYTHON_OUTPUT = path.join(__dirname, "..", "py_parity", "python-output.json");
const WASM_PATH = path.join(__dirname, "wasm", "same_room.wasm");
const SCORE_TOLERANCE = 1e-3;
const SR = 16000;

function label(value) { return value === 2 ? "close" : value === 1 ? "middle" : "unrelated"; }

function configure(wasm, model) {
  const c = model.config;
  wasm.configure(model.intercept, model.mean[0], model.mean[1], model.std[0], model.std[1], model.coef[0], model.coef[1], c.window_sec, c.hop_sec, c.max_lag, c.min_sec);
}

function wasmResult(wasm) {
  const windows = [];
  for (let i = 0; i < wasm.getWindowCount(); i += 1) windows.push(wasm.getWindowScore(i));
  return {
    score: wasm.getScore(), label: label(wasm.getLabel()), window_scores: windows,
    features: { mel_peak: wasm.getFeature(0), flux_peak: wasm.getFeature(1) },
    lags: { mel: wasm.getLag(0), flux: wasm.getLag(1) },
    quality: { ok: wasm.getQualityFlags() === 0, notes: [], level_dbfs: wasm.getLevel(), activity_db: wasm.getActivity() },
    seconds: wasm.getSeconds(),
  };
}

function compareNumbers(a, b, pathName, differences) {
  const absolute = Math.abs(a - b);
  const relative = absolute / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
  differences.push({ path: pathName, python: a, wasm: b, absolute, relative });
}

function compareResult(python, wasm, prefix, differences) {
  compareNumbers(python.score, wasm.score, `${prefix}.score`, differences);
  if (python.label !== wasm.label) differences.push({ path: `${prefix}.label`, python: python.label, wasm: wasm.label });
  for (let i = 0; i < python.window_scores.length; i += 1) compareNumbers(python.window_scores[i], wasm.window_scores[i], `${prefix}.window_scores.${i}`, differences);
  for (const name of ["mel_peak", "flux_peak"]) compareNumbers(python.features[name], wasm.features[name], `${prefix}.features.${name}`, differences);
  for (const name of ["mel", "flux"]) compareNumbers(python.lags[name], wasm.lags[name], `${prefix}.lags.${name}`, differences);
  compareNumbers(python.quality.level_dbfs, wasm.quality.level_dbfs, `${prefix}.quality.level_dbfs`, differences);
  compareNumbers(python.quality.activity_db, wasm.quality.activity_db, `${prefix}.quality.activity_db`, differences);
  compareNumbers(python.seconds, wasm.seconds, `${prefix}.seconds`, differences);
}

function packetBytes(wasm, handle) {
  const bytes = new Uint8Array(wasm.getPacketByteLength(handle));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = wasm.getPacketByte(handle, i);
  return bytes;
}

function packetSize(wasm, handle) { return wasm.getPacketByteLength(handle); }

function runChunkGridTest(wasm, audio) {
  const full = wasm.prepareDevice(wasm.__newArray(wasm.FLOAT64ARRAY_ID, Array.from(audio)), 0, 0, false);
  let merged = 0;
  const chunkSamples = 2 * SR;
  const overlap = 3 * 320;
  let first = 0;
  while (first < audio.length) {
    const end = Math.min(audio.length, first + chunkSamples);
    const chunk = audio.slice(first, end);
    const handle = wasm.prepareDevice(wasm.__newArray(wasm.FLOAT64ARRAY_ID, Array.from(chunk)), first, 0, false);
    merged = merged === 0 ? handle : wasm.mergeDevices(merged, handle);
    if (end === audio.length) break;
    first += chunkSamples - overlap;
  }
  const frameCount = wasm.getPacketFrameCount(full);
  const sameFrameCount = frameCount === wasm.getPacketFrameCount(merged);
  let maxMelDifference = 0;
  const count = Math.min(frameCount, wasm.getPacketFrameCount(merged));
  for (let band = 0; band < 40; band += 1) for (let frame = 0; frame < count; frame += 1) {
    maxMelDifference = Math.max(maxMelDifference, Math.abs(wasm.getPacketMelValue(full, band, frame) - wasm.getPacketMelValue(merged, band, frame)));
  }
  return { recording_samples: audio.length, divides_evenly: audio.length % chunkSamples === 0, chunk_seconds: chunkSamples / SR, overlap_samples: overlap, full_frames: frameCount, merged_frames: wasm.getPacketFrameCount(merged), same_frame_count: sameFrameCount, max_mel_difference: maxMelDifference };
}

async function main() {
  const pairLimitArg = process.argv.indexOf("--pair-limit");
  const pairLimit = pairLimitArg >= 0 ? Number(process.argv[pairLimitArg + 1]) : Infinity;
  const pythonOutputArg = process.argv.indexOf("--python-output");
  const pythonOutput = pythonOutputArg >= 0 ? path.resolve(process.argv[pythonOutputArg + 1]) : PYTHON_OUTPUT;
  const bitsArg = process.argv.indexOf("--bits");
  const bits = bitsArg >= 0 ? Number(process.argv[bitsArg + 1]) : 8;
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));
  const python = JSON.parse(fs.readFileSync(pythonOutput, "utf8"));
  const wasmInstance = await loader.instantiate(fs.readFileSync(WASM_PATH), {});
  const wasm = wasmInstance.exports;
  configure(wasm, model);

  const files = new Map();
  for (const filePath of parity.discoverFiles()) { const item = parity.itemFromPath(filePath); files.set(item.label, parity.loadAudio(filePath)); }

  const rawHandles = new Map(), quantHandles = new Map(), rawPrep = [], quantPrep = [];
  for (const [name, audio] of files) {
    let started = performance.now();
    rawHandles.set(name, wasm.prepareDevice(wasm.__newArray(wasm.FLOAT64ARRAY_ID, Array.from(audio)), 0, 0, false));
    rawPrep.push(performance.now() - started);
    started = performance.now();
    quantHandles.set(name, wasm.prepareDevice(wasm.__newArray(wasm.FLOAT64ARRAY_ID, Array.from(audio)), 0, bits, true));
    quantPrep.push(performance.now() - started);
  }

  const differences = [], rows = [], rawPairTimings = [], quantPairTimings = [];
  for (const pair of python.pairs.slice(0, pairLimit)) {
    let started = performance.now();
    wasm.compareDevices(rawHandles.get(pair.a), rawHandles.get(pair.b));
    const rawElapsed = performance.now() - started;
    const rawResult = wasmResult(wasm);
    started = performance.now();
    wasm.compareDevices(quantHandles.get(pair.a), quantHandles.get(pair.b));
    const quantElapsed = performance.now() - started;
    const quantResult = wasmResult(wasm);
    rawPairTimings.push(rawElapsed); quantPairTimings.push(quantElapsed);
    compareResult(pair.result, rawResult, `${pair.a}|${pair.b}`, differences);
    rows.push({ pair: `${pair.a} vs ${pair.b}`, python_score: pair.result.score, raw_wasm_score: rawResult.score, quantized_wasm_score: quantResult.score, raw_delta: rawResult.score - pair.result.score, quantized_delta: quantResult.score - pair.result.score, python_label: pair.result.label, raw_wasm_label: rawResult.label, quantized_wasm_label: quantResult.label, raw_pair_ms: rawElapsed, quantized_pair_ms: quantElapsed });
  }

  const chunkAudio = files.get(python.files[0].label);
  const chunkGrid = runChunkGridTest(wasm, chunkAudio);
  const firstPair = python.pairs[0];
  const serializedA = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, Array.from(packetBytes(wasm, rawHandles.get(firstPair.a)))));
  const serializedB = wasm.loadDevicePacket(wasm.__newArray(wasm.UINT8ARRAY_ID, Array.from(packetBytes(wasm, rawHandles.get(firstPair.b)))));
  const serializedRoundTripBytes = packetSize(wasm, serializedA);
  wasm.compareDevices(serializedA, serializedB);
  const serializedRoundTripScoreDelta = wasm.getScore() - firstPair.result.score;
  const numeric = differences.filter((difference) => typeof difference.absolute === "number");
  const report = {
    implementation: "assemblyscript-wasm-packetized",
    model_features: model.features,
    files_loaded: files.size,
    pairs_compared: rows.length,
    exact_label_matches: rows.filter((row) => row.python_label === row.raw_wasm_label).length,
    max_absolute_difference: numeric.length ? Math.max(...numeric.map((difference) => difference.absolute)) : 0,
    max_relative_difference: numeric.length ? Math.max(...numeric.map((difference) => difference.relative)) : 0,
    max_score_difference: rows.length ? Math.max(...rows.map((row) => Math.abs(row.raw_delta))) : 0,
    score_tolerance: SCORE_TOLERANCE,
    quantization: { bits, enabled: true },
    packet_bytes: { raw_unquantized_first: packetSize(wasm, rawHandles.get(python.files[0].label)), quantized_first: packetSize(wasm, quantHandles.get(python.files[0].label)), raw_unquantized_average: [...rawHandles.values()].reduce((sum, handle) => sum + packetSize(wasm, handle), 0) / rawHandles.size, quantized_average: [...quantHandles.values()].reduce((sum, handle) => sum + packetSize(wasm, handle), 0) / quantHandles.size, serialized_round_trip: serializedRoundTripBytes },
    serialized_round_trip_score_delta: serializedRoundTripScoreDelta,
    timing_ms: { per_device_raw_average: rawPrep.reduce((a, b) => a + b, 0) / rawPrep.length, per_device_quantized_average: quantPrep.reduce((a, b) => a + b, 0) / quantPrep.length, raw_pair_average: rawPairTimings.reduce((a, b) => a + b, 0) / rawPairTimings.length, quantized_pair_average: quantPairTimings.reduce((a, b) => a + b, 0) / quantPairTimings.length, raw_pair_samples: rawPairTimings, quantized_pair_samples: quantPairTimings },
    chunk_grid_test: chunkGrid,
    pairs: rows,
    first_differences: differences.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = rows.length && rows.some((row) => row.python_label !== row.raw_wasm_label || Math.abs(row.raw_delta) > SCORE_TOLERANCE) ? 2 : 0;
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
