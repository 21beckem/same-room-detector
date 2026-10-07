#!/usr/bin/env node
/*
 * JavaScript counterpart to parity_python.py.
 *
 * Run from the repository root:
 *
 *   node web-calibration/js_parity/parity_javascript.js --compare web-calibration/py_parity/python-output.json
 *
 * This is deliberately a dependency-free Node script. The numerical routines
 * are written so the same implementation can later be moved into browser
 * modules. It reports exact JSON mismatches; it never rounds values to make a
 * comparison look successful.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { performance } = require("perf_hooks");

function findProjectRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, "model_output", "model.json")) && fs.existsSync(path.join(current, "data-exploration"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate project root");
    current = parent;
  }
}

const ROOT = findProjectRoot(__dirname);
const DATASET = path.join(ROOT, "data-exploration", "room-audio-recordings");
const MODEL_PATH = path.join(ROOT, "model_output", "model.json");
const CV_PATH = path.join(ROOT, "model_output", "cv_pairs.csv");

const SR = 16000;
const N_FFT = 1024;
const HOP = 320;
const FRAME_RATE = SR / HOP;
const N_MELS = 40;
const FMIN = 50.0;
const FMAX = 7500.0;
const MAX_SEC = 20.0;

function scalar(value) {
  return Number.isFinite(value) ? value : null;
}

function sha256F64(values) {
  const buffer = Buffer.alloc(values.length * 8);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < values.length; i += 1) view.setFloat64(i * 8, values[i], true);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function flatten(rows) {
  if (!Array.isArray(rows[0]) && !ArrayBuffer.isView(rows[0])) return Array.from(rows);
  const out = [];
  for (const row of rows) for (const value of Array.from(row)) out.push(value);
  return out;
}

function arraySummary(values, shape) {
  const flat = flatten(values);
  let min = Infinity, max = -Infinity, sum = 0;
  for (const value of flat) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  const mean = flat.length ? sum / flat.length : null;
  let sq = 0;
  if (flat.length) for (const value of flat) sq += (value - mean) ** 2;
  return {
    shape,
    dtype: "float64",
    length: flat.length,
    sha256_f64: sha256F64(flat),
    min: flat.length ? scalar(min) : null,
    max: flat.length ? scalar(max) : null,
    mean: scalar(mean),
    std: scalar(flat.length ? Math.sqrt(sq / flat.length) : null),
    first: Array.from(flat.slice(0, 8), scalar),
    last: Array.from(flat.slice(-8), scalar),
  };
}

function readWav(filePath) {
  const buffer = fs.readFileSync(filePath);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const text = (offset, length) => buffer.toString("ascii", offset, offset + length);
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") throw new Error(`Not a RIFF/WAVE file: ${filePath}`);
  let fmt = null;
  let dataOffset = null;
  let dataLength = null;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = text(offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLength = length;
      break;
    }
    offset = body + length + (length & 1);
  }
  if (!fmt || dataOffset === null) throw new Error(`WAV is missing fmt/data chunks: ${filePath}`);
  const bytesPerSample = fmt.bits / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const frames = Math.floor(dataLength / frameBytes);
  const mono = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      const at = dataOffset + (frame * fmt.channels + channel) * bytesPerSample;
      let sample;
      if (fmt.format === 3 && fmt.bits === 32) sample = view.getFloat32(at, true);
      else if (fmt.format === 1 && fmt.bits === 8) sample = (view.getUint8(at) - 128) / 128;
      else if (fmt.format === 1 && fmt.bits === 16) sample = view.getInt16(at, true) / 32768;
      else if (fmt.format === 1 && fmt.bits === 24) {
        let raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        if (raw & 0x800000) raw -= 0x1000000;
        sample = raw / 2147483648;
      } else if (fmt.format === 1 && fmt.bits === 32) sample = view.getInt32(at, true) / 2147483648;
      else throw new Error(`Unsupported WAV encoding format=${fmt.format}, bits=${fmt.bits}`);
      total += sample;
    }
    mono[frame] = total / fmt.channels;
  }
  return { samples: mono, sampleRate: fmt.sampleRate, channels: fmt.channels };
}

// This is the default SciPy resample_poly filter for the 48 kHz -> 16 kHz
// recordings in this repository. It follows SciPy's filter shape and padding
// rules, while intentionally retaining the code for other integer rates.
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const y = (x * x) / 4;
  for (let k = 1; k < 50; k += 1) {
    term *= y / (k * k);
    sum += term;
    if (Math.abs(term) < 1e-18 * Math.abs(sum)) break;
  }
  return sum;
}

function scipyFirwin(numTaps, cutoff, beta = 5.0) {
  const center = (numTaps - 1) / 2;
  const denom = besselI0(beta);
  const result = new Float64Array(numTaps);
  for (let i = 0; i < numTaps; i += 1) {
    const x = i - center;
    const sinc = Math.abs(x) < 1e-15 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
    const ratio = (i - center) / center;
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denom;
    result[i] = sinc * window;
  }
  let sum = 0;
  for (const value of result) sum += value;
  for (let i = 0; i < result.length; i += 1) result[i] /= sum;
  return result;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function resamplePoly(x, up, down) {
  const g = gcd(up, down);
  up /= g; down /= g;
  if (up === 1 && down === 1) return Float64Array.from(x);
  const maxRate = Math.max(up, down);
  const halfLen = 10 * maxRate;
  const base = scipyFirwin(2 * halfLen + 1, 1 / maxRate);
  const nPrePad = down - (halfLen % down);
  const filter = new Float64Array(nPrePad + base.length);
  for (let i = 0; i < base.length; i += 1) filter[nPrePad + i] = base[i] * up;
  const outputLength = Math.floor((x.length * up + down - 1) / down);
  const nPreRemove = Math.floor((halfLen + nPrePad) / down);
  const output = new Float64Array(outputLength);
  for (let k = 0; k < outputLength; k += 1) {
    const sourcePosition = (nPreRemove + k) * down;
    let total = 0;
    for (let j = 0; j < filter.length; j += 1) {
      const source = sourcePosition - j;
      if (source >= 0 && source < x.length) total += filter[j] * x[source];
    }
    output[k] = total;
  }
  return output;
}

function loadAudio(filePath) {
  const wav = readWav(filePath);
  let x = wav.samples;
  if (wav.sampleRate !== SR) {
    const factor = gcd(wav.sampleRate, SR);
    x = resamplePoly(x, SR / factor, wav.sampleRate / factor);
  }
  x = x.slice(0, Math.floor(MAX_SEC * SR));
  let mean = 0;
  for (const value of x) mean += value;
  mean /= x.length;
  for (let i = 0; i < x.length; i += 1) x[i] -= mean;
  return x;
}

// Mixed-radix Cooley-Tukey FFT. The chosen factor order supports SciPy's
// next_fast_len values (2, 3, 5, 7, 11, 13) without third-party packages.
function fftComplex(inputRe, inputIm, inverse = false) {
  const n = inputRe.length;
  if (n === 1) return { re: Float64Array.from(inputRe), im: Float64Array.from(inputIm) };
  let factor = 0;
  for (const candidate of [2, 3, 5, 7, 11, 13]) if (n % candidate === 0) { factor = candidate; break; }
  if (!factor) {
    const re = new Float64Array(n), im = new Float64Array(n);
    const sign = inverse ? 1 : -1;
    for (let k = 0; k < n; k += 1) for (let j = 0; j < n; j += 1) {
      const angle = sign * 2 * Math.PI * j * k / n;
      re[k] += inputRe[j] * Math.cos(angle) - inputIm[j] * Math.sin(angle);
      im[k] += inputRe[j] * Math.sin(angle) + inputIm[j] * Math.cos(angle);
    }
    return { re, im };
  }
  const m = n / factor;
  const sub = [];
  for (let r = 0; r < factor; r += 1) {
    const re = new Float64Array(m), im = new Float64Array(m);
    for (let q = 0; q < m; q += 1) { re[q] = inputRe[q * factor + r]; im[q] = inputIm[q * factor + r]; }
    sub.push(fftComplex(re, im, inverse));
  }
  const outRe = new Float64Array(n), outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k += 1) {
    const j = k % m;
    for (let r = 0; r < factor; r += 1) {
      const angle = sign * 2 * Math.PI * r * k / n;
      const twRe = Math.cos(angle), twIm = Math.sin(angle);
      outRe[k] += sub[r].re[j] * twRe - sub[r].im[j] * twIm;
      outIm[k] += sub[r].re[j] * twIm + sub[r].im[j] * twRe;
    }
  }
  return { re: outRe, im: outIm };
}

function nextFastLen(target) {
  for (let n = target; ; n += 1) {
    let value = n;
    for (const p of [2, 3, 5, 7, 11, 13]) while (value % p === 0) value /= p;
    if (value === 1) return n;
  }
}

function rfft(x, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x.subarray ? x.subarray(0, Math.min(x.length, n)) : x.slice(0, Math.min(x.length, n)));
  const result = fftComplex(re, im, false);
  return { re: result.re.slice(0, n / 2 + 1), im: result.im.slice(0, n / 2 + 1), n };
}

function irfft(spec) {
  const n = spec.n;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(spec.re); im.set(spec.im);
  for (let i = 1; i < n / 2; i += 1) { re[n - i] = spec.re[i]; im[n - i] = -spec.im[i]; }
  const result = fftComplex(re, im, true).re;
  for (let i = 0; i < n; i += 1) result[i] /= n;
  return result;
}

function melFilterbank() {
  const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
  const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const edges = [];
  for (let i = 0; i < N_MELS + 2; i += 1) {
    const mel = hz2mel(FMIN) + (hz2mel(FMAX) - hz2mel(FMIN)) * i / (N_MELS + 1);
    edges.push(mel2hz(mel));
  }
  const bins = Array.from({ length: N_FFT / 2 + 1 }, (_, i) => i * SR / N_FFT);
  const fb = [];
  for (let i = 0; i < N_MELS; i += 1) {
    const row = new Float64Array(bins.length);
    const lo = edges[i], center = edges[i + 1], hi = edges[i + 2];
    for (let j = 0; j < bins.length; j += 1) row[j] = Math.max(0, Math.min((bins[j] - lo) / (center - lo), (hi - bins[j]) / (hi - center)));
    let sum = row.reduce((a, b) => a + b, 0);
    if (sum === 0) { let best = 0; for (let j = 1; j < bins.length; j += 1) if (Math.abs(bins[j] - center) < Math.abs(bins[best] - center)) best = j; row[best] = 1; sum = 1; }
    for (let j = 0; j < row.length; j += 1) row[j] /= sum;
    fb.push(row);
  }
  return fb;
}
const FB = melFilterbank();

function logMel(x) {
  const frames = Math.max(0, 1 + Math.floor((x.length - N_FFT) / HOP));
  const output = Array.from({ length: N_MELS }, () => new Float64Array(frames));
  const hann = Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT));
  const spectrumScale = hann.reduce((sum, value) => sum + value, 0) ** 2;
  for (let frame = 0; frame < frames; frame += 1) {
    const block = new Float64Array(N_FFT);
    const start = frame * HOP;
    for (let i = 0; i < N_FFT; i += 1) block[i] = x[start + i] * hann[i];
    const spec = rfft(block, N_FFT);
    for (let band = 0; band < N_MELS; band += 1) {
      let power = 0;
      for (let bin = 0; bin < spec.re.length; bin += 1) power += FB[band][bin] * (spec.re[bin] ** 2 + spec.im[bin] ** 2) / spectrumScale;
      output[band][frame] = 10 * Math.log10(power + 1e-12);
    }
  }
  return output;
}

function zscore(values, axis) {
  if (axis === 1) return values.map((row) => {
    let mean = row.reduce((a, b) => a + b, 0) / row.length;
    let variance = row.reduce((a, b) => a + (b - mean) ** 2, 0) / row.length;
    const sd = Math.max(Math.sqrt(variance), 1e-6);
    return Float64Array.from(row, (v) => (v - mean) / sd);
  });
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.max(Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length), 1e-6);
  return Float64Array.from(values, (v) => (v - mean) / sd);
}

function onsetFlux(mel) {
  const bands = mel.length, frames = mel[0].length;
  const raw = new Float64Array(frames);
  for (let band = 0; band < bands; band += 1) for (let frame = 1; frame < frames; frame += 1) raw[frame] += Math.max(mel[band][frame] - mel[band][frame - 1], 0);
  const filtered = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const left = raw[Math.max(0, i - 1)], middle = raw[i], right = raw[Math.min(frames - 1, i + 1)];
    filtered[i] = (left + middle + right) / 3;
  }
  return filtered;
}

function makeClip(x) {
  const melDb = logMel(x);
  const flux = onsetFlux(melDb);
  let energy = 0;
  for (const value of x) energy += value * value;
  const rmsDbfs = 20 * Math.log10(Math.sqrt(energy / x.length) + 1e-12);
  const frameMeans = melDb[0].map((_, frame) => melDb.reduce((sum, row) => sum + row[frame], 0) / melDb.length);
  const activityMean = frameMeans.reduce((a, b) => a + b, 0) / frameMeans.length;
  const activityDb = Math.sqrt(frameMeans.reduce((a, b) => a + (b - activityMean) ** 2, 0) / frameMeans.length);
  return { x, melDb, flux, rmsDbfs, activityDb };
}

function segment(clip, s0, n) {
  const f0 = Math.floor(s0 / HOP);
  const nf = 1 + Math.floor((n - N_FFT) / HOP);
  return {
    x: clip.x.slice(s0, s0 + n),
    mel: clip.melDb.map((row) => row.slice(f0, f0 + nf)),
    flux: clip.flux.slice(f0, f0 + nf),
  };
}

function gccPhat(xa, xb, fmin = 100, fmax = 4000) {
  const n = Math.min(xa.length, xb.length);
  const nfft = nextFastLen(2 * n - 1);
  const a = rfft(xa.slice(0, n), nfft), b = rfft(xb.slice(0, n), nfft);
  for (let i = 0; i < a.re.length; i += 1) {
    const real = a.re[i] * b.re[i] + a.im[i] * b.im[i];
    const imag = a.im[i] * b.re[i] - a.re[i] * b.im[i];
    const frequency = i * SR / nfft;
    const allowed = frequency >= fmin && frequency <= fmax;
    const magnitude = Math.sqrt(real * real + imag * imag);
    a.re[i] = allowed ? real / (magnitude + 1e-12) : 0;
    a.im[i] = allowed ? imag / (magnitude + 1e-12) : 0;
  }
  const cc0 = irfft({ re: a.re, im: a.im, n: nfft });
  const scale = 2 * a.re.reduce((count, _, i) => count + (i * SR / nfft >= fmin && i * SR / nfft <= fmax ? 1 : 0), 0) / nfft;
  const cc = Float64Array.from(cc0, (v) => v / scale);
  return { lags: Array.from({ length: 2 * n - 1 }, (_, i) => (i - (n - 1)) / SR), cc: Array.from(cc.slice(nfft - (n - 1))).concat(Array.from(cc.slice(0, n))) };
}

function xcorrUnbiased(a, b) {
  const rowsA = Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? a : [a];
  const rowsB = Array.isArray(b[0]) || ArrayBuffer.isView(b[0]) ? b : [b];
  const t = rowsA[0].length;
  const nfft = nextFastLen(2 * t - 1);
  const circular = new Float64Array(nfft);
  for (let row = 0; row < rowsA.length; row += 1) {
    const aa = rfft(rowsA[row], nfft), bb = rfft(rowsB[row], nfft);
    const prodRe = new Float64Array(aa.re.length), prodIm = new Float64Array(aa.re.length);
    for (let i = 0; i < prodRe.length; i += 1) { prodRe[i] = aa.re[i] * bb.re[i] + aa.im[i] * bb.im[i]; prodIm[i] = aa.im[i] * bb.re[i] - aa.re[i] * bb.im[i]; }
    const corr = irfft({ re: prodRe, im: prodIm, n: nfft });
    for (let i = 0; i < nfft; i += 1) circular[i] += corr[i] / rowsA.length;
  }
  const lags = Array.from({ length: 2 * t - 1 }, (_, i) => i - (t - 1));
  const cc = Array.from(circular.slice(nfft - (t - 1))).concat(Array.from(circular.slice(0, t)));
  return { lags: lags.map((v) => v / FRAME_RATE), cc: cc.map((v, i) => v / (t - Math.abs(lags[i]))) };
}

function peakInWindow(lags, cc, maxLag) {
  let best = -Infinity, bestIndex = 0;
  for (let i = 0; i < lags.length; i += 1) if (Math.abs(lags[i]) <= maxLag + 1e-9 && cc[i] > best) { best = cc[i]; bestIndex = i; }
  return [best, lags[bestIndex]];
}

function windowFeatures(sa, sb, maxLag) {
  const n = Math.min(sa.x.length, sb.x.length);
  const t = Math.min(sa.mel[0].length, sb.mel[0].length);
  const [gp, gl] = peakInWindow(...Object.values(gccPhat(sa.x.slice(0, n), sb.x.slice(0, n))), maxLag);
  const ma = zscore(sa.mel.map((row) => row.slice(0, t)), 1);
  const mb = zscore(sb.mel.map((row) => row.slice(0, t)), 1);
  const [mp, ml] = peakInWindow(...Object.values(xcorrUnbiased(ma, mb)), maxLag);
  const [fp, fl] = peakInWindow(...Object.values(xcorrUnbiased(zscore(sa.flux.slice(0, t)), zscore(sb.flux.slice(0, t)))), maxLag);
  return { gcc_peak: gp, gcc_lag: gl, mel_peak: mp, mel_lag: ml, flux_peak: fp, flux_lag: fl };
}

function featureVector(f) { return [Math.log10(Math.max(f.gcc_peak, 1e-3)), f.mel_peak, f.flux_peak]; }
function modelLogits(model, vectors) { return vectors.map((vector) => model.intercept + vector.reduce((sum, value, i) => sum + ((value - model.mean[i]) / model.std[i]) * model.coef[i], 0)); }
function expit(value) { return 1 / (1 + Math.exp(-value)); }
function windowPlan(n, cfg) {
  const win = Math.round(cfg.window_sec * FRAME_RATE) * HOP;
  const hop = Math.round(cfg.hop_sec * FRAME_RATE) * HOP;
  if (n < win) return [[0, n]];
  const last = Math.floor((n - win) / HOP) * HOP;
  const starts = [];
  for (let start = 0; start <= last; start += hop) starts.push(start);
  if (last - starts[starts.length - 1] > hop / 2) starts.push(last);
  return starts.map((start) => [start, win]);
}
function median(values) { const sorted = values.slice().sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function bandLabel(score) { return score >= 0.75 ? "close" : score >= 0.25 ? "middle" : "unrelated"; }

function scoreClips(model, ca, cb) {
  const cfg = model.config;
  const n = Math.min(ca.x.length, cb.x.length);
  if (n < cfg.min_sec * SR) throw new Error(`Need at least ${cfg.min_sec.toFixed(0)} s of audio from each device (got ${(n / SR).toFixed(1)} s).`);
  const features = windowPlan(n, cfg).map(([s, l]) => windowFeatures(segment(ca, s, l), segment(cb, s, l), cfg.max_lag));
  const logits = modelLogits(model, features.map(featureVector));
  const windowScores = logits.map(expit);
  const score = expit(logits.reduce((a, b) => a + b, 0) / logits.length);
  const notes = [];
  const level = Math.min(ca.rmsDbfs, cb.rmsDbfs), activity = Math.min(ca.activityDb, cb.activityDb);
  if (level < -60) notes.push("very quiet input");
  if (activity < 1) notes.push("very steady sound: little happening to compare");
  if (n < cfg.window_sec * SR) notes.push(`shorter than the ${cfg.window_sec.toFixed(0)} s training window`);
  if (windowScores.length > 1 && Math.max(...windowScores) - Math.min(...windowScores) > 0.5) notes.push("windows disagree with each other");
  return {
    score, label: bandLabel(score), window_scores: windowScores,
    features: { gcc_peak: median(features.map((f) => f.gcc_peak)), mel_peak: median(features.map((f) => f.mel_peak)), flux_peak: median(features.map((f) => f.flux_peak)) },
    lags: { gcc: median(features.map((f) => f.gcc_lag)), mel: median(features.map((f) => f.mel_lag)), flux: median(features.map((f) => f.flux_lag)) },
    quality: { ok: notes.length === 0, notes, level_dbfs: level, activity_db: activity }, seconds: n / SR,
  };
}

function discoverFiles() {
  const files = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith(".wav")) files.push(full);
    }
  }
  walk(DATASET);
  return files.sort((a, b) => {
    const aa = path.relative(DATASET, a).split(path.sep);
    const bb = path.relative(DATASET, b).split(path.sep);
    for (let i = 0; i < Math.min(aa.length, bb.length); i += 1) {
      if (aa[i] < bb[i]) return -1;
      if (aa[i] > bb[i]) return 1;
    }
    return aa.length - bb.length;
  });
}
function itemFromPath(filePath) {
  const relative = path.relative(DATASET, filePath).split(path.sep);
  const category = relative[0], group = Number(relative[1].replace("group-", ""));
  const device = relative[2].split("_").pop().replace(/\.wav$/i, "");
  return { cat: category, gid: group, dev: device, path: relative.join("/"), label: `${category}/g${group}/${device}` };
}
function parseCv() {
  if (!fs.existsSync(CV_PATH)) return {};
  const rows = fs.readFileSync(CV_PATH, "utf8").trim().split(/\r?\n/).slice(1);
  const result = {};
  for (const line of rows) { const [pairId, , , heldOut] = line.split(","); result[pairId] = Number(heldOut); }
  return result;
}
function lookupCv(cv, a, b) { const ka = a.split("/").slice(0, 2).join("/"), kb = b.split("/").slice(0, 2).join("/"); return ka === kb ? (cv[ka] ?? null) : (cv[`${a}|${b}`] ?? cv[`${b}|${a}`] ?? null); }
function pairTruth(a, b, targets) { return a.cat === b.cat && a.gid === b.gid ? [targets[a.cat], `same group (${a.cat}), target ${targets[a.cat].toFixed(2)}`] : [0, "different groups, target 0.00"]; }

function outputFor(args) {
  const started = performance.now();
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));
  const paths = discoverFiles();
  const items = paths.map(itemFromPath);
  const clips = new Map();
  const loadAudioMs = [], makeClipMs = [];
  for (const item of items) {
    let t0 = performance.now();
    const audio = loadAudio(path.join(DATASET, ...item.path.split("/")));
    loadAudioMs.push(performance.now() - t0);
    t0 = performance.now();
    clips.set(item.path, makeClip(audio));
    makeClipMs.push(performance.now() - t0);
  }
  const files = items.map((item) => {
    const clip = clips.get(item.path);
    return { ...item, audio: arraySummary(clip.x, [clip.x.length]), mel_db: arraySummary(clip.melDb, [clip.melDb.length, clip.melDb[0].length]), flux: arraySummary(clip.flux, [clip.flux.length]), rms_dbfs: clip.rmsDbfs, activity_db: clip.activityDb };
  });
  const allPairs = [];
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) allPairs.push([items[i], items[j]]);
  let selected = allPairs;
  if (!args.allPairs) {
    const within = allPairs.filter(([a, b]) => a.cat === b.cat && a.gid === b.gid);
    const cross = allPairs.filter(([a, b]) => !(a.cat === b.cat && a.gid === b.gid));
    selected = within.concat(cross.slice(0, 5), cross.slice(Math.floor(cross.length / 2), Math.floor(cross.length / 2) + 5), cross.slice(-5)).slice(0, args.pairLimit);
  }
  const cv = parseCv();
  const pairWindowsMs = [], scoreClipsMs = [];
  const pairs = selected.map(([a, b]) => {
    const ca = clips.get(a.path), cb = clips.get(b.path);
    let t0 = performance.now();
    const windows = windowPlan(Math.min(ca.x.length, cb.x.length), model.config).map(([start, length]) => {
      const features = windowFeatures(segment(ca, start, length), segment(cb, start, length), model.config.max_lag);
      const vector = featureVector(features), logit = modelLogits(model, [vector])[0];
      return { start, length, features, feature_vector: vector, logit, score: expit(logit) };
    });
    pairWindowsMs.push(performance.now() - t0);
    const [target, description] = pairTruth(a, b, model.targets);
    t0 = performance.now();
    const result = scoreClips(model, ca, cb);
    scoreClipsMs.push(performance.now() - t0);
    return { a: a.label, b: b.label, path_a: a.path, path_b: b.path, truth: { target, description }, held_out: lookupCv(cv, a.label, b.label), windows, result };
  });
  const plans = {};
  for (const n of [8 * SR, 12 * SR, 20 * SR, 320000]) plans[String(n)] = windowPlan(n, model.config);
  return { output: {
    format: "same-room-parity-v1", implementation: "parity-reference", model_path: "model_output/model.json", model,
    constants: { SR, N_FFT, HOP, FRAME_RATE, N_MELS, FMIN, FMAX, MAX_SEC }, files, pairs,
    pair_count_available: allPairs.length, pair_count_scored: selected.length,
    helpers: { band_labels: Object.fromEntries([-0.1, 0, 0.249999, 0.25, 0.749999, 0.75, 1].map((v) => [String(v), bandLabel(v)])), window_plans: plans },
  }, timing: {
    implementation: "javascript-reimplementation", files: items.length, pairs: selected.length,
    load_audio_ms: loadAudioMs, make_clip_ms: makeClipMs,
    pair_windows_ms: pairWindowsMs, score_clips_ms: scoreClipsMs,
    total_ms: performance.now() - started,
  }};
}

function compareValues(a, b, location = "$", result = { exact: 0, mismatches: [], maxAbs: 0, maxRel: 0 }) {
  if (typeof a === "number" && typeof b === "number") {
    if (Object.is(a, b)) result.exact += 1;
    else {
      const abs = Math.abs(a - b), rel = abs / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
      result.mismatches.push({ path: location, python: a, javascript: b, abs, rel });
      if (Number.isFinite(abs)) result.maxAbs = Math.max(result.maxAbs, abs);
      if (Number.isFinite(rel)) result.maxRel = Math.max(result.maxRel, rel);
    }
    return result;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { if (a === b) result.exact += 1; else result.mismatches.push({ path: location, python: a, javascript: b }); return result; }
  if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== b.length)) { result.mismatches.push({ path: location, python: a, javascript: b }); return result; }
  const keys = Array.isArray(a) ? a.map((_, i) => i) : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) compareValues(a[key], b[key], `${location}.${key}`, result);
  return result;
}

function main() {
  const args = { output: path.join(__dirname, "javascript-output.json"), compare: null, timingsOutput: null, allPairs: process.argv.includes("--all-pairs"), pairLimit: 4 };
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--output") args.output = path.resolve(process.argv[++i]);
    if (process.argv[i] === "--compare") args.compare = path.resolve(process.argv[++i]);
    if (process.argv[i] === "--timings-output") args.timingsOutput = path.resolve(process.argv[++i]);
    if (process.argv[i] === "--pair-limit") args.pairLimit = Number(process.argv[++i]);
  }
  const generated = outputFor(args);
  const output = generated.output;
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2) + "\n");
  if (args.timingsOutput) fs.writeFileSync(args.timingsOutput, JSON.stringify(generated.timing, null, 2) + "\n");
  console.log(`Timing (ms): ${JSON.stringify(generated.timing)}`);
  console.log(`Wrote ${args.output} (${output.files.length} files, ${output.pairs.length} pairs)`);
  if (args.compare) {
    const pythonOutput = JSON.parse(fs.readFileSync(args.compare, "utf8"));
    const comparison = compareValues(pythonOutput, output);
    console.log(JSON.stringify({ exact_values: comparison.exact, mismatches: comparison.mismatches.length, max_abs_difference: comparison.maxAbs, max_relative_difference: comparison.maxRel, first_mismatches: comparison.mismatches.slice(0, 20) }, null, 2));
    process.exitCode = comparison.mismatches.length ? 2 : 0;
  }
}

if (require.main === module) main();

module.exports = {
  loadAudio,
  discoverFiles,
  itemFromPath,
};
