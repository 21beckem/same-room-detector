import { AudioCompare } from "/exports/compare/compare.js";

const modeElement = document.querySelector("#mode");
const durationElement = document.querySelector("#duration");
const configurationElement = document.querySelector("#configuration");
const latencyElement = document.querySelector("#latency");
const configurationElements = [configurationElement, latencyElement, modeElement, durationElement];
const configurations = {
  baseline: { contextRate: "model", outputSink: "default", captureGraph: "muted-output" },
  silent: { contextRate: "model", outputSink: "none", captureGraph: "muted-output" },
  device: { contextRate: "device", outputSink: "default", captureGraph: "muted-output" },
  "device-silent": { contextRate: "device", outputSink: "none", captureGraph: "muted-output" },
  "input-only": { contextRate: "model", outputSink: "default", captureGraph: "input-only" },
};
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const prepareButton = document.querySelector("#prepare");
const downloadButton = document.querySelector("#download");
const statusElement = document.querySelector("#status");
const summaryElement = document.querySelector("#summary");
const reportElement = document.querySelector("#report");

let analyzer;
let run = null;
let refreshTimer = null;
let eventLoopTimer = null;
let stopTimer = null;
let longTaskObserver = null;
let lastReport = null;
let capturing = false;
let starting = false;
let stopping = false;
let browserDetails = null;

function nowIso() { return new Date().toISOString(); }

function appendLimited(values, value, limit = 4096) {
  if (!Number.isFinite(value)) return;
  values.push(value);
  if (values.length > limit) values.shift();
}

function summarize(values) {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (amount) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

function startPageMetrics() {
  const expectedDurationSeconds = Math.max(10, Math.min(600, Number(durationElement.value) || 60));
  run = {
    schema: "same-room-audiocompare-diagnostics-run/v2",
    startedAt: nowIso(),
    mode: modeElement.value,
    expectedDurationSeconds,
    configuration: {
      id: configurationElement.value,
      ...configurations[configurationElement.value],
      latencyHint: latencyElement.value === "0.1" ? 0.1 : latencyElement.value,
    },
    browserDetails,
    timingHistory: [],
    events: [{ type: "page-visibility", at: nowIso(), visibility: document.visibilityState }],
    captureStarted: false,
    eventLoopLagMs: [],
    longTasks: [],
    errors: [],
  };

  let expectedAt = performance.now() + 250;
  eventLoopTimer = setInterval(() => {
    const current = performance.now();
    appendLimited(run.eventLoopLagMs, Math.max(0, current - expectedAt));
    expectedAt = current + 250;
  }, 250);

  if (globalThis.PerformanceObserver && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        run.longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
      }
    });
    longTaskObserver.observe({ type: "longtask" });
  }
}

function stopPageMetrics() {
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  if (longTaskObserver) longTaskObserver.disconnect();
  eventLoopTimer = null;
  longTaskObserver = null;
  if (run) run.stoppedAt = nowIso();
}

function currentReport() {
  if (!run) return null;
  const mic = run.captureStarted ? analyzer?.getMicDiagnostics?.() || null : null;
  return {
    ...run,
    eventLoop: summarize(run.eventLoopLagMs),
    eventLoopLagMs: undefined,
    longTasks: {
      count: run.longTasks.length,
      totalMs: run.longTasks.reduce((sum, item) => sum + item.duration, 0),
      maxMs: run.longTasks.reduce((max, item) => Math.max(max, item.duration), 0),
      entries: run.longTasks,
    },
    mic: mic ? {
      ...mic,
      capture: { ...mic.capture },
    } : null,
  };
}

function sampleTiming(mic) {
  if (!mic?.timing || !run?.captureStarted) return;
  const previous = run.timingHistory.at(-1);
  const timing = mic.timing;
  const intervalWallMs = previous ? timing.wallElapsedMs - previous.wallElapsedMs : null;
  run.timingHistory.push({
    ...timing,
    messages: mic.worklet.messages,
    framesReceived: mic.worklet.framesReceived,
    contextState: mic.context.state,
    contextCurrentTime: mic.context.currentTime,
    captureAgeMs: mic.capture.captureAgeMs,
    intervalAudioToWallRatio: intervalWallMs > 0
      ? (timing.contextElapsedSeconds - previous.contextElapsedSeconds) * 1000 / intervalWallMs : null,
    prepareCompleted: mic.preparation.completed,
    playbackActive: mic.playback.active,
  });
}

function render(sample = false) {
  const mic = run?.captureStarted ? analyzer?.getMicDiagnostics?.() : null;
  if (sample) sampleTiming(mic);
  const live = mic ? {
    mode: run?.mode,
    configuration: run?.configuration,
    actualAudio: mic.configuration,
    context: mic.context,
    timing: mic.timing,
    latestHistory: run?.timingHistory.at(-1),
    elapsedMs: mic.durationMs,
    messages: mic.worklet.messages,
    framesReceived: mic.worklet.framesReceived,
    audioSecondsReceived: mic.worklet.framesReceived / (mic.capture.sampleRate || 16000),
    deliveryIntervalMs: mic.worklet.intervalsMs,
    audioIntervalMs: mic.worklet.audioIntervalsMs,
    timingDivergenceMs: mic.worklet.timingDivergenceMs,
    sequenceGaps: mic.worklet.sequenceGaps,
    preparation: mic.preparation,
    playback: mic.playback,
    pageEventLoop: run ? summarize(run.eventLoopLagMs) : null,
    pageLongTasks: run ? run.longTasks.length : 0,
  } : { status: "waiting for capture" };
  summaryElement.textContent = JSON.stringify(live, null, 2);
  prepareButton.disabled = !capturing || !mic || mic.playback.active > 0
    || mic.capture.rawSampleCount < mic.capture.analysisSamples || mic.preparation.inFlight > 0;
  downloadButton.disabled = capturing || starting || stopping || !lastReport;
}

function recordError(error) {
  const message = String(error?.message || error);
  run?.errors.push({ at: nowIso(), message });
  statusElement.textContent = `Error: ${message}`;
}

async function stopCapture(message = "Capture stopped.") {
  if (stopping || starting) return;
  stopping = true;
  stopButton.disabled = true;
  if (stopTimer) clearTimeout(stopTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  stopTimer = null;
  refreshTimer = null;
  render(true);
  capturing = false;
  try {
    if (analyzer) await analyzer.stopMicAudio();
  } catch (error) {
    recordError(error);
    message = `Capture stopped with an error: ${error.message}`;
  }
  stopPageMetrics();
  stopping = false;
  startButton.disabled = false;
  for (const element of configurationElements) element.disabled = false;
  stopButton.disabled = true;
  prepareButton.disabled = true;
  lastReport = currentReport();
  reportElement.textContent = JSON.stringify(lastReport, null, 2);
  statusElement.textContent = message;
  render();
}

startButton.addEventListener("click", async () => {
  if (starting || capturing || stopping) return;
  starting = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  for (const element of configurationElements) element.disabled = true;
  downloadButton.disabled = true;
  lastReport = null;
  reportElement.textContent = "Run in progress…";
  statusElement.textContent = "Requesting microphone permission and starting capture…";
  startPageMetrics();
  try {
    if (!analyzer) analyzer = await AudioCompare.fromObject({ modelUrl: "/model.json", wasmUrl: "/same_room.wasm" });
    await analyzer.pipeMicAudio({
      prepareOnPacket: run.mode === "automatic-preparation",
      contextRate: run.configuration.contextRate,
      outputSink: run.configuration.outputSink,
      captureGraph: run.configuration.captureGraph,
      audioContextOptions: { latencyHint: run.configuration.latencyHint },
      diagnostics: true,
      onError: recordError,
    });
    run.captureStarted = true;
    run.captureStartedAt = nowIso();
    starting = false;
    capturing = true;
    stopButton.disabled = false;
    const durationMs = run.expectedDurationSeconds * 1000;
    stopTimer = setTimeout(() => void stopCapture(`Automatic stop after ${run.expectedDurationSeconds} seconds.`), durationMs);
    statusElement.textContent = `Capturing ${run.configuration.id}, ${run.configuration.latencyHint} latency, ${run.mode}. Keep this tab in the foreground.`;
    refreshTimer = setInterval(() => render(true), 1000);
    render(true);
  } catch (error) {
    starting = false;
    capturing = false;
    stopPageMetrics();
    startButton.disabled = false;
    for (const element of configurationElements) element.disabled = false;
    stopButton.disabled = true;
    recordError(error);
    lastReport = currentReport();
    reportElement.textContent = JSON.stringify(lastReport, null, 2);
    render();
  }
});

stopButton.addEventListener("click", () => void stopCapture());

prepareButton.addEventListener("click", async () => {
  prepareButton.disabled = true;
  statusElement.textContent = "Preparing and playing one microphone window…";
  try {
    const packet = await analyzer.prepareMicPacket();
    statusElement.textContent = `Prepared ${packet.buffer.byteLength} bytes at timestamp ${packet.timestamp}. Playback continues until its ended event.`;
  } catch (error) {
    recordError(error);
  } finally {
    render();
  }
});

downloadButton.addEventListener("click", () => {
  const report = lastReport || currentReport();
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audiocompare-diagnostics-${run.configuration.id}-${run.configuration.latencyHint}-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  statusElement.textContent = "Diagnostic JSON downloaded.";
});

document.addEventListener("visibilitychange", () => {
  if (run && !lastReport) run.events.push({ type: "page-visibility", at: nowIso(), visibility: document.visibilityState });
});

Promise.all([
  AudioCompare.fromObject({ modelUrl: "/model.json", wasmUrl: "/same_room.wasm" }),
  navigator.userAgentData?.getHighEntropyValues?.(["fullVersionList", "platformVersion"]).catch(() => null) ?? null,
])
  .then(([instance, details]) => {
    analyzer = instance;
    browserDetails = details;
    startButton.disabled = false;
    statusElement.textContent = "Ready. Test E (input-only) with Interactive latency and Capture only first.";
    render();
  })
  .catch((error) => {
    statusElement.textContent = `Could not load analyzer: ${error.message}`;
  });

window.addEventListener("beforeunload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (stopTimer) clearTimeout(stopTimer);
  void analyzer?.dispose();
});
