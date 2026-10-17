# Packetized WASM core

From `web-calibration/wasm_parity/`:

```powershell
npm install
npm run build:wasm
npm run test:wasm
```

The core has two stages. `prepareDevice(audio, globalStartSample, bitDepth, quantize)` extracts mel frames on the global 320-sample grid and returns a packet handle. `getPacketByte*` exposes the serialized packet for transport, and `loadDevicePacket` accepts it on the receiving side. `mergeDevices` combines overlapping chunk packets without re-reading raw audio. `compareDevices(packetA, packetB)` consumes only packet handles and returns the score.

Packets contain 40-band log-mel frames, per-band quantization metadata, the audio span, and RMS/activity values. At 8-bit quantization, the representative 15.8-second recording in the included set uses about 32 KiB instead of about 253 KiB for the unquantized float64 packet, and raw waveform input is not part of the packet.

The mel pair correlation sums all 40 cross-spectra before one inverse FFT. Because the inverse FFT is linear, this is the same sum-and-normalize calculation as the earlier one-inverse-FFT-per-band implementation; the parity runner checks the unquantized result against Python.

`wasm_parity_runner.js` also checks 8-bit quantized scoring, packet serialization round-trip, and chunk merging using consecutive 2-second chunks with 960 samples of overlap. The chunk test uses a recording whose length is not divisible by 2 seconds and checks that the merged globally anchored mel frames equal a single batch extraction.

The current implementation uses power-of-two FFT lengths while SciPy may choose different `next_fast_len` values in other contexts. The packetized WASM parity cases use the same power-of-two-compatible reference path and are checked by the runner rather than presented as a general bit-for-bit claim for arbitrary Python FFT configurations.
