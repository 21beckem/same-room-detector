# MeshedPeers

`MeshedPeers` is the UI-independent browser client for the same-room mesh.
It owns microphone capture, the local WASM analyzer, PeerJS connections,
random peer discovery, nearby-peer reassessment, retries, and peer messaging.

The model and WASM URLs are configuration values. This package intentionally
does not contain copies of `model.json` or `same_room.wasm`.

```js
import { MeshedPeers } from "./meshed-peers/src/index.js";

const mesh = MeshedPeers.fromObject({
  peerServer: {
    host: "localhost",
    port: 9000,
    path: "/peerjs",
    secure: false,
  },
  meshServerUrl: "http://localhost:9000/peerjs",
  modelUrl: "../model_output/model.json",
  wasmUrl: "../web-calibration/wasm_parity/wasm/same_room.wasm",
});

mesh.on("new-nearby-peer", (peerId, details) => console.log("nearby", peerId, details));
mesh.on("broadcast", (senderId, message) => console.log(senderId, message));
await mesh.begin();
```

`begin()` must be called from a user interaction because it requests the
microphone. Processing happens locally in a Web Worker; raw audio is not sent
to the matchmaking server.

The local microphone remains in a rolling in-memory buffer. Capture chunks and
snapshots carry audio-clock timestamps. The peer with the lower PeerJS ID
coordinates each exchange over a separate binary data channel: it requests a
cycle, estimates the two browser clocks from the request/ready handshake, and
starts the exchange with a target capture end time. Both sides then send the
same recent time interval, tagged with the cycle ID. The analyzer uses those
stored, time-aligned snapshots rather than whichever live buffer happens to be
newest when a packet arrives. This avoids simultaneous reassessment timers,
prevents stale snapshots from satisfying a newer comparison, and gives
snapshot transfer its own timeout. A first comparison waits until each browser
has enough local audio; later checks reuse the already-running buffers instead
of starting a new listening period. No live audio MediaConnection is needed,
and the matchmaking server never receives audio.

Capture liveness is tracked separately from audio-clock timestamps, so a paused
or resumed `AudioContext` cannot permanently make otherwise-new audio look stale.
The client listens for context and microphone-track lifecycle changes, attempts
to resume capture when the page becomes visible or receives user input, and
reports explicit suspended, muted, ended, or stale-capture statuses when
comparison must wait.
