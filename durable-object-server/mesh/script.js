import { AudioCompare } from '../../exports/compare/compare.js';
import { ProtocolClient } from '../src/protocol/client.js';
import { Geo } from './geo.js';
const isHostedLocally = (/(localhost)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/gm).test(window.location.hostname);

const debug = {
    log: (...a) => {
        if (true) console.log(`[${debug._timestamp()}]`, ...a);
    },
    _timestamp: () => {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
        return `${hours}:${minutes}:${seconds}:${milliseconds}`;
    },
    status: (msg) => {
        const statusEl = document.getElementById('status');
        if (statusEl) statusEl.textContent = msg;
        if (true) console.log(`[${debug._timestamp()}]`, msg);
    }
};
const keepAlive = (() => {
    const keepAwake = new NoSleep();
    function handleBeforeUnload(event) { if (!isHostedLocally) { event.preventDefault(); event.returnValue = ''; } }
    return {
        enable:  () => { keepAwake.enable();  window.addEventListener   ('beforeunload', handleBeforeUnload); },
        disable: () => { keepAwake.disable(); window.removeEventListener('beforeunload', handleBeforeUnload); },
    };
})();
const WebSocketServerUri = isHostedLocally ? `ws://${location.hostname}:8787` : 'wss://colocation.beckersuite.com';

const runBtn = document.getElementById('run-btn');
runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    link.send('trigger');
    debug.status('Triggering colocation...');
});

Geo.getLocation().then(({ lat, lng}) => {
    debug.log('Current location:', { lat, lng });
    link.send('location', { lat, lng });
}).catch((err) => {
    console.error('Failed to get location:', err);
    debug.status('Failed to get location: ' + err.message);
});
const link = new ProtocolClient(WebSocketServerUri);
window.link = link; // for debugging in console
try {
    await link.ready;
    debug.status(`Connected to server as ${link.uid}. Click "Start Recording" to begin.`);
} catch (err) {
    console.error('Failed to connect to server:', err);
    alert('Failed to connect to server. ' + err.message);
}
const analyzer = await AudioCompare.fromObject({});
link.handle('audioRequest', async (msg, ctx) => {
    debug.log('Received audio request from server:', msg);
    try {
        const packet = await analyzer.waitForLocalPacket();
        return { fields: { ts: packet.timestamp }, payload: packet.buffer };
    } catch (err) {
        console.error('Failed to wait for local packet:', err);
    }
});
link.on('colocation', (msg, ctx) => {
    const { score, peer } = msg.fields;
    debug.log(`Received colocation score from server: ${score} with peer ${peer}`);
    runBtn.disabled = false;
    debug.status(`Colocation score: ${score.toFixed(2)} with peer ${peer}`);
});
link.on('tsUpdate', (msg, ctx) => {
    analyzer.currentTimestampMs = msg.fields.ts;
});



// relay handling examples
link.handle('relay', ({ from, payload, meta, size }) => {
    debug.log(`Received relay from ${from} with size ${size} and meta:`, meta);
    const blob = new Blob([payload], { type: meta?.type });
    const url = URL.createObjectURL(blob);
    const linkEl = document.createElement('a');
    linkEl.href = url;
    linkEl.download = meta?.name || 'relay.bin';
    document.body.appendChild(linkEl);
    linkEl.click();
    setTimeout(() => {
        document.body.removeChild(linkEl);
        URL.revokeObjectURL(url);
    }, 1000);
});
link.handle('relayMsg', ({ from, msg }) => {
    console.log(`Received relayMsg from ${from}:`, msg);
});

const startRecordingBtn = document.getElementById('start-recording-btn');
startRecordingBtn.addEventListener('click', () => {
    startRecordingBtn.disabled = true;
    analyzer.pipeMicAudio();
    keepAlive.enable();
    
    setTimeout(() => runBtn.disabled = false, 6000);
});