# AGENTS.md

## Project purpose

Same-Room Detection Mesh compares two audio recordings and estimates whether they were captured in the same physical room. The repository now contains three layers:

1. The original Python implementation and terminal scorer.
2. A JavaScript/WASM parity harness used to validate browser-compatible numerical behavior.
3. A minimal browser demo that loads the model and performs inference entirely in a Web Worker using WASM.

The longer-term product is expected to compare live audio from two browser devices connected through PeerJS/WebRTC.

## Repository layout

- `data-exploration/colocation.py` is the main implementation. It extracts synchronization features, trains a small NumPy logistic-regression model, performs leave-one-group-out validation, and scores two files.
- `data-exploration/explore_room_audio.py` is for exploratory feature analysis and plots.
- `data-exploration/evaluate_all_pairs.py` scores all discovered recordings with a trained model and writes a matrix/report.
- `data-exploration/pick_and_score.py` provides an interactive terminal picker for scoring recordings.
- `data-exploration/room-audio-recordings/` contains labelled WAV data.
- `model_output/` is the canonical root-level location for `model.json`, cross-validation data, and generated model reports.
- `eval_output/` and `exploration_output/` contain generated CSV reports and plots. Treat generated outputs as reproducible artifacts, not hand-edited source.
- `web-calibration/py_parity/` contains the Python reference-output and timing runner.
- `web-calibration/js_parity/` contains the dependency-free JavaScript parity implementation and comparison/timing runners.
- `web-calibration/wasm_parity/` contains the AssemblyScript source, compiled WASM module, Node parity runner, and its npm package.
- `web-wasm-demo/` contains the browser demo. `server.js` serves the UI, model, WASM, manifest, and WAV files; browser decoding and scoring happen in `analysis-worker.js`.

## Development environment

Use the existing local virtual environment when available. From the repository root on Windows PowerShell:

```powershell
.\venv\Scripts\Activate.ps1
python -m pip install numpy scipy matplotlib soundfile
```

`soundfile` is optional at runtime because the code falls back to `scipy.io.wavfile`, but it is useful for broad WAV support. There is currently no lockfile or requirements file; if dependencies are formalized, keep the commands in this document and the README in sync.

The WASM parity package uses the existing Node/npm installation. Its `node_modules/` directory is ignored and must be recreated with `npm install` when needed.

## Data conventions

Training and exploratory scripts expect this layout:

```text
room-audio-recordings/
  <category>/
    group-<number>/
      <name>_A.wav
      <name>_B.wav
```

The default categories are `close` (target 1.0), `apart` (0.5), and `gone` (0.0). A group represents one recording session/pair and is the unit used for validation. Do not put generated output inside a dataset category or change the `_A.wav`/`_B.wav` naming convention without updating discovery code.

## Common commands

Python commands run from `data-exploration/` so the default relative paths resolve correctly:

```powershell
cd data-exploration

# Explore features and create plots
python explore_room_audio.py room-audio-recordings --out exploration_output

# Train and validate a model
python colocation.py train room-audio-recordings --out ../model_output

# Score two WAV files
python colocation.py score ../model_output/model.json path\to\a.wav path\to\b.wav --json

# Evaluate every available pair
python evaluate_all_pairs.py --root room-audio-recordings --model ../model_output/model.json --out eval_output

# Use the interactive terminal scorer
python pick_and_score.py --root room-audio-recordings --model ../model_output/model.json
```

Generate and compare the parity outputs from the repository root:

```powershell
# Python reference output
.\venv\Scripts\python.exe web-calibration\py_parity\parity_python.py

# JavaScript parity output compared with Python
node web-calibration\js_parity\parity_javascript.js --compare web-calibration\py_parity\python-output.json

# Build and test the standalone WASM core
cd web-calibration\wasm_parity
npm install
npm run build:wasm
npm run test:wasm
cd ..\..
```

Run the browser demo:

```powershell
cd web-wasm-demo
npm start
```

Open `http://localhost:3000`. The demo discovers the valid A/B WAV pairs from the dataset and provides two selectors plus a Compare button.

The main pipeline resamples audio to 16 kHz, converts it to mono, uses overlapping windows, and compares GCC-PHAT, log-mel energy-envelope, and onset-flux synchronization features. Scores are estimates, not proof of co-location; inspect quality notes and validation output, especially for quiet or highly stationary recordings.

## Implementation guidance

- Keep feature extraction deterministic and make changes compatible with both training and scoring.
- Preserve group-aware validation. Do not randomly split windows from the same recording across train and validation, since that leaks recording/session information.
- When adding a feature, update training, inference, model serialization, reports, and any plots together. Prefer explicit model/config fields over hidden constants.
- Avoid committing large generated datasets or regenerated plots unless the change specifically requires them. Do not commit virtual environments, caches, or secrets.
- Add small, deterministic tests for numerical behavior when changing signal processing. At minimum, check audio loading/resampling, lag sign conventions, feature vector shape, and score output structure.
- Use `pathlib.Path` and cross-platform Python commands. Keep terminal UI code separate from reusable signal-processing/model code.
- Keep `model_output/model.json` as the canonical model artifact. The WASM and browser layers must consume its serialized coefficients and configuration rather than duplicating model constants.
- Keep all audio decoding, explicit resampling, feature preparation, and inference in the browser for `web-wasm-demo`; the Node server may only serve files and return the audio manifest.
- Keep the public browser API simple: `SameRoomAnalyzer` owns the worker and exposes `load()`, `ready()`, `compare()`, `compareBuffers()`, and `dispose()`. The worker owns the reusable `SameRoomModel` WASM wrapper.
- The current WASM boundary accepts normalized mono 16 kHz `Float64Array` buffers. Browser input preparation must explicitly decode WAV, convert to mono, resample to 16 kHz, truncate to 20 seconds, and remove the mean before calling WASM.
- Do not claim bit-for-bit Python equality for the current WASM implementation. It uses power-of-two FFT sizes while SciPy may choose different `next_fast_len` sizes. Labels currently match the representative parity cases and scores stay within the runner's `1e-3` tolerance, but GCC-PHAT lags and some scores can differ.

## Browser/WebRTC direction

The current file-based browser demo is the foundation for the eventual live-audio version. Reuse its `SameRoomAnalyzer`, worker boundary, input normalization contract, and result shape while replacing the server recording URLs with live buffers.

The eventual live-audio version should separate transport from analysis:

1. Capture microphone streams in each browser.
2. Exchange live audio through PeerJS/WebRTC.
3. Buffer short, timestamped windows and account for clock/start-offset differences.
4. Run compatible feature extraction locally in the browser worker/WASM boundary.
5. Return a score, label, quality flags, and useful lag/feature diagnostics.

Do not assume that file-based alignment, Python-only libraries, or synchronized device clocks will carry over unchanged. Keep the scoring contract and feature definitions documented so a future JavaScript/WebAudio implementation can be compared against Python fixtures. Treat microphone audio as sensitive: minimize retention, avoid transmitting raw audio unless required, and document permissions and failure states.

## Verification before handoff

For code changes, run the affected command against the included dataset when practical and confirm that expected files are produced. For model or signal-processing changes, compare validation metrics and representative scores before and after the change. For browser changes, run the demo and exercise at least one same-group and one different-group comparison when practical. Check browser console errors and verify that processing remains in the worker. Report any unrun checks, missing data, or environment limitations rather than presenting generated output as verified.
