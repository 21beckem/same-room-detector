# Standalone WASM parity core

This directory contains the first standalone WebAssembly implementation of the numerical scoring core.

From `web-calibration/wasm_parity/`:

```powershell
npm install
npm run build:wasm
npm run test:wasm
```

`wasm_parity_runner.js` loads the compiled module in Node, reads the existing WAV fixtures through the JavaScript parity loader, and compares four representative pairs with the Python baseline at `../py_parity/python-output.json`.

The WASM boundary currently accepts mono `Float64Array` buffers already normalized to 16 kHz. Explicit WAV decoding and resampling remain outside the module so that the browser input contract can be tested separately from the numerical core. The eventual browser worker must perform this normalization explicitly and must not rely on an implicit `AudioContext` sample-rate conversion.

The current optimized build completed the four comparisons in roughly 0.42–0.51 seconds per pair and all four labels matched Python. Scores stayed within the runner's `1e-3` tolerance. The implementation uses power-of-two FFT lengths for speed; SciPy uses different `next_fast_len` choices, so GCC-PHAT lags and some low-confidence scores are not bit-for-bit identical yet. The runner reports those differences instead of hiding them.
