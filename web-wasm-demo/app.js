import { SameRoomAnalyzer } from "./same-room-analyzer.js";

const selectA = document.querySelector("#recording-a");
const selectB = document.querySelector("#recording-b");
const compareButton = document.querySelector("#compare");
const status = document.querySelector("#status");
const resultPanel = document.querySelector("#result");
let recordings = [];
let analyzer;

function optionText(item) { return `${item.label} — ${item.path.split("/").pop()}`; }

function populateSelect(select) {
  select.replaceChildren();
  for (const item of recordings) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = optionText(item);
    select.append(option);
  }
}

function selected(select) { return recordings.find((item) => item.id === select.value); }

function format(value, digits = 3) { return Number(value).toFixed(digits); }

function renderResult(result) {
  resultPanel.hidden = false;
  resultPanel.replaceChildren();
  const a = result.pair.a;
  const b = result.pair.b;
  const truthMatches = result.label === (result.expected >= 0.75 ? "close" : result.expected >= 0.25 ? "middle" : "unrelated");
  const title = document.createElement("div");
  title.className = "muted";
  title.textContent = `A: ${a.label}   |   B: ${b.label}`;
  resultPanel.append(title);

  const score = document.createElement("div");
  score.className = `score ${truthMatches ? "good" : "bad"}`;
  score.textContent = `Score ${format(result.score)} — ${result.label}${truthMatches ? " (expected)" : " (unexpected)"}`;
  resultPanel.append(score);

  const lines = [
    ["Truth", `${result.truth} → expected ${result.expected >= 0.75 ? "close" : result.expected >= 0.25 ? "middle" : "unrelated"}`],
    ["Held-out score", result.held_out_score === null ? "n/a" : format(result.held_out_score)],
    ["Windows", result.window_scores.map((value) => format(value, 2)).join("  ")],
    ["Features", `GCC ${format(result.features.gcc_peak)}   mel ${format(result.features.mel_peak, 2)}   flux ${format(result.features.flux_peak, 2)}`],
    ["Peak lags", `GCC ${result.lags.gcc >= 0 ? "+" : ""}${format(result.lags.gcc, 2)} s   mel ${result.lags.mel >= 0 ? "+" : ""}${format(result.lags.mel, 2)} s   flux ${result.lags.flux >= 0 ? "+" : ""}${format(result.lags.flux, 2)} s`],
    ["Audio", `${format(result.seconds, 1)} s`],
    ["Timing", `WASM ${format(result.wasm_ms, 1)} ms   total ${format(result.total_ms, 1)} ms`],
  ];
  for (const [name, value] of lines) {
    const row = document.createElement("div");
    row.className = "result-row";
    row.textContent = `${name}: ${value}`;
    resultPanel.append(row);
  }
  const quality = document.createElement("div");
  quality.className = result.quality.ok ? "result-row" : "result-row warn";
  quality.textContent = `Quality: ${result.quality.ok ? "ok" : result.quality.notes.join("; ")} (level ${format(result.quality.level_dbfs, 0)} dBFS, activity ${format(result.quality.activity_db, 1)} dB)`;
  resultPanel.append(quality);
}

async function initialize() {
  const response = await fetch("/api/audio-files");
  if (!response.ok) throw new Error(`Could not load audio list (${response.status})`);
  recordings = await response.json();
  if (recordings.length < 2) throw new Error("At least two valid WAV recordings are required");
  populateSelect(selectA);
  populateSelect(selectB);
  selectB.selectedIndex = Math.min(1, recordings.length - 1);
  analyzer = new SameRoomAnalyzer();
  await analyzer.load();
  selectA.disabled = false;
  selectB.disabled = false;
  compareButton.disabled = false;
  status.textContent = "Choose two recordings and compare them.";
}

compareButton.addEventListener("click", async () => {
  const a = selected(selectA);
  const b = selected(selectB);
  if (!a || !b || a.id === b.id) {
    status.textContent = "Choose two different recordings.";
    return;
  }
  compareButton.disabled = true;
  status.textContent = "Comparing…";
  resultPanel.hidden = true;
  try {
    renderResult(await analyzer.compare(a, b));
    status.textContent = "Comparison complete.";
  } catch (error) {
    status.textContent = `Could not compare recordings: ${error.message}`;
  } finally {
    compareButton.disabled = false;
  }
});

initialize().catch((error) => { status.textContent = `Could not start demo: ${error.message}`; });
