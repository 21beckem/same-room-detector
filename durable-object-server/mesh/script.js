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
await link.ready;
link.handle('audioRequest', async (msg, ctx) => {
    console.log('Received audio request from server:', msg);
    await new Promise(r=>setTimeout(r,100));
    const packet = analyzer.getLocalPacket();
    return { fields: { ts: packet.timestamp }, payload: packet.buffer };
});
link.on('colocation', (msg, ctx) => {
    const { score, peer } = msg.fields;
    console.log(`Received colocation score from server: ${score} with peer ${peer}`);
    runBtn.disabled = false;
});

function debug(...a) { if (true) console.log(...a); }

document.getElementById('start-recording-btn').addEventListener('click', () => {
    document.getElementById('start-recording-btn').disabled = true;
    main();
});

let analyzer;
async function main() {
    analyzer = await AudioCompare.fromObject({});
    await analyzer.pipeMicAudio();
    window.analyzer = analyzer;
}