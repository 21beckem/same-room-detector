import { prepareSamples } from "./audio.js";
import { RawStreamCapture, RollingAudioBuffer } from "./live-audio.js";
import { SameRoomAnalyzer } from "./same-room-analyzer.js";

// Change this value to control how often a fresh live comparison is requested.
const COMPARISON_INTERVAL_MS = 1000;
// Keep the model input at one trained window, but retain enough history to
// estimate WebRTC transport delay before scoring.
const ANALYSIS_WINDOW_SECONDS = 12;
// User-tunable: set to 0 or any larger value to change the allowed live offset.
const MAX_ALIGNMENT_SECONDS = 3;
const MIN_COMPARISON_SECONDS = ANALYSIS_WINDOW_SECONDS + MAX_ALIGNMENT_SECONDS;
const CAPTURE_MARGIN_SECONDS = 1;
const LIVE_BUFFER_SECONDS = ANALYSIS_WINDOW_SECONDS + MAX_ALIGNMENT_SECONDS + CAPTURE_MARGIN_SECONDS;
const MAX_BUFFER_SECONDS = LIVE_BUFFER_SECONDS;
const RAW_AUDIO_CONSTRAINTS = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 96000 },
  sampleSize: { ideal: 16 },
  latency: { ideal: 0 },
  voiceIsolation: false,
  echoCancellation: { exact: false },
  noiseSuppression: { exact: false },
  autoGainControl: { exact: false },
  advanced: [{
    googEchoCancellation: false,
    googEchoCancellation2: false,
    googAutoGainControl: false,
    googAutoGainControl2: false,
    googNoiseSuppression: false,
    googNoiseSuppression2: false,
    googHighpassFilter: false,
    googTypingNoiseDetection: false,
  }],
};
const FALLBACK_AUDIO_CONSTRAINTS = {
  ...RAW_AUDIO_CONSTRAINTS,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

const createButton = document.querySelector("#create-session");
const joinButton = document.querySelector("#join-session");
const joinCodeInput = document.querySelector("#join-code");
const peerStatus = document.querySelector("#peer-status");
const captureStatus = document.querySelector("#capture-status");
const remoteAudio = document.querySelector("#remote-audio");
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
const localBufferProgress = document.querySelector("#local-buffer-progress");
const remoteBufferProgress = document.querySelector("#remote-buffer-progress");
const localWaveform = document.querySelector("#local-waveform");
const remoteWaveform = document.querySelector("#remote-waveform");
const localWaveformLevel = document.querySelector("#local-waveform-level");
const remoteWaveformLevel = document.querySelector("#remote-waveform-level");

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
let sessionRole = "none";
let analyzerReady = false;
let comparisonAttempts = 0;
let completedComparisons = 0;
let lastComparisonAttemptAt = null;
let lastResultAt = null;
let lastResult = null;
let lastComparisonError = null;
let waveformAnimationFrame;

const localBuffer = new RollingAudioBuffer(MAX_BUFFER_SECONDS);
const remoteBuffer = new RollingAudioBuffer(MAX_BUFFER_SECONDS);
const WAVEFORM_SECONDS = 3;

function setPeerStatus(message, kind = "") {
  peerStatus.textContent = message;
  peerStatus.className = `status ${kind}`;
  updateDebug();
}

function setCaptureStatus(message, kind = "") {
  captureStatus.textContent = message;
  captureStatus.className = `status ${kind}`;
  updateDebug();
}

function format(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function levelDbfs(rms) {
  return rms > 0 ? `${format(20 * Math.log10(rms), 1)} dBFS` : "-∞ dBFS";
}

function drawWaveform(canvas, levelOutput, buffer, color) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width));
  const cssHeight = 120;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.floor(cssWidth * pixelRatio));
  const pixelHeight = Math.max(1, Math.floor(cssHeight * pixelRatio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#f8fafb";
  context.fillRect(0, 0, cssWidth, cssHeight);
  context.strokeStyle = "#d9dfe3";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, cssHeight / 2 + 0.5);
  context.lineTo(cssWidth, cssHeight / 2 + 0.5);
  context.stroke();

  const samples = buffer.snapshot(WAVEFORM_SECONDS);
  if (!samples.length) {
    levelOutput.textContent = "waiting for audio";
    context.fillStyle = "#7a858d";
    context.font = "13px system-ui, sans-serif";
    context.fillText("Waiting for samples…", 12, 22);
    return;
  }

  const bucketCount = Math.max(1, Math.floor(cssWidth));
  const bucketSize = samples.length / bucketCount;
  let peak = 0;
  let energy = 0;
  const minima = new Float64Array(bucketCount);
  const maxima = new Float64Array(bucketCount);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((bucket + 1) * bucketSize)));
    let minimum = 1;
    let maximum = -1;
    for (let i = start; i < end; i += 1) {
      const value = samples[i];
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      peak = Math.max(peak, Math.abs(value));
      energy += value * value;
    }
    minima[bucket] = minimum;
    maxima[bucket] = maximum;
  }
  const scale = Math.min(2000, (cssHeight / 2 - 5) / Math.max(peak, 0.002));
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.beginPath();
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const x = bucket + 0.5;
    context.moveTo(x, cssHeight / 2 - maxima[bucket] * scale);
    context.lineTo(x, cssHeight / 2 - minima[bucket] * scale);
  }
  context.stroke();
  const rms = Math.sqrt(energy / samples.length);
  levelOutput.textContent = `peak ${format(peak, 4)} · RMS ${levelDbfs(rms)}`;
}

function drawWaveforms() {
  drawWaveform(localWaveform, localWaveformLevel, localBuffer, "#2878c8");
  drawWaveform(remoteWaveform, remoteWaveformLevel, remoteBuffer, "#b45b25");
  waveformAnimationFrame = window.requestAnimationFrame(drawWaveforms);
}

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : "never";
}

function setting(value) {
  return value === undefined ? "?" : value ? "on" : "off";
}

function trackSummary(stream) {
  const track = stream?.getAudioTracks?.()[0];
  if (!track) return "none";
  const settings = track.getSettings?.() || {};
  return [
    `state=${track.readyState}`,
    `enabled=${track.enabled}`,
    `muted=${track.muted}`,
    `rate=${settings.sampleRate ?? "?"}`,
    `channels=${settings.channelCount ?? "?"}`,
    `echo=${setting(settings.echoCancellation)}`,
    `noise=${setting(settings.noiseSuppression)}`,
    `gain=${setting(settings.autoGainControl)}`,
  ].join(" ");
}

function connectionSummary() {
  if (!activeCall) return "none";
  const connection = activeCall.peerConnection;
  if (!connection) return `media call peer=${activeCall.peer || "?"}`;
  return [
    `connection=${connection.connectionState || "?"}`,
    `ice=${connection.iceConnectionState || "?"}`,
    `signaling=${connection.signalingState || "?"}`,
  ].join(" ");
}

function updateDebug() {
  if (!debugOutput) return;
  const localSeconds = localBuffer.seconds;
  const remoteSeconds = remoteBuffer.seconds;
  localBufferLabel.textContent = `${format(localSeconds, 1)} / ${ANALYSIS_WINDOW_SECONDS.toFixed(1)} s`;
  remoteBufferLabel.textContent = `${format(remoteSeconds, 1)} / ${ANALYSIS_WINDOW_SECONDS.toFixed(1)} s`;
  localBufferProgress.value = Math.min(localSeconds, ANALYSIS_WINDOW_SECONDS);
  remoteBufferProgress.value = Math.min(remoteSeconds, ANALYSIS_WINDOW_SECONDS);

  const lastResultText = lastResult
    ? `${format(lastResult.score * 100, 1)}% ${lastResult.label} at ${formatTime(lastResultAt)}`
    : "none";
  const resultDetails = lastResult
    ? [
      `window scores=[${lastResult.window_scores.map((value) => format(value, 3)).join(", ")}]`,
      `features gcc=${format(lastResult.features.gcc_peak, 4)} mel=${format(lastResult.features.mel_peak, 4)} flux=${format(lastResult.features.flux_peak, 4)}`,
      `lags gcc=${format(lastResult.lags.gcc, 3)}s mel=${format(lastResult.lags.mel, 3)}s flux=${format(lastResult.lags.flux, 3)}s`,
      lastResult.alignment
        ? `alignment offset=${format(lastResult.alignment.offset_seconds, 3)}s correlation=${format(lastResult.alignment.correlation, 3)} margin=${format(lastResult.alignment.margin, 3)} ${lastResult.alignment.usable ? "used" : "not used"}`
        : "alignment not used",
      `quality=${lastResult.quality.ok ? "ok" : lastResult.quality.notes.join("; ")}`,
    ].join("\n  ")
    : "none";

  debugOutput.textContent = [
    `status: peer=${peerStatus.textContent} | capture=${captureStatus.textContent}`,
    `analyzer: ${analyzerReady ? "ready" : "not ready"} | role=${sessionRole} | busy=${comparisonInFlight}`,
    `peer: id=${peer?.id || "none"} | connection=${connectionSummary()}`,
    `local buffer: ${format(localSeconds, 3)}s ${localBuffer.totalSamples} samples ${localBuffer.sampleRate || "?"}Hz ${localBuffer.chunkCount} chunks`,
    `remote buffer: ${format(remoteSeconds, 3)}s ${remoteBuffer.totalSamples} samples ${remoteBuffer.sampleRate || "?"}Hz ${remoteBuffer.chunkCount} chunks`,
    `local track: ${trackSummary(localStream)}`,
    `remote track: ${trackSummary(remoteCapture?.stream)}`,
    `comparisons: attempts=${comparisonAttempts} completed=${completedComparisons} interval=${COMPARISON_INTERVAL_MS}ms last attempt=${formatTime(lastComparisonAttemptAt)}`,
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

async function ensureLocalStream() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture requires HTTPS or localhost");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: false });
  } catch (error) {
    if (error.name !== "OverconstrainedError") throw error;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: FALLBACK_AUDIO_CONSTRAINTS, video: false });
  }
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

async function createAudioContext(sampleRate) {
  let context;
  try {
    const options = { latencyHint: "interactive" };
    if (sampleRate) options.sampleRate = sampleRate;
    context = new AudioContext(options);
  } catch {
    context = new AudioContext({ latencyHint: "interactive" });
  }
  await context.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
  if (context.state === "suspended") await context.resume();
  return context;
}

async function ensureAudioContext(sampleRate) {
  if (!audioContext) {
    audioContext = await createAudioContext(sampleRate);
  } else if (!localCapture && sampleRate && audioContext.sampleRate !== sampleRate) {
    const replacement = await createAudioContext(sampleRate);
    const previous = audioContext;
    audioContext = replacement;
    await previous.close();
  }
  if (audioContext.state === "suspended") await audioContext.resume();
  return audioContext;
}

async function startLocalCapture() {
  await ensureLocalStream();
  const trackRate = localStream.getAudioTracks()[0]?.getSettings?.().sampleRate;
  const context = await ensureAudioContext(trackRate);
  if (!localCapture) {
    localCapture = new RawStreamCapture(context, localStream, (samples, sampleRate) => {
      localBuffer.append(samples, sampleRate);
    });
  }
  updateDebug();
}

async function startRemoteCapture(stream) {
  const context = await ensureAudioContext();
  if (remoteCapture) remoteCapture.dispose();
  const remoteTracks = stream.getAudioTracks();
  if (!remoteTracks.length) throw new Error("Peer connected, but the remote stream contains no audio track");
  for (const track of remoteTracks) track.enabled = true;
  remoteAudio.srcObject = stream;
  try {
    await remoteAudio.play();
  } catch (error) {
    // The element is muted, so autoplay should normally be allowed. The
    // WebAudio graph remains the analysis source if a browser still rejects it.
    setCaptureStatus(`Remote stream received; browser playback was not started (${error.message}).`, "warn");
  }
  localBuffer.clear();
  remoteBuffer.clear();
  remoteCapture = new RawStreamCapture(context, stream, (samples, sampleRate) => {
    remoteBuffer.append(samples, sampleRate);
  });
  updateDebug();
  setCaptureStatus("Both microphones connected. Collecting live audio…", "good");
  startComparisons();
}

function startComparisons() {
  if (comparisonTimer) window.clearInterval(comparisonTimer);
  comparisonTimer = window.setInterval(runComparison, COMPARISON_INTERVAL_MS);
  runComparison();
}

function renderResult(result) {
  lastResult = result;
  lastResultAt = Date.now();
  lastComparisonError = null;
  completedComparisons += 1;
  resultPanel.hidden = false;
  scoreOutput.textContent = `${format(result.score * 100, 1)}% — ${result.label}`;
  const scoreClass = result.label === "close" ? "good" : result.label === "middle" ? "warn" : "";
  scoreOutput.className = `score ${scoreClass}`;
  const notes = result.quality.ok ? "quality ok" : result.quality.notes.join("; ");
  qualityOutput.textContent = `Quality: ${notes || "quality warning"} · audio ${format(result.seconds, 1)} s · levels ${format(result.quality.level_dbfs, 0)} dBFS`;
  const alignmentText = result.alignment
    ? ` · alignment ${format(result.alignment.offset_seconds)} s / ${format(result.alignment.correlation)}${result.alignment.usable ? "" : " (weak)"}`
    : "";
  detailsOutput.textContent = `Features GCC ${format(result.features.gcc_peak)} · mel ${format(result.features.mel_peak)} · flux ${format(result.features.flux_peak)} · lags ${format(result.lags.gcc)} / ${format(result.lags.mel)} / ${format(result.lags.flux)} s${alignmentText} · WASM ${format(result.wasm_ms, 0)} ms`;
  updateDebug();
}

async function runComparison() {
  if (!localCapture || !remoteCapture) {
    updateDebug();
    return;
  }
  comparisonAttempts += 1;
  lastComparisonAttemptAt = Date.now();
  if (comparisonInFlight) {
    updateDebug();
    return;
  }
  const localSeconds = localBuffer.seconds;
  const remoteSeconds = remoteBuffer.seconds;
  if (Math.min(localSeconds, remoteSeconds) < MIN_COMPARISON_SECONDS) {
    setCaptureStatus(`Collecting audio… local ${format(localSeconds, 1)} s, remote ${format(remoteSeconds, 1)} s`);
    return;
  }

  comparisonInFlight = true;
  try {
    const sampleRate = localBuffer.sampleRate;
    const localAudio = prepareSamples(localBuffer.snapshot(LIVE_BUFFER_SECONDS), sampleRate, LIVE_BUFFER_SECONDS);
    const remoteAudio = prepareSamples(remoteBuffer.snapshot(LIVE_BUFFER_SECONDS), remoteBuffer.sampleRate, LIVE_BUFFER_SECONDS);
    const result = await analyzer.compareBuffers(
      localAudio,
      remoteAudio,
      { label: "local microphone" },
      { label: "remote microphone" },
      { live: true, maxAlignmentSeconds: MAX_ALIGNMENT_SECONDS },
    );
    renderResult(result);
    setCaptureStatus(`Live comparison updated. Next comparison in ${format(COMPARISON_INTERVAL_MS / 1000, 1)} s.`, "good");
  } catch (error) {
    lastComparisonError = error.message;
    setCaptureStatus(`Comparison failed: ${error.message}`, "error");
  } finally {
    comparisonInFlight = false;
    updateDebug();
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
  updateDebug();
  call.on("stream", (stream) => startRemoteCapture(stream).catch((error) => setCaptureStatus(`Remote audio failed: ${error.message}`, "error")));
  call.on("close", () => {
    if (activeCall !== call) return;
    activeCall = null;
    if (remoteCapture) {
      remoteCapture.dispose();
      remoteCapture = null;
    }
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    if (comparisonTimer) window.clearInterval(comparisonTimer);
    setCaptureStatus("The other peer disconnected.", "warn");
  });
  call.on("error", handlePeerError);
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
    sessionRole = "joiner";
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
  analyzerReady = true;
  setPeerStatus(peerCode ? "Invite loaded. Start the microphone to join." : "Ready. Create a session or enter a peer code.");
}

createButton.addEventListener("click", createSession);
joinButton.addEventListener("click", joinSession);
copyInviteButton.addEventListener("click", copyInvite);
initialize().catch((error) => setPeerStatus(`Could not load analyzer: ${error.message}`, "error"));
updateDebug();
drawWaveforms();

window.addEventListener("beforeunload", () => {
  if (comparisonTimer) window.clearInterval(comparisonTimer);
  if (waveformAnimationFrame) window.cancelAnimationFrame(waveformAnimationFrame);
  if (localCapture) localCapture.dispose();
  if (remoteCapture) remoteCapture.dispose();
  if (audioContext) audioContext.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (activeCall) activeCall.close();
  remoteAudio.pause();
  remoteAudio.srcObject = null;
  if (peer) peer.destroy();
  if (analyzer) analyzer.dispose();
});
