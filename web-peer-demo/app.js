import { prepareSamples } from "./audio.js";
import { RawStreamCapture, RollingAudioBuffer } from "./live-audio.js";
import { SameRoomAnalyzer } from "./same-room-analyzer.js";

// Change this value to control how often a fresh live comparison is requested.
const COMPARISON_INTERVAL_MS = 1000;
// Keep the live scoring input at one trained model window to bound WASM memory.
const ANALYSIS_WINDOW_SECONDS = 12;
const MIN_COMPARISON_SECONDS = ANALYSIS_WINDOW_SECONDS;
// Retain a small margin because capture arrives in whole worklet chunks.
const MAX_BUFFER_SECONDS = ANALYSIS_WINDOW_SECONDS + 1;
const RAW_AUDIO_CONSTRAINTS = {
  channelCount: 1,
  sampleRate: { ideal: 48000 },
  sampleSize: { ideal: 16 },
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const createButton = document.querySelector("#create-session");
const joinButton = document.querySelector("#join-session");
const joinCodeInput = document.querySelector("#join-code");
const peerStatus = document.querySelector("#peer-status");
const captureStatus = document.querySelector("#capture-status");
const sharePanel = document.querySelector("#share-panel");
const peerCodeOutput = document.querySelector("#peer-code");
const inviteUrlOutput = document.querySelector("#invite-url");
const copyInviteButton = document.querySelector("#copy-invite");
const qrImage = document.querySelector("#qr-code");
const resultPanel = document.querySelector("#result");
const scoreOutput = document.querySelector("#score");
const qualityOutput = document.querySelector("#result-quality");
const detailsOutput = document.querySelector("#result-details");

let analyzer;
let peer;
let activeCall;
let localStream;
let audioContext;
let localCapture;
let remoteCapture;
let comparisonTimer;
let comparisonInFlight = false;
let inviteUrl = "";

const localBuffer = new RollingAudioBuffer(MAX_BUFFER_SECONDS);
const remoteBuffer = new RollingAudioBuffer(MAX_BUFFER_SECONDS);

function setPeerStatus(message, kind = "") {
  peerStatus.textContent = message;
  peerStatus.className = `status ${kind}`;
}

function setCaptureStatus(message, kind = "") {
  captureStatus.textContent = message;
  captureStatus.className = `status ${kind}`;
}

function format(value, digits = 2) {
  return Number(value).toFixed(digits);
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

async function ensureLocalStream() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture requires HTTPS or localhost");
  localStream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: false });
  const track = localStream.getAudioTracks()[0];
  const settings = track?.getSettings?.() || {};
  const processing = [
    ["echo", settings.echoCancellation],
    ["noise", settings.noiseSuppression],
    ["gain", settings.autoGainControl],
  ].filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value ? "on" : "off"}`).join(", ");
  setCaptureStatus(`Microphone ready${processing ? ` (${processing})` : ""}. Waiting for the other peer.`);
  return localStream;
}

async function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function startLocalCapture() {
  await ensureLocalStream();
  const context = await ensureAudioContext();
  if (!localCapture) {
    localCapture = new RawStreamCapture(context, localStream, (samples, sampleRate) => {
      localBuffer.append(samples, sampleRate);
    });
  }
}

async function startRemoteCapture(stream) {
  const context = await ensureAudioContext();
  if (remoteCapture) remoteCapture.dispose();
  localBuffer.clear();
  remoteBuffer.clear();
  remoteCapture = new RawStreamCapture(context, stream, (samples, sampleRate) => {
    remoteBuffer.append(samples, sampleRate);
  });
  setCaptureStatus("Both microphones connected. Collecting live audio…", "good");
  startComparisons();
}

function startComparisons() {
  if (comparisonTimer) window.clearInterval(comparisonTimer);
  comparisonTimer = window.setInterval(runComparison, COMPARISON_INTERVAL_MS);
  runComparison();
}

function renderResult(result) {
  resultPanel.hidden = false;
  scoreOutput.textContent = `${format(result.score * 100, 1)}% — ${result.label}`;
  const scoreClass = result.label === "close" ? "good" : result.label === "middle" ? "warn" : "";
  scoreOutput.className = `score ${scoreClass}`;
  const notes = result.quality.ok ? "quality ok" : result.quality.notes.join("; ");
  qualityOutput.textContent = `Quality: ${notes || "quality warning"} · audio ${format(result.seconds, 1)} s · levels ${format(result.quality.level_dbfs, 0)} dBFS`;
  detailsOutput.textContent = `Features GCC ${format(result.features.gcc_peak)} · mel ${format(result.features.mel_peak)} · flux ${format(result.features.flux_peak)} · lags ${format(result.lags.gcc)} / ${format(result.lags.mel)} / ${format(result.lags.flux)} s · WASM ${format(result.wasm_ms, 0)} ms`;
}

async function runComparison() {
  if (comparisonInFlight || !localCapture || !remoteCapture) return;
  const localSeconds = localBuffer.seconds;
  const remoteSeconds = remoteBuffer.seconds;
  if (Math.min(localSeconds, remoteSeconds) < MIN_COMPARISON_SECONDS) {
    setCaptureStatus(`Collecting audio… local ${format(localSeconds, 1)} s, remote ${format(remoteSeconds, 1)} s`);
    return;
  }

  comparisonInFlight = true;
  try {
    const sampleRate = localBuffer.sampleRate;
    const localAudio = prepareSamples(localBuffer.snapshot(ANALYSIS_WINDOW_SECONDS), sampleRate);
    const remoteAudio = prepareSamples(remoteBuffer.snapshot(ANALYSIS_WINDOW_SECONDS), remoteBuffer.sampleRate);
    const result = await analyzer.compareBuffers(
      localAudio,
      remoteAudio,
      { label: "local microphone" },
      { label: "remote microphone" },
    );
    renderResult(result);
    setCaptureStatus(`Live comparison updated. Next comparison in ${format(COMPARISON_INTERVAL_MS / 1000, 1)} s.`, "good");
  } catch (error) {
    setCaptureStatus(`Comparison failed: ${error.message}`, "error");
  } finally {
    comparisonInFlight = false;
  }
}

function handlePeerError(error) {
  setPeerStatus(`Peer connection error: ${error.message || error.type || error}`, "error");
  createButton.disabled = false;
  joinButton.disabled = false;
}

function attachCall(call) {
  if (activeCall && activeCall !== call) activeCall.close();
  activeCall = call;
  call.on("stream", (stream) => startRemoteCapture(stream).catch((error) => setCaptureStatus(`Remote audio failed: ${error.message}`, "error")));
  call.on("close", () => {
    if (activeCall !== call) return;
    activeCall = null;
    if (remoteCapture) {
      remoteCapture.dispose();
      remoteCapture = null;
    }
    if (comparisonTimer) window.clearInterval(comparisonTimer);
    setCaptureStatus("The other peer disconnected.", "warn");
  });
  call.on("error", handlePeerError);
}

async function createSession() {
  createButton.disabled = true;
  joinButton.disabled = true;
  try {
    await startLocalCapture();
    peer = new window.Peer();
    peer.on("open", (id) => {
      showInvite(id);
      setPeerStatus("Session ready. Share the QR code or invite link, then wait for the other peer.", "good");
    });
    peer.on("call", (call) => {
      call.answer(localStream);
      attachCall(call);
      setPeerStatus("Incoming peer accepted. Waiting for remote audio…", "good");
    });
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
    await startLocalCapture();
    peer = new window.Peer();
    peer.on("open", (id) => {
      showInvite(id);
      const call = peer.call(targetId, localStream);
      attachCall(call);
      setPeerStatus(`Calling ${targetId}…`, "good");
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
  analyzer = new SameRoomAnalyzer({ modelUrl: "../model_output/model.json", wasmUrl: "../web-calibration/wasm_parity/wasm/same_room.wasm" });
  await analyzer.load();
  setPeerStatus(peerCode ? "Invite loaded. Start the microphone to join." : "Ready. Create a session or enter a peer code.");
}

createButton.addEventListener("click", createSession);
joinButton.addEventListener("click", joinSession);
copyInviteButton.addEventListener("click", copyInvite);
initialize().catch((error) => setPeerStatus(`Could not load analyzer: ${error.message}`, "error"));

window.addEventListener("beforeunload", () => {
  if (comparisonTimer) window.clearInterval(comparisonTimer);
  if (localCapture) localCapture.dispose();
  if (remoteCapture) remoteCapture.dispose();
  if (audioContext) audioContext.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (activeCall) activeCall.close();
  if (peer) peer.destroy();
  if (analyzer) analyzer.dispose();
});
