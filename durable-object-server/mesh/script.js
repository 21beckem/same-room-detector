import { AudioCompare } from '../../exports/compare/compare.js';
import { ProtocolClient } from '../src/protocol/client.js';
const isHostedLocally = (/(localhost)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/gm).test(window.location.hostname);

const debug = {
    log: (...a) => {
        if (false) console.log(`[${debug._timestamp()}]`, ...a);
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
    }
};
const keepAlive = (() => {
    const keepAwake = new NoSleep();
    function handleBeforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
    return {
        enable:  () => { keepAwake.enable();  /* window.addEventListener   ('beforeunload', handleBeforeUnload); */ },
        disable: () => { keepAwake.disable(); /* window.removeEventListener('beforeunload', handleBeforeUnload); */ },
    };
})();
const WebSocketServerUri = isHostedLocally ? 'ws://localhost:8787' : 'wss://durable-object-server.21beckem8.workers.dev';

const runBtn = document.getElementById('run-btn');
runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    link.send('trigger');
    debug.status('Triggering colocation...');
});


const link = new ProtocolClient(WebSocketServerUri);
try {
    await link.ready;
    debug.status('Connected to server. Click "Start Recording" to begin.');
} catch (err) {
    console.error('Failed to connect to server:', err);
    alert('Failed to connect to server. See console for details.');
}
const analyzer = await AudioCompare.fromObject({});
link.handle('audioRequest', async (msg, ctx) => {
    debug.log('Received audio request from server:', msg);
    const packet = await analyzer.waitForLocalPacket();
    return { fields: { ts: packet.timestamp }, payload: packet.buffer };
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

const startRecordingBtn = document.getElementById('start-recording-btn');
startRecordingBtn.addEventListener('click', () => {
    startRecordingBtn.disabled = true;
    analyzer.pipeMicAudio();
    keepAlive.enable();
});