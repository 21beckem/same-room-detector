#!/usr/bin/env node
/* Regression test: repeated short-lived packet comparisons must not grow WASM memory. */

const fs = require("fs");
const path = require("path");
const loader = require("@assemblyscript/loader");
const parity = require("../js_parity/parity_javascript.js");

const ROOT = path.resolve(__dirname, "..", "..");

function configure(wasm, model) {
  const c = model.config;
  wasm.configure(
    model.intercept,
    model.mean[0], model.mean[1], model.std[0], model.std[1],
    model.coef[0], model.coef[1],
    c.window_sec, c.hop_sec, c.max_lag, c.min_sec,
  );
}

async function main() {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, "model_output", "model.json"), "utf8"));
  const wasm = (await loader.instantiate(fs.readFileSync(path.join(__dirname, "wasm", "same_room.wasm")), {})).exports;
  configure(wasm, model);
  const recordings = parity.discoverFiles().slice(0, 2).map(parity.loadAudio);
  const memoryBytes = [];

  for (let iteration = 0; iteration < 20; iteration += 1) {
    let first;
    let second;
    try {
      first = wasm.prepareDevice(wasm.__newArray(wasm.FLOAT64ARRAY_ID, Array.from(recordings[0])), 0, 8, true);
      second = wasm.prepareDevice(wasm.__newArray(wasm.FLOAT64ARRAY_ID, Array.from(recordings[1])), 0, 8, true);
      wasm.compareDevices(first, second);
    } finally {
      if (first !== undefined) wasm.releaseDevice(first);
      if (second !== undefined) wasm.releaseDevice(second);
      wasm.__collect();
    }
    memoryBytes.push(wasm.memory.buffer.byteLength);
  }

  const settled = memoryBytes.slice(5);
  if (new Set(settled).size !== 1) {
    throw new Error(`WASM memory kept growing after warm-up: ${memoryBytes.join(", ")}`);
  }
  console.log(JSON.stringify({
    iterations: memoryBytes.length,
    memory_bytes: memoryBytes,
    stable_after_warmup: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
