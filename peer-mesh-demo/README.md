# MeshedPeers debug UI

This page is a thin UI over `meshed-peers`. It does not implement PeerJS,
microphone capture, audio comparison, matchmaking, or retry behavior itself.

Start the custom server from `mesh-peer-server`:

```powershell
cd ..\mesh-peer-server
npm install
npm run build
node mesh-server.mjs
```

Then serve the repository root so the demo can access the existing model and
WASM files without copying them:

```powershell
cd ..
python -m http.server 3000
```

Open `http://localhost:3000/peer-mesh-demo/` in two browser tabs or devices.
Microphone access requires localhost or HTTPS. For remote devices, use HTTPS
and configure the server host, TURN settings, and the URLs in `app.js`.
