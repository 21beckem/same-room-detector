# AudioCompare

`compare.js` is the reusable browser API for the same-room model. It owns the
worker, loads the model and WASM files, keeps raw audio inside the worker
boundary, and only compares serialized per-device packets.

```js
import { AudioCompare } from "./compare.js";

const compare = await AudioCompare.fromObject({
  modelUrl: "/model_output/model.json",
  wasmUrl: "/web-calibration/wasm_parity/wasm/same_room.wasm",
});

const packetA = await compare.prepare(mono16kSamplesA);
const packetB = await compare.prepare(mono16kSamplesB);
const result = await compare.compare(packetA, packetB);

console.log(result.score, result.label, result.windowScores, result.quality);
compare.dispose();
```

`prepare()` accepts mono, normalized 16 kHz samples as an `Array`,
`Float32Array`, `Float64Array`, or an `AudioBuffer`. It returns an
`ArrayBuffer` containing the compact packet, which can be sent over a
WebSocket or retained for comparisons with many other devices. `compare()`
does not transfer or detach those input buffers, so a prepared packet remains
reusable. WAV decoding and resampling are application-specific; the included
demos show how to normalize their inputs before calling `prepare()`.

The default packet format is 8-bit quantized mel data. Override it with
`bitDepth` and `quantize` in the factory options or per-call options:

```js
const unquantized = await compare.prepare(samples, { quantize: false });
```

`AudioComparison` exposes `score`, `label`, `windowScores`, `features`,
`lags`, `quality`, `seconds`, `pairMs`, `deviceMs`, and `totalMs`. Snake-case
aliases are also provided for compatibility with the original demos.
