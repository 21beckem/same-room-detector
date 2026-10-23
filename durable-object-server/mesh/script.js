import { AudioCompare } from '../../exports/compare/compare.js';
import { ProtocolClient } from '../src/protocol/client.js';
const isHostedLocally = (/(localhost)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/gm).test(window.location.hostname);

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
});


const link = new ProtocolClient(WebSocketServerUri);
try {
    await link.ready;
} catch (err) {
    console.error('Failed to connect to server:', err);
    alert('Failed to connect to server. See console for details.');
}
const analyzer = await AudioCompare.fromObject({});
link.handle('audioRequest', async (msg, ctx) => {
    console.log('Received audio request from server:', msg);
    const packet = await analyzer.waitForLocalPacket();
    return { fields: { ts: packet.timestamp }, payload: packet.buffer };
});
link.on('colocation', (msg, ctx) => {
    const { score, peer } = msg.fields;
    console.log(`Received colocation score from server: ${score} with peer ${peer}`);
    runBtn.disabled = false;
});
link.on('tsUpdate', (msg, ctx) => {
    const { ts } = msg.fields;
    analyzer.currentTimestampMs = ts;
});

function debug(...a) { if (true) console.log(...a); }

const startRecordingBtn = document.getElementById('start-recording-btn');
startRecordingBtn.addEventListener('click', () => {
    startRecordingBtn.disabled = true;
    analyzer.pipeMicAudio();
    keepAlive.enable();
});