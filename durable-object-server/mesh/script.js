import { MeshClient } from './mesh-client.js';

await MeshClient.init();

const statusDiv = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
        const result = await MeshClient.begin();
        console.log('MeshClient started successfully:', result);
    } catch (error) {
        console.error('Failed to start MeshClient:', error);
        startBtn.disabled = false;
    }
});

MeshClient.on('ready', () => {
    statusDiv.textContent = 'MeshClient is ready'; 
});
MeshClient.on('peersUpdated', () => {
    console.log('Peers updated:', MeshClient.peers);
    statusDiv.textContent = 'Peers updated: ' + MeshClient.peers.join(', ');
});
MeshClient.on('audioRequest', (fields) => {
    statusDiv.textContent = 'Audio request received: ' + JSON.stringify(fields);
});