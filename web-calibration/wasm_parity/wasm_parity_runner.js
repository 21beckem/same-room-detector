#!/usr/bin/env node
/* Run the standalone WASM core against the existing Python parity baseline. */

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

function label(value) { return value === 2 ? "close" : value === 1 ? "middle" : "unrelated"; }

function configure(wasm, model) {
  const c = model.config;
  wasm.configure(model.intercept, model.mean[0], model.mean[1], model.mean[2], model.std[0], model.std[1], model.std[2], model.coef[0], model.coef[1], model.coef[2], c.window_sec, c.hop_sec, c.max_lag, c.min_sec);
}

function wasmResult(wasm) {
  const windows = [];
  for (let i = 0; i < wasm.getWindowCount(); i += 1) windows.push(wasm.getWindowScore(i));
  return {
    score: wasm.getScore(),
    label: label(wasm.getLabel()),
    window_scores: windows,
    features: { gcc_peak: wasm.getFeature(0), mel_peak: wasm.getFeature(1), flux_peak: wasm.getFeature(2) },
    lags: { gcc: wasm.getLag(0), mel: wasm.getLag(1), flux: wasm.getLag(2) },
    quality: {
      ok: wasm.getQualityFlags() === 0,
      notes: [],
      level_dbfs: wasm.getLevel(),
      activity_db: wasm.getActivity(),
    },
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
  for (const name of ["gcc_peak", "mel_peak", "flux_peak"]) compareNumbers(python.features[name], wasm.features[name], `${prefix}.features.${name}`, differences);
  for (const name of ["gcc", "mel", "flux"]) compareNumbers(python.lags[name], wasm.lags[name], `${prefix}.lags.${name}`, differences);
  compareNumbers(python.quality.level_dbfs, wasm.quality.level_dbfs, `${prefix}.quality.level_dbfs`, differences);
  compareNumbers(python.quality.activity_db, wasm.quality.activity_db, `${prefix}.quality.activity_db`, differences);
  compareNumbers(python.seconds, wasm.seconds, `${prefix}.seconds`, differences);
}

async function main() {
  const pairLimitArg = process.argv.indexOf("--pair-limit");
  const pairLimit = pairLimitArg >= 0 ? Number(process.argv[pairLimitArg + 1]) : Infinity;
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));
  const python = JSON.parse(fs.readFileSync(PYTHON_OUTPUT, "utf8"));
  const wasm = await loader.instantiate(fs.readFileSync(WASM_PATH), {});
  configure(wasm.exports, model);

  const files = new Map();
  for (const filePath of parity.discoverFiles()) {
    const item = parity.itemFromPath(filePath);
    files.set(item.label, parity.loadAudio(filePath));
  }

  const wasmArrays = new Map();
  function wasmArray(labelName) {
    if (!wasmArrays.has(labelName)) wasmArrays.set(labelName, wasm.exports.__newArray(wasm.exports.FLOAT64ARRAY_ID, Array.from(files.get(labelName))));
    return wasmArrays.get(labelName);
  }

  const differences = [];
  const rows = [];
  const timings = [];
  for (const pair of python.pairs.slice(0, pairLimit)) {
    const a = wasmArray(pair.a), b = wasmArray(pair.b);
    const started = performance.now();
    wasm.exports.scoreAudio(a, b);
    const elapsed = performance.now() - started;
    const result = wasmResult(wasm.exports);
    timings.push(elapsed);
    compareResult(pair.result, result, `${pair.a}|${pair.b}`, differences);
    rows.push({ pair: `${pair.a} vs ${pair.b}`, python_score: pair.result.score, wasm_score: result.score, delta: result.score - pair.result.score, python_label: pair.result.label, wasm_label: result.label, wasm_ms: elapsed });
  }

  const numeric = differences.filter((difference) => typeof difference.absolute === "number");
  const maxAbsolute = numeric.length ? Math.max(...numeric.map((difference) => difference.absolute)) : 0;
  const maxRelative = numeric.length ? Math.max(...numeric.map((difference) => difference.relative)) : 0;
  const timingAverage = timings.reduce((a, b) => a + b, 0) / timings.length;
  const report = {
    implementation: "assemblyscript-wasm",
    files_loaded: files.size,
    pairs_compared: rows.length,
    exact_label_matches: rows.filter((row) => row.python_label === row.wasm_label).length,
    max_absolute_difference: maxAbsolute,
    max_relative_difference: maxRelative,
    max_score_difference: Math.max(...rows.map((row) => Math.abs(row.delta))),
    score_tolerance: SCORE_TOLERANCE,
    timing_ms: { average: timingAverage, min: Math.min(...timings), max: Math.max(...timings), samples: timings },
    pairs: rows,
    first_differences: differences.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = rows.length && rows.some((row) => row.python_label !== row.wasm_label || Math.abs(row.delta) > SCORE_TOLERANCE) ? 2 : 0;
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
