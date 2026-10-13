import { MeshedPeers } from '../meshed-peers/src/index.js';

const startButton = document.querySelector('#start-button');
const stopButton = document.querySelector('#stop-button');
const broadcastButton = document.querySelector('#broadcast-button');
const clearLogButton = document.querySelector('#clear-log');
const statusOutput = document.querySelector('#status');
const peerIdOutput = document.querySelector('#peer-id');
const nearbyList = document.querySelector('#nearby-peers');
const failedList = document.querySelector('#failed-peers');
const nearbyCount = document.querySelector('#nearby-count');
const failedCount = document.querySelector('#failed-count');
const messageLog = document.querySelector('#message-log');
const errorOutput = document.querySelector('#error');

const failedPeers = new Map();
let mesh = null;

const keepAwake = new NoSleep();
const refreshConfirm = (() => {
  function handleBeforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
  return {
    enable: () => window.addEventListener('beforeunload', handleBeforeUnload),
    disable: () => window.removeEventListener('beforeunload', handleBeforeUnload),
  };
})();

const isLocalRegex = /(localhost)|(\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)/gm
const isHostedLocally = isLocalRegex.test(window.location.hostname);
const PEER_SERVER_CONFIG = isHostedLocally ? {
  host: window.location.hostname,
  port: 9000,
  path: '/peerjs',
  secure: false
} : {
  host: 'mesh-peer-server.onrender.com',
  path: '/peerjs',
  secure: true
};

const meshConfig = {
  peerServer: { ...PEER_SERVER_CONFIG },
  modelUrl: '../model_output/model.json',
  wasmUrl: '../web-calibration/wasm_parity/wasm/same_room.wasm',
  timing: {
    reassessSeconds: 15,
    retrySeconds: 5,
    comparisonWindowSeconds: 12,
    alignmentSeconds: 5,
  },
};

function formatTime(timestamp) {
  if (!timestamp) return 'never';
  return new Date(timestamp).toLocaleTimeString();
}

function setStatus(message) {
  statusOutput.textContent = message;
  console.log(`[${formatTime(Date.now())}] Status: ${message}`);
}

function showError(error) {
  errorOutput.hidden = false;
  errorOutput.textContent = error?.message || String(error);
}

function clearError() {
  errorOutput.hidden = true;
  errorOutput.textContent = '';
}

function peerItem(peer, failed = false) {
  const item = document.createElement('li');
  item.className = failed ? 'peer-item failed' : 'peer-item';
  const heading = document.createElement('strong');
  heading.textContent = peer.peerId;
  const details = document.createElement('span');
  const score = peer.score === undefined ? 'n/a' : Number(peer.score).toFixed(3);
  const reason = peer.reason ? ` · ${peer.reason}` : '';
  details.textContent = `score ${score} · checked ${formatTime(peer.lastCheckedAt || peer.checkedAt)}${reason}`;
  item.append(heading, details);
  return item;
}

function renderNearby() {
  const peers = mesh?.nearbyPeers || [];
  nearbyCount.textContent = String(peers.length);
  nearbyList.replaceChildren();
  if (!peers.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No nearby peers yet.';
    nearbyList.append(empty);
    return;
  }
  for (const peer of peers) nearbyList.append(peerItem(peer));
}

function renderFailed() {
  failedCount.textContent = String(failedPeers.size);
  failedList.replaceChildren();
  if (!failedPeers.size) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No failed comparisons yet.';
    failedList.append(empty);
    return;
  }
  for (const peer of [...failedPeers.values()].reverse()) failedList.append(peerItem(peer, true));
}

function logMessage(senderId, message) {
  const item = document.createElement('li');
  item.textContent = `${formatTime(Date.now())} · ${senderId}: ${String(message)}`;
  if (messageLog.querySelector('.empty')) messageLog.replaceChildren();
  messageLog.append(item);
}

function randomMessage() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const values = new Uint32Array(3);
  crypto.getRandomValues(values);
  return [...values].map((value) => alphabet[value % alphabet.length]).join('');
}

function attachMeshEvents() {
  mesh.on('status-change', (_status, details) => setStatus(details.message || details.status));
  mesh.on('ready', (peerId) => {
    peerIdOutput.textContent = `Peer ID: ${peerId}`;
    setStatus('connected to mesh-peer-server');
    keepAwake.enable();
    refreshConfirm.enable();
  });
  mesh.on('new-nearby-peer', (_peerId, details) => {
    failedPeers.delete(details.peerId);
    renderNearby();
    renderFailed();
  });
  mesh.on('nearby-peer-updated', () => renderNearby());
  mesh.on('peer-failed', (peerId, details = {}) => {
    failedPeers.set(peerId, { peerId, ...details });
    renderNearby();
    renderFailed();
  });
  mesh.on('broadcast', logMessage);
  mesh.on('peer-message', (peerId, message) => logMessage(peerId, message));
  mesh.on('error', (_peerId, error) => showError(error));
}

async function start() {
  startButton.disabled = true;
  clearError();
  try {
    mesh = MeshedPeers.fromObject(meshConfig);
    attachMeshEvents();
    await mesh.begin();
    stopButton.disabled = false;
    broadcastButton.disabled = false;
  } catch (error) {
    showError(error);
    startButton.disabled = false;
  }
}

async function stop() {
  stopButton.disabled = true;
  broadcastButton.disabled = true;
  await mesh?.stop();
  mesh = null;
  peerIdOutput.textContent = 'Peer ID: not connected';
  startButton.disabled = false;
  renderNearby();

  keepAwake.disable();
  refreshConfirm.disable();
}

startButton.addEventListener('click', () => start());
stopButton.addEventListener('click', () => stop());
broadcastButton.addEventListener('click', () => {
  if (!mesh) return;
  const message = randomMessage();
  try {
    const count = mesh.broadcastMessage(message);
    logMessage('local broadcast', `${message} (${count} nearby peer${count === 1 ? '' : 's'})`);
  } catch (error) {
    showError(error);
  }
});
clearLogButton.addEventListener('click', () => {
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = 'No messages received.';
  messageLog.replaceChildren(empty);
});

renderNearby();
renderFailed();
