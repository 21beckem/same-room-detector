import { MeshClient } from './mesh-client.js';

const statusDiv = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const broadcastBtn = document.getElementById('broadcast-btn');
const connectionDiv = document.getElementById('connection-status');
const eventLog = document.getElementById('event-log');

function showEvent(name, details) {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details, (_key, value) => {
        if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
        if (value instanceof Uint8Array) return `[Uint8Array ${value.byteLength} bytes]`;
        if (value instanceof Error) return value.message;
        return value;
    })}`;
    const line = `[${new Date().toLocaleTimeString()}] ${name}${suffix}`;
    console.log(line);
    if (eventLog) {
        eventLog.textContent = `${eventLog.textContent}\n${line}`.slice(0, 8_000);
        eventLog.scrollTop = eventLog.scrollHeight;
    }
}

MeshClient.on('connecting', () => {
    connectionDiv.textContent = 'Connecting to mesh server…';
    showEvent('connecting');
});
MeshClient.on('connected', (details) => {
    connectionDiv.textContent = `Connected (client ${details.uid})`;
    showEvent('connected', details);
});
MeshClient.on('disconnected', (details) => {
    connectionDiv.textContent = 'Disconnected from mesh server';
    broadcastBtn.disabled = true;
    showEvent('disconnected', details);
});
MeshClient.on('serverError', (details) => showEvent('server error', details));
MeshClient.on('initError', (details) => showEvent('initialization failed', details));
MeshClient.on('tsUpdate', (details) => showEvent('timestamp update', details));
MeshClient.on('relay', (details) => showEvent('relay received', {
    from: details.from,
    size: details.size,
    meta: details.meta,
}));
MeshClient.on('broadcast', (details) => showEvent('broadcast received', details));
MeshClient.on('relayMessage', (details) => showEvent('relay message received', details));
MeshClient.on('peerAdded', (details) => showEvent('peer added', details));
MeshClient.on('peerRemoved', (details) => showEvent('peer removed', details));
MeshClient.on('audioRequest', (details) => showEvent('audio request', details));

await MeshClient.init();

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
        const result = await MeshClient.begin();
        showEvent('MeshClient started', result);
    } catch (error) {
        showEvent('MeshClient start failed', { error });
        startBtn.disabled = false;
    }
});
broadcastBtn.addEventListener('click', async () => {
    broadcastBtn.disabled = true;
    try {
        const msg = { text: 'Hello, peers!' };
        showEvent('broadcasting message', { message: msg });
        await MeshClient.broadcast(msg);
    } catch (error) {
        showEvent('broadcast failed', { error });
    } finally {
        broadcastBtn.disabled = false;
    }
});

MeshClient.on('ready', () => {
    broadcastBtn.disabled = false;
    statusDiv.textContent = 'MeshClient is ready'; 
});
MeshClient.on('peersUpdated', () => {
    statusDiv.textContent = 'Peers updated: ' + MeshClient.peers.join(', ');
});
