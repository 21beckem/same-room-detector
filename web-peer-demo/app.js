import { AudioCompare } from "../exports/compare/compare.js";

// The library prepares packets continuously so a button press can use the
// newest complete local window. Nothing is sent until Request Score is used.
const PACKET_INTERVAL_MS = 1000;
const PACKET_HISTORY_SECONDS = 30;
const MAX_PACKET_MATCH_DISTANCE_MS = 2500;
const SCORE_REQUEST_TIMEOUT_MS = 10000;

const createButton = document.querySelector("#create-session");
const joinButton = document.querySelector("#join-session");
const joinCodeInput = document.querySelector("#join-code");
const peerStatus = document.querySelector("#peer-status");
const captureStatus = document.querySelector("#capture-status");
const setupPanel = document.querySelector(".setup");
const livePanel = document.querySelector(".live-panel");
const diagnosticsPanel = document.querySelector(".diagnostics-panel");
const connectedView = document.querySelector("#connected-view");
const sharePanel = document.querySelector("#share-panel");
const peerCodeOutput = document.querySelector("#peer-code");
const inviteUrlOutput = document.querySelector("#invite-url");
const copyInviteButton = document.querySelector("#copy-invite");
const qrImage = document.querySelector("#qr-code");
const resultPanel = document.querySelector("#result");
const scoreOutput = document.querySelector("#score");
const qualityOutput = document.querySelector("#result-quality");
const detailsOutput = document.querySelector("#result-details");
const debugOutput = document.querySelector("#debug-output");
const localBufferLabel = document.querySelector("#local-buffer-label");
const remoteBufferLabel = document.querySelector("#remote-buffer-label");
const localConnectedScore = document.querySelector("#local-connected-score");
const remoteConnectedScore = document.querySelector("#remote-connected-score");
const localConnectedMeta = document.querySelector("#local-connected-meta");
const remoteConnectedMeta = document.querySelector("#remote-connected-meta");
const localPacketSummary = document.querySelector("#local-packet-summary");
const remotePacketSummary = document.querySelector("#remote-packet-summary");
const localPacketCanvas = document.querySelector("#local-packet-visualization");
const remotePacketCanvas = document.querySelector("#remote-packet-visualization");
const localScoreAge = document.querySelector("#local-score-age");
const remoteScoreAge = document.querySelector("#remote-score-age");
const remoteTransportStatus = document.querySelector("#remote-transport-status");
const scoreSummaryMax = document.querySelector("#score-summary-max");
const scoreSummaryAverage = document.querySelector("#score-summary-average");
const scoreSummaryMin = document.querySelector("#score-summary-min");
const requestScoreButton = document.querySelector("#request-score");

let analyzer;
let peer;
let dataConnection;
let comparisonInFlight = false;
let inviteUrl = "";
let sessionRole = "none";
let analyzerReady = false;
let modelConfig = null;
let analysisSeconds = 0;
let comparisonAttempts = 0;
let completedComparisons = 0;
let localPacketCount = 0;
let remotePacketCount = 0;
let lastPacketMatchDeltaMs = null;
let lastLocalPacket = null;
let lastComparisonAttemptAt = null;
let lastResultAt = null;
let lastResult = null;
let remoteResult = null;
let lastComparisonError = null;
let pendingScoreRequest = null;
let scoreRequestTimer = null;
let remoteRequestInFlight = false;
let clockSynchronized = false;
let remoteHealth = { state: "waiting", detail: "Waiting for a score request." };

function setPeerStatus(message, kind = "") {
  peerStatus.textContent = message;
  peerStatus.className = `status ${kind}`;
  updateDebug();
}

const keepAwake = new NoSleep();
const refreshConfirm = (() => {
  function handleBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = "";
  }
  return {
    enable: () => window.addEventListener("beforeunload", handleBeforeUnload),
    disable: () => window.removeEventListener("beforeunload", handleBeforeUnload),
  };
})();

function setCaptureStatus(message, kind = "") {
  captureStatus.textContent = message;
  captureStatus.className = `status ${kind}`;
  updateDebug();
}

function format(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "never";
}

function resultAge(timestamp) {
  return timestamp ? `updated ${format(Math.max(0, (Date.now() - timestamp) / 1000), 0)}s ago` : "Waiting for score";
}

function resultQuality(result) {
  if (!result) return "quality n/a";
  return result.quality?.ok ? "quality ok" : (result.quality?.notes || []).join("; ") || "quality warning";
}

function resultMeta(result) {
  if (!result) return "Waiting for score";
  return `${result.label} · ${resultQuality(result)}`;
}

function scoreClassForValue(value) {
  if (value === null || value === undefined) return "";
  return value >= 0.75 ? "good" : value >= 0.25 ? "warn" : "bad";
}

function renderConnectedScores() {
  const localScoreClass = lastResult?.label === "close" ? "good" : lastResult?.label === "middle" ? "warn" : "bad";
  localConnectedScore.className = `split-score ${lastResult ? localScoreClass : ""}`;
  localConnectedScore.textContent = lastResult ? `${format(lastResult.score * 100, 1)}%` : "Waiting for local score…";
  localConnectedMeta.textContent = lastResult ? resultMeta(lastResult) : "Your device’s score will appear here.";
  localScoreAge.textContent = resultAge(lastResultAt);

  const remoteScoreClass = remoteResult?.label === "close" ? "good" : remoteResult?.label === "middle" ? "warn" : "bad";
  remoteConnectedScore.className = `split-score ${remoteResult ? remoteScoreClass : ""}`;
  remoteConnectedScore.textContent = remoteResult ? `${format(remoteResult.score * 100, 1)}%` : "Waiting for remote score…";
  remoteConnectedMeta.textContent = remoteResult ? resultMeta(remoteResult) : "The other device’s score will appear here.";
  remoteScoreAge.textContent = remoteResult ? "received from remote device" : "Waiting for score";

  const scores = lastResult && remoteResult ? [lastResult.score, remoteResult.score] : null;
  const summary = scores
    ? [Math.max(...scores), (scores[0] + scores[1]) / 2, Math.min(...scores)]
    : [null, null, null];
  [scoreSummaryMax, scoreSummaryAverage, scoreSummaryMin].forEach((element, index) => {
    element.className = `summary-score ${scoreClassForValue(summary[index])}`;
    element.textContent = summary[index] === null ? "—" : `${format(summary[index] * 100, 1)}%`;
  });
}

function setRemoteHealth(state, detail) {
  const changed = remoteHealth.state !== state || remoteHealth.detail !== detail;
  remoteHealth = { state, detail };
  remoteTransportStatus.className = `transport-status ${state === "ready" ? "good" : state === "waiting" ? "" : "error"}`;
  remoteTransportStatus.textContent = detail;
  if (changed && state !== "ready") {
    lastResult = null;
    lastResultAt = null;
    resultPanel.hidden = true;
    renderConnectedScores();
  }
  updateDebug();
}

function setConnectedView(connected) {
  document.body.classList.toggle("connected", connected);
  setupPanel.hidden = connected;
  connectedView.hidden = !connected;
  livePanel.hidden = connected;
  diagnosticsPanel.hidden = connected;
  if (!connected) remoteResult = null;
  if (connected) {
    keepAwake.enable();
    refreshConfirm.enable();
  } else {
    keepAwake.disable();
    refreshConfirm.disable();
  }
  updateRequestButton();
  renderConnectedScores();
}

function updateRequestButton() {
  if (!requestScoreButton) return;
  const waiting = pendingScoreRequest || comparisonInFlight;
  requestScoreButton.disabled = !dataConnection?.open || !clockSynchronized || Boolean(waiting);
  requestScoreButton.textContent = waiting ? "Waiting for Score…" : "Request Score";
}

function updateDebug() {
  const targetText = analysisSeconds ? `${analysisSeconds.toFixed(1)} s` : "loading model";
  localBufferLabel.textContent = `${localPacketCount} packets · ${targetText} each`;
  remoteBufferLabel.textContent = `${remotePacketCount} packets received on request`;

  const lastResultText = lastResult
    ? `${format(lastResult.score * 100, 1)}% ${lastResult.label} at ${formatTime(lastResultAt)}`
    : "none";
  const resultDetails = lastResult
    ? [
      `window scores=[${(lastResult.windowScores || []).map((value) => format(value, 3)).join(", ")}]`,
      `features mel=${format(lastResult.features?.mel_peak, 4)} flux=${format(lastResult.features?.flux_peak, 4)}`,
      `lags mel=${format(lastResult.lags?.mel, 3)}s flux=${format(lastResult.lags?.flux, 3)}s`,
      `quality=${resultQuality(lastResult)}`,
    ].join("\n  ")
    : "none";

  debugOutput.textContent = [
    `status: peer=${peerStatus.textContent} | capture=${captureStatus.textContent}`,
    `analyzer: ${analyzerReady ? "ready" : "not ready"} | role=${sessionRole} | busy=${comparisonInFlight}`,
    `peer: id=${peer?.id || "none"} | data=${dataConnection?.open ? "open" : "closed"}`,
    `model: ${modelConfig ? `window=${modelConfig.window_sec}s min=${modelConfig.min_sec}s hop=${modelConfig.hop_sec}s maxLag=${modelConfig.max_lag}s` : "loading"}`,
    `packets: local=${localPacketCount} remote=${remotePacketCount} exchanged on request`,
    `packet match: ${lastPacketMatchDeltaMs === null ? "none" : `${format(lastPacketMatchDeltaMs, 0)} ms local-minus-remote`} (limit ${MAX_PACKET_MATCH_DISTANCE_MS} ms)`,
    `clock: ${clockSynchronized ? "synchronized" : "not synchronized"} | request=${pendingScoreRequest?.id || "none"}`,
    `remote status: ${remoteHealth.state} | ${remoteHealth.detail}`,
    `comparisons: attempts=${comparisonAttempts} completed=${completedComparisons} interval=${PACKET_INTERVAL_MS}ms last attempt=${formatTime(lastComparisonAttemptAt)}`,
    `last result: ${lastResultText}`,
    `last error: ${lastComparisonError || "none"}`,
    `result details:\n  ${resultDetails}`,
  ].join("\n");
}

function showInvite(peerId) {
  const url = new URL(window.location.href);
  url.searchParams.set("peer-code", peerId);
  inviteUrl = url.href;
  peerCodeOutput.textContent = peerId;
  inviteUrlOutput.textContent = inviteUrl;
  sharePanel.hidden = false;
  qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(inviteUrl)}`;
}

async function copyInvite() {
  if (!inviteUrl) return;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    copyInviteButton.textContent = "Copied";
    window.setTimeout(() => { copyInviteButton.textContent = "Copy invite link"; }, 1500);
  } catch {
    setPeerStatus("Copy failed; select the invite link manually.", "warn");
  }
}

function handleLocalPacket(packet) {
  lastLocalPacket = packet;
  localPacketCount += 1;
  analyzer.drawPacket(localPacketCanvas, localPacketSummary, packet);
  setCaptureStatus(
    dataConnection?.open
      ? "Microphone ready. Press Request Score when you want to compare."
      : "Microphone ready. Waiting for the peer connection…",
    "good",
  );
  updateDebug();
}

async function startLocalCapture() {
  await analyzer.pipeMicAudio({
    historySeconds: PACKET_HISTORY_SECONDS,
    packetIntervalMs: PACKET_INTERVAL_MS,
    prepareOnPacket: true,
    onPacket: handleLocalPacket,
    onError: (error) => {
      lastComparisonError = error.message;
      setCaptureStatus(`Microphone preparation failed: ${error.message}`, "error");
    },
  });
  setCaptureStatus("Microphone ready. Waiting for the peer connection…", "good");
  updateDebug();
}

function packetForTransport(packet) {
  return { timestamp: packet.timestamp, buffer: packet.buffer.slice(0) };
}

function clearScoreRequest() {
  if (scoreRequestTimer) window.clearTimeout(scoreRequestTimer);
  scoreRequestTimer = null;
  pendingScoreRequest = null;
  updateRequestButton();
}

function validatePacketMatch(localPacket, remotePacket) {
  if (!localPacket) throw new Error("No prepared local microphone packet is available yet.");
  if (!Number.isFinite(remotePacket?.timestamp)) throw new Error("The other device returned an invalid packet timestamp.");
  lastPacketMatchDeltaMs = localPacket.timestamp - remotePacket.timestamp;
  if (Math.abs(lastPacketMatchDeltaMs) > MAX_PACKET_MATCH_DISTANCE_MS) {
    throw new Error(`Packet timestamps differ by ${format(lastPacketMatchDeltaMs, 0)} ms.`);
  }
}

async function requestScore() {
  if (!dataConnection?.open || !clockSynchronized || pendingScoreRequest || comparisonInFlight) return;
  comparisonInFlight = true;
  updateRequestButton();
  try {
    const packet = await analyzer.prepareMicPacket();
    console.log('packet', packet);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingScoreRequest = { id: requestId, packet };
    lastLocalPacket = packet;
    analyzer.drawPacket(localPacketCanvas, localPacketSummary, packet);
    comparisonInFlight = false;
    updateRequestButton();
    setCaptureStatus("Request sent. Waiting for the other device to score this packet…", "good");
    dataConnection.send({ type: "score-request", requestId, packet: packetForTransport(packet) });
    scoreRequestTimer = window.setTimeout(() => {
      if (pendingScoreRequest?.id !== requestId) return;
      clearScoreRequest();
      lastComparisonError = "The other device did not answer the score request.";
      setCaptureStatus(lastComparisonError, "error");
      updateDebug();
    }, SCORE_REQUEST_TIMEOUT_MS);
  } catch (error) {
    comparisonInFlight = false;
    clearScoreRequest();
    lastComparisonError = `Could not send score request: ${error.message}`;
    setCaptureStatus(lastComparisonError, "error");
  }
}

setInterval(() => requestScore(), 1000);

function renderResult(result) {
  lastResult = result;
  lastResultAt = Date.now();
  lastComparisonError = null;
  completedComparisons += 1;
  resultPanel.hidden = false;
  scoreOutput.textContent = `${format(result.score * 100, 1)}% — ${result.label}`;
  const scoreClass = result.label === "close" ? "good" : result.label === "middle" ? "warn" : "";
  scoreOutput.className = `score ${scoreClass}`;
  qualityOutput.textContent = `Quality: ${resultQuality(result)} · audio ${format(result.seconds, 1)} s · levels ${format(result.quality.level_dbfs, 0)} dBFS`;
  detailsOutput.textContent = `Features mel ${format(result.features.mel_peak)} · flux ${format(result.features.flux_peak)} · lags ${format(result.lags.mel)} / ${format(result.lags.flux)} s · WASM ${format(result.pairMs, 0)} ms`;
  renderConnectedScores();
  updateDebug();
}

async function handleScoreRequest(message) {
  if (remoteRequestInFlight) {
    dataConnection?.send({ type: "score-response", requestId: message.requestId, error: "This device is already scoring another request." });
    return;
  }
  remoteRequestInFlight = true;
  comparisonInFlight = true;
  comparisonAttempts += 1;
  lastComparisonAttemptAt = Date.now();
  try {
    const requestPacket = message.packet;
    const localPacket = await analyzer.prepareMicPacket();
    validatePacketMatch(localPacket, requestPacket);
    remotePacketCount += 1;
    analyzer.drawPacket(remotePacketCanvas, remotePacketSummary, requestPacket);
    const result = await analyzer.compare(localPacket, requestPacket);
    renderResult(result);
    setRemoteHealth("ready", "Last score request completed.");
    dataConnection?.send({
      type: "score-response",
      requestId: message.requestId,
      packet: packetForTransport(localPacket),
      result,
    });
  } catch (error) {
    lastComparisonError = error.message;
    setCaptureStatus(`Score request failed: ${error.message}`, "error");
    dataConnection?.send({ type: "score-response", requestId: message.requestId, error: error.message });
  } finally {
    comparisonInFlight = false;
    remoteRequestInFlight = false;
    updateRequestButton();
    updateDebug();
  }
}

async function handleScoreResponse(message) {
  if (!pendingScoreRequest || message.requestId !== pendingScoreRequest.id) return;
  const request = pendingScoreRequest;
  clearScoreRequest();
  if (message.error) {
    lastComparisonError = message.error;
    setCaptureStatus(`Score request failed: ${message.error}`, "error");
    return;
  }
  comparisonInFlight = true;
  comparisonAttempts += 1;
  lastComparisonAttemptAt = Date.now();
  try {
    validatePacketMatch(request.packet, message.packet);
    remotePacketCount += 1;
    analyzer.drawPacket(remotePacketCanvas, remotePacketSummary, message.packet);
    const result = await analyzer.compare(request.packet, message.packet);
    remoteResult = message.result || result;
    renderResult(result);
    renderConnectedScores();
    setRemoteHealth("ready", "Last score request completed.");
    dataConnection?.send({ type: "score-result", requestId: message.requestId, result });
    setCaptureStatus("Score received. Press Request Score to compare again.", "good");
  } catch (error) {
    lastComparisonError = error.message;
    setCaptureStatus(`Score response failed: ${error.message}`, "error");
  } finally {
    comparisonInFlight = false;
    updateRequestButton();
    updateDebug();
  }
}

function handlePeerError(error) {
  setPeerStatus(`Peer connection error: ${error.message || error.type || error}`, "error");
  setRemoteHealth("unavailable", `PeerJS reported a connection error: ${error.message || error.type || error}. Score requests cannot be completed.`);
  createButton.disabled = false;
  joinButton.disabled = false;
}

function attachDataConnection(connection) {
  if (dataConnection && dataConnection !== connection) dataConnection.close();
  dataConnection = connection;
  clockSynchronized = sessionRole === "host";
  updateRequestButton();
  connection.on("open", () => {
    setConnectedView(true);
    setPeerStatus("Peer connected. Press Request Score when ready.", "good");
    setRemoteHealth("waiting", clockSynchronized ? "Connected; press Request Score." : "Connected; synchronizing clocks…");
    if (sessionRole === "host") {
      connection.send({ type: "clock-sync", timestamp: analyzer.currentTimestampMs });
    }
    updateRequestButton();
  });
  connection.on("data", (message) => {
    if (!message) return;
    if (message.type === "clock-sync" && Number.isFinite(message.timestamp)) {
      analyzer.currentTimestampMs = message.timestamp;
      clockSynchronized = true;
      setRemoteHealth("waiting", "Connected; press Request Score.");
      updateRequestButton();
      updateDebug();
      return;
    }
    if (message.type === "score-request" && message.packet) {
      void handleScoreRequest(message);
      return;
    }
    if (message.type === "score-response") {
      void handleScoreResponse(message);
      return;
    }
    if (message.type === "score-result" && message.result) {
      remoteResult = message.result;
      renderConnectedScores();
    }
  });
  connection.on("close", () => {
    if (dataConnection !== connection) return;
    dataConnection = null;
    clearScoreRequest();
    comparisonInFlight = false;
    remoteRequestInFlight = false;
    remoteResult = null;
    lastPacketMatchDeltaMs = null;
    clockSynchronized = false;
    setRemoteHealth("waiting", "Waiting for the peer data connection.");
    setConnectedView(false);
    setCaptureStatus("The other peer disconnected. Microphone packets remain local until another peer connects.", "warn");
  });
  connection.on("error", (error) => {
    lastComparisonError = `Packet sharing failed: ${error.message || error}`;
    updateDebug();
  });
}

async function createSession() {
  createButton.disabled = true;
  joinButton.disabled = true;
  try {
    sessionRole = "host";
    await startLocalCapture();
    peer = new window.Peer();
    peer.on("open", (id) => {
      showInvite(id);
      setPeerStatus("Session ready. Share the QR code or invite link, then wait for the other peer.", "good");
    });
    peer.on("connection", attachDataConnection);
    peer.on("error", handlePeerError);
    peer.on("disconnected", () => setPeerStatus("Peer signaling disconnected.", "warn"));
  } catch (error) {
    setPeerStatus(`Could not create session: ${error.message}`, "error");
    createButton.disabled = false;
    joinButton.disabled = false;
  }
}

async function joinSession() {
  const targetId = joinCodeInput.value.trim();
  if (!targetId) {
    setPeerStatus("Enter a peer code or scan an invite QR code first.", "warn");
    return;
  }
  createButton.disabled = true;
  joinButton.disabled = true;
  try {
    sessionRole = "joiner";
    await startLocalCapture();
    peer = new window.Peer();
    peer.on("open", (id) => {
      showInvite(id);
      // Requests and their responses are explicit, so ordered reliable
      // delivery is appropriate and cannot build a continuous audio backlog.
      attachDataConnection(peer.connect(targetId, { reliable: true, serialization: "binary" }));
      setPeerStatus(`Connecting to ${targetId}…`, "good");
    });
    peer.on("error", handlePeerError);
    peer.on("disconnected", () => setPeerStatus("Peer signaling disconnected.", "warn"));
  } catch (error) {
    setPeerStatus(`Could not join session: ${error.message}`, "error");
    createButton.disabled = false;
    joinButton.disabled = false;
  }
}

async function initialize() {
  const peerCode = new URLSearchParams(window.location.search).get("peer-code");
  if (peerCode) joinCodeInput.value = peerCode;
  analyzer = await AudioCompare.fromObject({
    modelUrl: "../model_output/model.json",
    wasmUrl: "../web-calibration/wasm_parity/wasm/same_room.wasm",
  });
  modelConfig = analyzer.config;
  analysisSeconds = Math.max(modelConfig.window_sec, modelConfig.min_sec);
  analyzerReady = true;
  analyzer.drawPacket(localPacketCanvas, localPacketSummary, null);
  analyzer.drawPacket(remotePacketCanvas, remotePacketSummary, null);
  setPeerStatus(peerCode ? "Invite loaded. Start the microphone to join." : "Ready. Create a session or enter a peer code.");
}

createButton.addEventListener("click", createSession);
joinButton.addEventListener("click", joinSession);
copyInviteButton.addEventListener("click", copyInvite);
requestScoreButton.addEventListener("click", requestScore);
initialize().catch((error) => setPeerStatus(`Could not load analyzer: ${error.message}`, "error"));
updateDebug();
// The canvases are initialized after the analyzer loads below.

window.addEventListener("beforeunload", () => {
  clearScoreRequest();
  if (dataConnection) dataConnection.close();
  if (peer) peer.destroy();
  if (analyzer) analyzer.dispose();
});
