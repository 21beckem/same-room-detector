// Standalone AssemblyScript numerical core for same-room scoring.
//
// The public boundary intentionally accepts 16 kHz mono Float64Array buffers.
// WAV decoding and source-rate resampling remain outside this first core so the
// exact browser input contract can be tested independently. The browser layer
// will pass explicitly resampled buffers rather than relying on AudioContext's
// implicit sample-rate conversion.

const SR: f64 = 16000.0;
const N_FFT: i32 = 1024;
const HOP: i32 = 320;
const FRAME_RATE: f64 = 50.0;
const N_MELS: i32 = 40;
const FMIN: f64 = 50.0;
const FMAX: f64 = 7500.0;
const MAX_SEC: i32 = 20;
const LN10: f64 = 2.302585092994046;

let modelMean = new Float64Array(3);
let modelStd = new Float64Array(3);
let modelCoef = new Float64Array(3);
let modelIntercept: f64 = 0.0;
let modelWindowSec: f64 = 12.0;
let modelHopSec: f64 = 2.0;
let modelMaxLag: f64 = 1.5;
let modelMinSec: f64 = 8.0;

let resultScore: f64 = 0.0;
let resultLabel: i32 = 0; // 0 unrelated, 1 middle, 2 close
let resultWindowCount: i32 = 0;
let resultWindowScores = new Float64Array(8);
let resultFeatures = new Float64Array(3);
let resultLags = new Float64Array(3);
let resultLevel: f64 = 0.0;
let resultActivity: f64 = 0.0;
let resultSeconds: f64 = 0.0;
let resultQualityFlags: i32 = 0;

class ComplexResult {
  re: Float64Array;
  im: Float64Array;
  constructor(re: Float64Array, im: Float64Array) { this.re = re; this.im = im; }
}

class Spectrum {
  re: Float64Array;
  im: Float64Array;
  n: i32;
  constructor(re: Float64Array, im: Float64Array, n: i32) { this.re = re; this.im = im; this.n = n; }
}

class Clip {
  x: Float64Array;
  mel: Array<Float64Array>;
  flux: Float64Array;
  rms: f64;
  activity: f64;
  constructor(x: Float64Array, mel: Array<Float64Array>, flux: Float64Array, rms: f64, activity: f64) {
    this.x = x; this.mel = mel; this.flux = flux; this.rms = rms; this.activity = activity;
  }
}

class Segment {
  x: Float64Array;
  mel: Array<Float64Array>;
  flux: Float64Array;
  constructor(x: Float64Array, mel: Array<Float64Array>, flux: Float64Array) { this.x = x; this.mel = mel; this.flux = flux; }
}

class Features {
  gccPeak: f64 = 0.0;
  gccLag: f64 = 0.0;
  melPeak: f64 = 0.0;
  melLag: f64 = 0.0;
  fluxPeak: f64 = 0.0;
  fluxLag: f64 = 0.0;
}

let filterbank = makeFilterbank();

function makeFilterbank(): Array<Float64Array> {
  let edges = new Float64Array(N_MELS + 2);
  let loMel = 2595.0 * Math.log(1.0 + FMIN / 700.0) / LN10;
  let hiMel = 2595.0 * Math.log(1.0 + FMAX / 700.0) / LN10;
  for (let i: i32 = 0; i < N_MELS + 2; i++) {
    let mel = loMel + (hiMel - loMel) * <f64>i / <f64>(N_MELS + 1);
    edges[i] = 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
  }
  let result = new Array<Float64Array>();
  for (let band: i32 = 0; band < N_MELS; band++) {
    let row = new Float64Array(N_FFT / 2 + 1);
    let low = edges[band], center = edges[band + 1], high = edges[band + 2];
    let total: f64 = 0.0;
    for (let bin: i32 = 0; bin <= N_FFT / 2; bin++) {
      let hz = <f64>bin * SR / <f64>N_FFT;
      let value = Math.max(0.0, Math.min((hz - low) / (center - low), (high - hz) / (high - center)));
      row[bin] = value;
      total += value;
    }
    if (total == 0.0) {
      let best = 0;
      let bestDistance = Infinity;
      for (let bin: i32 = 0; bin <= N_FFT / 2; bin++) {
        let hz = <f64>bin * SR / <f64>N_FFT;
        let distance = Math.abs(hz - center);
        if (distance < bestDistance) { best = bin; bestDistance = distance; }
      }
      row[best] = 1.0;
      total = 1.0;
    }
    for (let bin: i32 = 0; bin <= N_FFT / 2; bin++) row[bin] /= total;
    result.push(row);
  }
  return result;
}

function nextFastLen(target: i32): i32 {
  let n: i32 = 1;
  while (n < target) n <<= 1;
  return n;
}

function fftComplex(inputRe: Float64Array, inputIm: Float64Array, inverse: bool): ComplexResult {
  let n = inputRe.length;
  let outRe = inputRe.slice(0), outIm = inputIm.slice(0);
  let j: i32 = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while ((j & bit) != 0) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) { let tr = outRe[i]; outRe[i] = outRe[j]; outRe[j] = tr; let ti = outIm[i]; outIm[i] = outIm[j]; outIm[j] = ti; }
  }
  let sign: f64 = inverse ? 1.0 : -1.0;
  let length: i32 = 2;
  while (length <= n) {
    let angle = sign * 2.0 * Math.PI / <f64>length;
    let wLenRe = Math.cos(angle), wLenIm = Math.sin(angle), half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let wRe: f64 = 1.0, wIm: f64 = 0.0;
      for (let i = 0; i < half; i++) {
        let even = start + i, odd = even + half;
        let oddRe = outRe[odd] * wRe - outIm[odd] * wIm;
        let oddIm = outRe[odd] * wIm + outIm[odd] * wRe;
        let evenRe = outRe[even], evenIm = outIm[even];
        outRe[even] = evenRe + oddRe; outIm[even] = evenIm + oddIm;
        outRe[odd] = evenRe - oddRe; outIm[odd] = evenIm - oddIm;
        let nextRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe; wRe = nextRe;
      }
    }
    length <<= 1;
  }
  return new ComplexResult(outRe, outIm);
}

function rfft(input: Float64Array, n: i32): Spectrum {
  let re = new Float64Array(n), im = new Float64Array(n);
  let count = Math.min(input.length, n);
  for (let i = 0; i < count; i++) re[i] = input[i];
  let result = fftComplex(re, im, false);
  return new Spectrum(result.re.slice(0, n / 2 + 1), result.im.slice(0, n / 2 + 1), n);
}

function irfft(spec: Spectrum): Float64Array {
  let re = new Float64Array(spec.n), im = new Float64Array(spec.n);
  for (let i = 0; i <= spec.n / 2; i++) { re[i] = spec.re[i]; im[i] = spec.im[i]; }
  for (let i = 1; i < spec.n / 2; i++) { re[spec.n - i] = spec.re[i]; im[spec.n - i] = -spec.im[i]; }
  let result = fftComplex(re, im, true).re;
  for (let i = 0; i < spec.n; i++) result[i] /= <f64>spec.n;
  return result;
}

function logMel(x: Float64Array): Array<Float64Array> {
  let frames: i32 = x.length < N_FFT ? 0 : <i32>(1 + (x.length - N_FFT) / HOP);
  let result = new Array<Float64Array>();
  for (let band = 0; band < N_MELS; band++) result.push(new Float64Array(frames));
  let hann = new Float64Array(N_FFT);
  let scale: f64 = 0.0;
  for (let i = 0; i < N_FFT; i++) { hann[i] = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * <f64>i / <f64>N_FFT); scale += hann[i]; }
  scale *= scale;
  for (let frame = 0; frame < frames; frame++) {
    let block = new Float64Array(N_FFT);
    let start = frame * HOP;
    for (let i = 0; i < N_FFT; i++) block[i] = x[start + i] * hann[i];
    let spec = rfft(block, N_FFT);
    for (let band = 0; band < N_MELS; band++) {
      let power: f64 = 0.0;
      for (let bin = 0; bin <= N_FFT / 2; bin++) power += filterbank[band][bin] * (spec.re[bin] * spec.re[bin] + spec.im[bin] * spec.im[bin]) / scale;
      result[band][frame] = 10.0 * Math.log(power + 1e-12) / LN10;
    }
  }
  return result;
}

function onsetFlux(mel: Array<Float64Array>): Float64Array {
  let bands = mel.length, frames = mel[0].length;
  let raw = new Float64Array(frames);
  for (let band = 0; band < bands; band++) for (let frame = 1; frame < frames; frame++) raw[frame] += Math.max(mel[band][frame] - mel[band][frame - 1], 0.0);
  let result = new Float64Array(frames);
  for (let i = 0; i < frames; i++) result[i] = (raw[<i32>Math.max(0, i - 1)] + raw[i] + raw[<i32>Math.min(frames - 1, i + 1)]) / 3.0;
  return result;
}

function makeClip(x: Float64Array): Clip {
  let mel = logMel(x), flux = onsetFlux(mel), energy: f64 = 0.0;
  for (let i = 0; i < x.length; i++) energy += x[i] * x[i];
  let rms = 20.0 * Math.log(Math.sqrt(energy / <f64>x.length) + 1e-12) / LN10;
  let frames = mel[0].length, mean: f64 = 0.0;
  let frameMeans = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) { for (let band = 0; band < N_MELS; band++) frameMeans[frame] += mel[band][frame]; frameMeans[frame] /= <f64>N_MELS; mean += frameMeans[frame]; }
  mean /= <f64>frames;
  let variance: f64 = 0.0;
  for (let frame = 0; frame < frames; frame++) variance += (frameMeans[frame] - mean) * (frameMeans[frame] - mean);
  return new Clip(x, mel, flux, rms, Math.sqrt(variance / <f64>frames));
}

function segment(clip: Clip, start: i32, length: i32): Segment {
  let f0 = start / HOP, nf = 1 + (length - N_FFT) / HOP;
  let x = clip.x.slice(start, start + length), mel = new Array<Float64Array>();
  for (let band = 0; band < N_MELS; band++) mel.push(clip.mel[band].slice(f0, f0 + nf));
  return new Segment(x, mel, clip.flux.slice(f0, f0 + nf));
}

function zscoreRow(row: Float64Array): Float64Array {
  let mean: f64 = 0.0;
  for (let i = 0; i < row.length; i++) mean += row[i];
  mean /= <f64>row.length;
  let variance: f64 = 0.0;
  for (let i = 0; i < row.length; i++) variance += (row[i] - mean) * (row[i] - mean);
  let sd = Math.max(Math.sqrt(variance / <f64>row.length), 1e-6);
  let result = new Float64Array(row.length);
  for (let i = 0; i < row.length; i++) result[i] = (row[i] - mean) / sd;
  return result;
}

class Correlation { lags: Float64Array; cc: Float64Array; constructor(lags: Float64Array, cc: Float64Array) { this.lags = lags; this.cc = cc; } }

function xcorrUnbiased(a: Array<Float64Array>, b: Array<Float64Array>): Correlation {
  let t = a[0].length, nfft = nextFastLen(2 * t - 1), circular = new Float64Array(nfft);
  for (let row = 0; row < a.length; row++) {
    let aa = rfft(a[row], nfft), bb = rfft(b[row], nfft), re = new Float64Array(aa.re.length), im = new Float64Array(aa.re.length);
    for (let i = 0; i < re.length; i++) { re[i] = aa.re[i] * bb.re[i] + aa.im[i] * bb.im[i]; im[i] = aa.im[i] * bb.re[i] - aa.re[i] * bb.im[i]; }
    let corr = irfft(new Spectrum(re, im, nfft));
    for (let i = 0; i < nfft; i++) circular[i] += corr[i] / <f64>a.length;
  }
  let lags = new Float64Array(2 * t - 1), cc = new Float64Array(2 * t - 1);
  for (let i = 0; i < 2 * t - 1; i++) { let lag = i - (t - 1); lags[i] = <f64>lag / FRAME_RATE; cc[i] = (i < t - 1 ? circular[nfft - (t - 1) + i] : circular[i - (t - 1)]) / <f64>(t - Math.abs(lag)); }
  return new Correlation(lags, cc);
}

function gccPhat(xa: Float64Array, xb: Float64Array): Correlation {
  let n: i32 = <i32>Math.min(xa.length, xb.length), nfft = nextFastLen(2 * n - 1), a = rfft(xa.slice(0, n), nfft), b = rfft(xb.slice(0, n), nfft), bandCount = 0;
  for (let i = 0; i < a.re.length; i++) {
    let frequency = <f64>i * SR / <f64>nfft, allowed = frequency >= 100.0 && frequency <= 4000.0;
    if (allowed) bandCount++;
    let real = a.re[i] * b.re[i] + a.im[i] * b.im[i], imag = a.im[i] * b.re[i] - a.re[i] * b.im[i], magnitude = Math.sqrt(real * real + imag * imag);
    a.re[i] = allowed ? real / (magnitude + 1e-12) : 0.0;
    a.im[i] = allowed ? imag / (magnitude + 1e-12) : 0.0;
  }
  let raw = irfft(new Spectrum(a.re, a.im, nfft)), scale = 2.0 * <f64>bandCount / <f64>nfft, lags = new Float64Array(2 * n - 1), cc = new Float64Array(2 * n - 1);
  for (let i = 0; i < 2 * n - 1; i++) { let lag = i - (n - 1); lags[i] = <f64>lag / SR; cc[i] = (i < n - 1 ? raw[nfft - (n - 1) + i] : raw[i - (n - 1)]) / scale; }
  return new Correlation(lags, cc);
}

function peak(correlation: Correlation, maxLag: f64): Float64Array {
  let value: f64 = -Infinity, lag: f64 = 0.0;
  for (let i = 0; i < correlation.lags.length; i++) if (Math.abs(correlation.lags[i]) <= maxLag + 1e-9 && correlation.cc[i] > value) { value = correlation.cc[i]; lag = correlation.lags[i]; }
  let result = new Float64Array(2); result[0] = value; result[1] = lag; return result;
}

function windowFeatures(a: Segment, b: Segment): Features {
  let result = new Features(), n: i32 = <i32>Math.min(a.x.length, b.x.length), t: i32 = <i32>Math.min(a.mel[0].length, b.mel[0].length);
  let gcc = peak(gccPhat(a.x.slice(0, n), b.x.slice(0, n)), modelMaxLag); result.gccPeak = gcc[0]; result.gccLag = gcc[1];
  let ma = new Array<Float64Array>(), mb = new Array<Float64Array>();
  for (let band = 0; band < N_MELS; band++) { ma.push(zscoreRow(a.mel[band].slice(0, t))); mb.push(zscoreRow(b.mel[band].slice(0, t))); }
  let mel = peak(xcorrUnbiased(ma, mb), modelMaxLag); result.melPeak = mel[0]; result.melLag = mel[1];
  let fluxA = new Array<Float64Array>(), fluxB = new Array<Float64Array>(); fluxA.push(zscoreRow(a.flux.slice(0, t))); fluxB.push(zscoreRow(b.flux.slice(0, t)));
  let flux = peak(xcorrUnbiased(fluxA, fluxB), modelMaxLag); result.fluxPeak = flux[0]; result.fluxLag = flux[1];
  return result;
}

function featureVector(f: Features): Float64Array {
  let result = new Float64Array(3); result[0] = Math.log(Math.max(f.gccPeak, 1e-3)) / LN10; result[1] = f.melPeak; result[2] = f.fluxPeak; return result;
}

function expit(z: f64): f64 { return 1.0 / (1.0 + Math.exp(-z)); }

function median(values: Float64Array): f64 {
  let sorted = values.slice(0); sorted.sort(); let mid = sorted.length / 2;
  return sorted.length % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
}

export const FLOAT64ARRAY_ID: usize = idof<Float64Array>();

export function configure(intercept: f64, mean0: f64, mean1: f64, mean2: f64, std0: f64, std1: f64, std2: f64, coef0: f64, coef1: f64, coef2: f64, windowSec: f64, hopSec: f64, maxLag: f64, minSec: f64): void {
  modelIntercept = intercept; modelMean[0] = mean0; modelMean[1] = mean1; modelMean[2] = mean2; modelStd[0] = std0; modelStd[1] = std1; modelStd[2] = std2; modelCoef[0] = coef0; modelCoef[1] = coef1; modelCoef[2] = coef2; modelWindowSec = windowSec; modelHopSec = hopSec; modelMaxLag = maxLag; modelMinSec = minSec;
}

export function scoreAudio(a: Float64Array, b: Float64Array): f64 {
  let ca = makeClip(a), cb = makeClip(b), n: i32 = <i32>Math.min(a.length, b.length);
  resultSeconds = <f64>n / SR; resultLevel = Math.min(ca.rms, cb.rms); resultActivity = Math.min(ca.activity, cb.activity); resultQualityFlags = 0;
  if (n < modelMinSec * SR) return -1.0;
  if (resultLevel < -60.0) resultQualityFlags |= 1;
  if (resultActivity < 1.0) resultQualityFlags |= 2;
  let win: i32 = <i32>Math.round(modelWindowSec * FRAME_RATE) * HOP, hop: i32 = <i32>Math.round(modelHopSec * FRAME_RATE) * HOP;
  let starts = new Array<i32>();
  if (n < win) starts.push(0); else { let last: i32 = <i32>(((n - win) / HOP) * HOP); for (let start = 0; start <= last; start += hop) starts.push(start); if (last - starts[starts.length - 1] > hop / 2) starts.push(last); }
  resultWindowCount = starts.length;
  let logits = new Float64Array(starts.length), gcc = new Float64Array(starts.length), mel = new Float64Array(starts.length), flux = new Float64Array(starts.length), gccLag = new Float64Array(starts.length), melLag = new Float64Array(starts.length), fluxLag = new Float64Array(starts.length);
  for (let i = 0; i < starts.length; i++) {
    let length: i32 = n < win ? n : win, f = windowFeatures(segment(ca, starts[i], length), segment(cb, starts[i], length));
    gcc[i] = f.gccPeak; mel[i] = f.melPeak; flux[i] = f.fluxPeak; gccLag[i] = f.gccLag; melLag[i] = f.melLag; fluxLag[i] = f.fluxLag;
    let v = featureVector(f), z = modelIntercept;
    for (let j = 0; j < 3; j++) z += ((v[j] - modelMean[j]) / modelStd[j]) * modelCoef[j];
    logits[i] = z; resultWindowScores[i] = expit(z);
  }
  let meanLogit: f64 = 0.0;
  for (let i = 0; i < starts.length; i++) meanLogit += logits[i];
  resultScore = expit(meanLogit / <f64>starts.length);
  resultLabel = resultScore >= 0.75 ? 2 : resultScore >= 0.25 ? 1 : 0;
  resultFeatures[0] = median(gcc); resultFeatures[1] = median(mel); resultFeatures[2] = median(flux);
  resultLags[0] = median(gccLag); resultLags[1] = median(melLag); resultLags[2] = median(fluxLag);
  if (n < modelWindowSec * SR) resultQualityFlags |= 4;
  let minScore = resultWindowScores[0], maxScore = resultWindowScores[0];
  for (let i = 1; i < starts.length; i++) { minScore = Math.min(minScore, resultWindowScores[i]); maxScore = Math.max(maxScore, resultWindowScores[i]); }
  if (starts.length > 1 && maxScore - minScore > 0.5) resultQualityFlags |= 8;
  return resultScore;
}

export function getScore(): f64 { return resultScore; }
export function getLabel(): i32 { return resultLabel; }
export function getWindowCount(): i32 { return resultWindowCount; }
export function getWindowScore(i: i32): f64 { return resultWindowScores[i]; }
export function getFeature(i: i32): f64 { return resultFeatures[i]; }
export function getLag(i: i32): f64 { return resultLags[i]; }
export function getLevel(): f64 { return resultLevel; }
export function getActivity(): f64 { return resultActivity; }
export function getSeconds(): f64 { return resultSeconds; }
export function getQualityFlags(): i32 { return resultQualityFlags; }
