# Same-room WASM web demo

This is the browser equivalent of `data-exploration/pick_and_score.py`.
Audio decoding, explicit 16 kHz normalization, and model inference happen in
the browser. The Node server only serves static files and provides the audio
manifest.

From this directory:

```powershell
# If the WASM parity dependencies have not been installed yet:
cd ..\web-calibration\wasm_parity
npm install
cd ..\..\web-wasm-demo
npm start
```

Then open <http://localhost:3000>.

The public browser API is `SameRoomAnalyzer`. It owns the worker and exposes
`load()`, `ready()`, `compare(recordingA, recordingB)`,
`compareBuffers(audioA, audioB, metadataA, metadataB)`, and `dispose()`.
The worker contains the reusable `SameRoomModel` WASM wrapper.
