const $ = (id) => document.getElementById(id);
const form = $('start-form');
const startButton = $('start-btn');
const broadcastButton = $('broadcast-btn');
const peers = new Map();
const handshakes = new Map();
const IDENTITY = 'field:identity:v1';
let mesh;
let initialized = false;
let active = false;
let starting = false;
let broadcastBusy = false;
let deviceName = localStorage.getItem('deviceName') || '';
// iPads may advertise a desktop user agent. Tablets share the phone icon.
const deviceType = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ? 'phone' : 'computer';

function log(message, error = false) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    const text = document.createElement('span');
    time.dateTime = new Date().toISOString();
    time.textContent = new Date().toLocaleTimeString([], { hour12: false });
    text.textContent = message;
    item.classList.toggle('error', error);
    item.append(time, text);
    $('event-log').prepend(item);
    while ($('event-log').children.length > 40) $('event-log').lastElementChild.remove();
}

function setupStatus(message, error = false) {
    $('setup-status').textContent = message;
    $('setup-status').classList.toggle('error', error);
}

function connection(online, label) {
    $('connection-status').textContent = label;
    $('connection-led').className = `led ${online ? 'online' : 'offline'}`;
    document.body.classList.toggle('offline', !online);
}

function icon(type) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon device-icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', `#icon-${type || 'unknown'}`);
    svg.append(use);
    return svg;
}

function renderPeers() {
    const ids = mesh?.peers || [];
    const list = $('device-list');
    const blips = $('radar-blips');
    list.replaceChildren();
    blips.replaceChildren();
    $('empty-state').hidden = ids.length > 0;
    $('device-count').textContent = String(ids.length).padStart(2, '0');
    $('contact-count').textContent = `${String(ids.length).padStart(2, '0')} CONTACT${ids.length === 1 ? '' : 'S'}`;
    $('list-status').textContent = ids.length ? 'PAIRED' : active ? 'SEARCHING' : 'OFFLINE';
    $('radar-status').textContent = ids.length ? 'SHARED SIGNAL DETECTED' : active ? 'LISTENING FOR NEARBY DEVICES' : 'SEARCH INTERRUPTED';
    broadcastButton.disabled = !active || !mesh?.connected || !ids.length || broadcastBusy;

    ids.forEach((uid, index) => {
        const peer = peers.get(uid);
        const row = document.createElement('li');
        row.className = 'device-row';
        const number = document.createElement('span');
        number.className = 'device-number';
        number.textContent = String(index + 1).padStart(2, '0');
        const detail = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = peer?.name || 'Identifying device…';
        const meta = document.createElement('span');
        meta.className = 'device-meta';
        meta.textContent = peer ? `${peer.type.toUpperCase()} / ${uid}` : `AWAITING IDENTITY / ${uid}`;
        detail.append(name, meta);
        const badge = document.createElement('span');
        badge.className = 'paired-label';
        badge.textContent = peer ? '● LINKED' : '◌ PAIRING';
        row.append(number, icon(peer?.type), detail, badge);
        list.append(row);

        // Decorative positions are independent of room dimensions.
        const angle = (uid * 137.508 % 360) * Math.PI / 180;
        const radius = 22 + (uid % 17);
        const blip = document.createElement('div');
        blip.className = 'blip';
        blip.dataset.uid = String(uid);
        blip.style.left = `${50 + Math.cos(angle) * radius}%`;
        blip.style.top = `${50 + Math.sin(angle) * radius}%`;
        const dot = document.createElement('span');
        dot.className = 'blip-dot';
        const label = document.createElement('span');
        label.className = 'blip-label';
        label.textContent = String(index + 1).padStart(2, '0');
        blip.append(dot, label);
        blips.append(blip);
    });
}

function stopHandshake(uid) {
    clearTimeout(handshakes.get(uid)?.timer);
    handshakes.delete(uid);
}

async function sendIdentity(uid, requestIdentity) {
    await mesh.relayMessage(uid, { type: IDENTITY, name: deviceName, deviceType, requestIdentity });
}

function identify(uid) {
    if (!active || !mesh.peers.includes(uid) || peers.has(uid) || handshakes.has(uid)) return;
    const state = { attempts: 0, timer: null };
    handshakes.set(uid, state);
    const attempt = async () => {
        if (handshakes.get(uid) !== state || !active || !mesh.peers.includes(uid)) return;
        state.attempts++;
        try { await sendIdentity(uid, true); }
        catch (error) {
            if (state.attempts === 3) log(`Identity exchange pending for device ${uid}. ${error.message}`, true);
        }
        if (handshakes.get(uid) !== state) return;
        if (state.attempts < 3) state.timer = setTimeout(attempt, 2500);
        else stopHandshake(uid);
    };
    void attempt();
}

function receiveIdentity({ from, msg }) {
    if (!msg || msg.type !== IDENTITY || !Number.isInteger(from)) return;
    if (typeof msg.name !== 'string' || !msg.name.trim() || !['phone', 'computer'].includes(msg.deviceType)) return;
    // A peer may introduce itself just before our own pairing notification.
    // Cache a bounded number of identities; render only currently paired peers.
    if (!peers.has(from) && peers.size >= 100) return;
    const isNew = !peers.has(from);
    peers.set(from, { name: msg.name.trim().slice(0, 40), type: msg.deviceType });
    stopHandshake(from);
    if (active && msg.requestIdentity === true) {
        // Do not await a return relay in the receive handler: the sender is
        // waiting for this message's acknowledgment.
        void sendIdentity(from, false).catch((error) => log(`Could not return device identity: ${error.message}`, true));
    }
    if (isNew && active) log(`Identity received: ${peers.get(from).name} / ${msg.deviceType}.`);
    renderPeers();
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!initialized || starting || active) return;
    deviceName = $('device-name').value.trim();
    if (!deviceName) { setupStatus('Enter a device name to begin.', true); $('device-name').focus(); return; }
    localStorage.setItem('deviceName', deviceName);
    starting = true;
    startButton.disabled = true;
    $('device-name').disabled = true;
    $('start-label').textContent = 'ACQUIRING SIGNAL…';
    setupStatus('Allow microphone and location access. Listening to establish your signal…');
    try {
        const result = await mesh.begin();
        if (!result.success || !mesh.connected) throw new Error('The search could not start. Reload and try again.');
        active = true;
        $('local-name').textContent = deviceName;
        $('local-type').textContent = `${deviceType.toUpperCase()} / ${mesh.uid}`;
        $('local-icon').replaceChildren(icon(deviceType).firstElementChild);
        $('setup').hidden = true;
        $('dashboard').hidden = false;
        log(`Search started as ${deviceName}. Listening for a shared signal.`);
        renderPeers();
        mesh.peers.forEach(identify);
    } catch (error) {
        setupStatus(error.message || 'Unable to start. Check microphone and location permissions, then try again.', true);
        log(`Search failed: ${error.message}`, true);
    } finally {
        starting = false;
        startButton.disabled = active || !mesh.connected;
        $('device-name').disabled = active;
        $('start-label').textContent = 'START SEARCH';
    }
});

broadcastButton.addEventListener('click', async () => {
    if (!active || broadcastBusy) return;
    broadcastBusy = true;
    renderPeers();
    try {
        await mesh.broadcast({ type: 'field:ping:v1', name: deviceName });
        log('Ping sent to all paired devices.');
        $('status').textContent = 'Ping sent to all connected devices.';
    } catch (error) { log(`Ping failed: ${error.message}`, true); $('status').textContent = 'Ping could not be sent. Try again.'; }
    finally { broadcastBusy = false; renderPeers(); }
});

// A dynamic import lets the entry form render and report module failures.
async function initialize() {
    $('device-name').value = deviceName;
    try {
        ({ MeshClient: mesh } = await import('./mesh-client.js'));
        mesh.on('connected', () => { connection(true, 'SERVER ONLINE'); log('Discovery server connected.'); });
        mesh.on('initialized', () => {
            initialized = true;
            startButton.disabled = !mesh.connected;
            $('start-label').textContent = 'START SEARCH';
            setupStatus('System ready. Give your device a callsign.');
        });
        mesh.on('initError', ({ error }) => { setupStatus(`Initialization failed: ${error.message}. Reload to retry.`, true); });
        mesh.on('disconnected', () => {
            active = false;
            connection(false, 'SERVER OFFLINE');
            startButton.disabled = true;
            for (const uid of handshakes.keys()) stopHandshake(uid);
            peers.clear();
            $('scan-label').textContent = 'OFFLINE';
            $('status').textContent = 'Connection lost. Reload this page to reconnect.';
            setupStatus('Connection lost. Reload this page to reconnect.', true);
            log('Server disconnected. Reload the page to reconnect.', true);
            renderPeers();
            $('empty-state').querySelector('h3').textContent = 'Connection interrupted';
            $('empty-state').querySelector('p').textContent = 'Reload this page to reconnect and search again.';
        });
        mesh.on('serverError', ({ error }) => { log(`Connection error: ${error.message || 'Server unavailable'}`, true); });
        mesh.on('relayMessage', receiveIdentity);
        mesh.on('peerAdded', ({ uid }) => { log(`New signal paired / ${uid}. Exchanging device identity.`); renderPeers(); identify(uid); });
        mesh.on('peerRemoved', ({ uid }) => { log(`${peers.get(uid)?.name || `Device ${uid}`} left the mesh.`); stopHandshake(uid); peers.delete(uid); renderPeers(); });
        mesh.on('peersUpdated', renderPeers);
        mesh.on('broadcast', ({ message }) => {
            if (!active || message?.type !== 'field:ping:v1' || typeof message.name !== 'string') return;
            log(`Incoming ping from ${message.name.slice(0, 40)}.`);
            $('status').textContent = `Ping received from ${message.name.slice(0, 40)}.`;
            for (const blip of $('radar-blips').children) {
                blip.classList.remove('ping');
                void blip.offsetWidth;
                blip.classList.add('ping');
            }
        });
        mesh.on('audioRequest', () => { if (active) $('status').textContent = 'Comparing the room’s ambient signal…'; });
        mesh.on('audioError', () => { log('Audio signal unavailable. Check microphone access.', true); });
        await mesh.init();
    } catch (error) {
        connection(false, 'SYSTEM UNAVAILABLE');
        setupStatus(`Could not initialize: ${error.message}. Reload to retry.`, true);
        log(`Initialization failed: ${error.message}`, true);
    }
}

void initialize();
