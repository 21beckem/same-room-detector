// Same-room WASM core. The public API is split into:
//   prepareDevice/loadDevicePacket: audio -> compact, globally anchored mel packet
//   compareDevices: two packets -> score and diagnostics
// compareDevices never accepts raw audio. Flux is derived from each packet's
// mel data once and reused for every comparison involving that packet.

const SR: f64 = 16000.0;
const N_FFT: i32 = 1024;
const HOP: i32 = 320;
const FRAME_RATE: f64 = 50.0;
const N_MELS: i32 = 40;
const FMIN: f64 = 50.0;
const FMAX: f64 = 7500.0;
const LN10: f64 = 2.302585092994046;
const PACKET_MAGIC: i32 = 0x53524D31; // SRM1
const PACKET_VERSION: i32 = 1;
const PACKET_HEADER_BYTES: i32 = 48 + N_MELS * 16;

let modelMean = new Float64Array(2), modelStd = new Float64Array(2), modelCoef = new Float64Array(2);
let modelIntercept: f64 = 0.0, modelWindowSec: f64 = 5.0, modelHopSec: f64 = 2.0, modelMaxLag: f64 = 1.0, modelMinSec: f64 = 5.0;
let resultScore: f64 = 0.0, resultLabel: i32 = 0, resultWindowCount: i32 = 0;
let resultWindowScores = new Float64Array(16), resultFeatures = new Float64Array(2), resultLags = new Float64Array(2);
let resultLevel: f64 = 0.0, resultActivity: f64 = 0.0, resultSeconds: f64 = 0.0, resultQualityFlags: i32 = 0;

class ComplexResult { re: Float64Array; im: Float64Array; constructor(re: Float64Array, im: Float64Array) { this.re = re; this.im = im; } }
class Spectrum { re: Float64Array; im: Float64Array; n: i32; constructor(re: Float64Array, im: Float64Array, n: i32) { this.re = re; this.im = im; this.n = n; } }
class Correlation { lags: Float64Array; cc: Float64Array; constructor(lags: Float64Array, cc: Float64Array) { this.lags = lags; this.cc = cc; } }

class DevicePacket {
  audioStartSample: i32; sampleCount: i32; firstFrameSample: i32; frameCount: i32;
  rms: f64; activity: f64; quantized: bool; bits: i32;
  melOffset: Float64Array; melScale: Float64Array; melCodes: Uint8Array; melRaw: Float64Array; flux: Float64Array; serialized: Uint8Array;
  constructor(audioStartSample: i32, sampleCount: i32, firstFrameSample: i32, frameCount: i32, rms: f64, activity: f64, quantized: bool, bits: i32, melOffset: Float64Array, melScale: Float64Array, melCodes: Uint8Array, melRaw: Float64Array, flux: Float64Array) {
    this.audioStartSample = audioStartSample; this.sampleCount = sampleCount; this.firstFrameSample = firstFrameSample; this.frameCount = frameCount;
    this.rms = rms; this.activity = activity; this.quantized = quantized; this.bits = bits;
    this.melOffset = melOffset; this.melScale = melScale; this.melCodes = melCodes; this.melRaw = melRaw; this.flux = flux; this.serialized = new Uint8Array(0);
  }
}

let packets = new Array<DevicePacket>();
let filterbank = makeFilterbank();

function makeFilterbank(): Array<Float64Array> {
  let edges = new Float64Array(N_MELS + 2), loMel = 2595.0 * Math.log(1.0 + FMIN / 700.0) / LN10, hiMel = 2595.0 * Math.log(1.0 + FMAX / 700.0) / LN10;
  for (let i = 0; i < N_MELS + 2; i++) { let mel = loMel + (hiMel - loMel) * <f64>i / <f64>(N_MELS + 1); edges[i] = 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0); }
  let result = new Array<Float64Array>();
  for (let band = 0; band < N_MELS; band++) {
    let row = new Float64Array(N_FFT / 2 + 1), low = edges[band], center = edges[band + 1], high = edges[band + 2], total: f64 = 0.0;
    for (let bin = 0; bin <= N_FFT / 2; bin++) { let hz = <f64>bin * SR / <f64>N_FFT; let value = Math.max(0.0, Math.min((hz - low) / (center - low), (high - hz) / (high - center))); row[bin] = value; total += value; }
    if (total == 0.0) { let best = 0, bestDistance = Infinity; for (let bin = 0; bin <= N_FFT / 2; bin++) { let hz = <f64>bin * SR / <f64>N_FFT, distance = Math.abs(hz - center); if (distance < bestDistance) { best = bin; bestDistance = distance; } } row[best] = 1.0; total = 1.0; }
    for (let bin = 0; bin <= N_FFT / 2; bin++) row[bin] /= total;
    result.push(row);
  }
  return result;
}

function nextFastLen(target: i32): i32 { let n: i32 = 1; while (n < target) n <<= 1; return n; }

function fftComplex(inputRe: Float64Array, inputIm: Float64Array, inverse: bool): ComplexResult {
  let n = inputRe.length, outRe = inputRe.slice(0), outIm = inputIm.slice(0), j: i32 = 0;
  for (let i = 1; i < n; i++) { let bit = n >> 1; while ((j & bit) != 0) { j ^= bit; bit >>= 1; } j ^= bit; if (i < j) { let tr = outRe[i]; outRe[i] = outRe[j]; outRe[j] = tr; let ti = outIm[i]; outIm[i] = outIm[j]; outIm[j] = ti; } }
  let sign: f64 = inverse ? 1.0 : -1.0, length: i32 = 2;
  while (length <= n) { let angle = sign * 2.0 * Math.PI / <f64>length, wLenRe = Math.cos(angle), wLenIm = Math.sin(angle), half = length >> 1;
    for (let start = 0; start < n; start += length) { let wRe: f64 = 1.0, wIm: f64 = 0.0;
      for (let i = 0; i < half; i++) { let even = start + i, odd = even + half, oddRe = outRe[odd] * wRe - outIm[odd] * wIm, oddIm = outRe[odd] * wIm + outIm[odd] * wRe, evenRe = outRe[even], evenIm = outIm[even]; outRe[even] = evenRe + oddRe; outIm[even] = evenIm + oddIm; outRe[odd] = evenRe - oddRe; outIm[odd] = evenIm - oddIm; let nextRe = wRe * wLenRe - wIm * wLenIm; wIm = wRe * wLenIm + wIm * wLenRe; wRe = nextRe; }
    } length <<= 1;
  }
  return new ComplexResult(outRe, outIm);
}

function rfft(input: Float64Array, n: i32): Spectrum { let re = new Float64Array(n), im = new Float64Array(n), count = Math.min(input.length, n); for (let i = 0; i < count; i++) re[i] = input[i]; let result = fftComplex(re, im, false); return new Spectrum(result.re.slice(0, n / 2 + 1), result.im.slice(0, n / 2 + 1), n); }
function irfft(spec: Spectrum): Float64Array { let re = new Float64Array(spec.n), im = new Float64Array(spec.n); for (let i = 0; i <= spec.n / 2; i++) { re[i] = spec.re[i]; im[i] = spec.im[i]; } for (let i = 1; i < spec.n / 2; i++) { re[spec.n - i] = spec.re[i]; im[spec.n - i] = -spec.im[i]; } let result = fftComplex(re, im, true).re; for (let i = 0; i < spec.n; i++) result[i] /= <f64>spec.n; return result; }

function logMelFrame(x: Float64Array, start: i32): Float64Array {
  let hann = new Float64Array(N_FFT), block = new Float64Array(N_FFT), scale: f64 = 0.0;
  for (let i = 0; i < N_FFT; i++) { hann[i] = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * <f64>i / <f64>N_FFT); scale += hann[i]; block[i] = x[start + i] * hann[i]; }
  scale *= scale; let spec = rfft(block, N_FFT), result = new Float64Array(N_MELS);
  for (let band = 0; band < N_MELS; band++) { let power: f64 = 0.0; for (let bin = 0; bin <= N_FFT / 2; bin++) power += filterbank[band][bin] * (spec.re[bin] * spec.re[bin] + spec.im[bin] * spec.im[bin]) / scale; result[band] = 10.0 * Math.log(power + 1e-12) / LN10; }
  return result;
}

function onsetFluxFromMel(mel: Float64Array, frames: i32): Float64Array {
  let raw = new Float64Array(frames), result = new Float64Array(frames);
  for (let band = 0; band < N_MELS; band++) { let base = band * frames; for (let frame = 1; frame < frames; frame++) raw[frame] += Math.max(mel[base + frame] - mel[base + frame - 1], 0.0); }
  for (let i = 0; i < frames; i++) result[i] = (raw[<i32>Math.max(0, i - 1)] + raw[i] + raw[<i32>Math.min(frames - 1, i + 1)]) / 3.0;
  return result;
}

function packetMel(packet: DevicePacket, band: i32, frame: i32): f64 { let index = band * packet.frameCount + frame; if (!packet.quantized) return packet.melRaw[index]; let levels = <f64>((1 << packet.bits) - 1); return packet.melOffset[band] + packet.melScale[band] * <f64>packet.melCodes[index] / levels; }
function packetByteLength(packet: DevicePacket): i32 { return PACKET_HEADER_BYTES + (packet.quantized ? N_MELS * packet.frameCount : N_MELS * packet.frameCount * 8); }
function writeI32(view: DataView, offset: i32, value: i32): void { view.setInt32(offset, value, true); }
function writeF64(view: DataView, offset: i32, value: f64): void { view.setFloat64(offset, value, true); }

function serializePacket(packet: DevicePacket): Uint8Array {
  let bytes = new Uint8Array(packetByteLength(packet)), view = new DataView(bytes.buffer); writeI32(view, 0, PACKET_MAGIC); writeI32(view, 4, PACKET_VERSION); writeI32(view, 8, packet.quantized ? 1 : 0); writeI32(view, 12, packet.bits); writeI32(view, 16, packet.audioStartSample); writeI32(view, 20, packet.sampleCount); writeI32(view, 24, packet.firstFrameSample); writeI32(view, 28, packet.frameCount); writeF64(view, 32, packet.rms); writeF64(view, 40, packet.activity);
  let offset = 48; for (let band = 0; band < N_MELS; band++) { writeF64(view, offset, packet.melOffset[band]); offset += 8; } for (let band = 0; band < N_MELS; band++) { writeF64(view, offset, packet.melScale[band]); offset += 8; }
  if (packet.quantized) for (let i = 0; i < packet.melCodes.length; i++) bytes[offset + i] = packet.melCodes[i]; else for (let i = 0; i < packet.melRaw.length; i++) writeF64(view, offset + i * 8, packet.melRaw[i]);
  return bytes;
}

function makePacket(audioStartSample: i32, x: Float64Array, firstFrameSample: i32, frameCount: i32, mel: Float64Array, bits: i32, quantize: bool): DevicePacket {
  let offsets = new Float64Array(N_MELS), scales = new Float64Array(N_MELS), energy: f64 = 0.0; for (let i = 0; i < x.length; i++) energy += x[i] * x[i];
  let rms = x.length ? 20.0 * Math.log(Math.sqrt(energy / <f64>x.length) + 1e-12) / LN10 : -Infinity, frameMeans = new Float64Array(frameCount), mean: f64 = 0.0;
  for (let frame = 0; frame < frameCount; frame++) { for (let band = 0; band < N_MELS; band++) frameMeans[frame] += mel[band * frameCount + frame]; frameMeans[frame] /= <f64>N_MELS; mean += frameMeans[frame]; }
  if (frameCount > 0) mean /= <f64>frameCount; let variance: f64 = 0.0; for (let frame = 0; frame < frameCount; frame++) variance += (frameMeans[frame] - mean) * (frameMeans[frame] - mean); let activity = frameCount > 0 ? Math.sqrt(variance / <f64>frameCount) : 0.0;
  let useQuant = quantize && bits >= 1 && bits <= 8, codes = new Uint8Array(0), raw = new Float64Array(0);
  if (useQuant) { codes = new Uint8Array(N_MELS * frameCount); let levels = <f64>((1 << bits) - 1); for (let band = 0; band < N_MELS; band++) { let lo: f64 = Infinity, hi: f64 = -Infinity; for (let frame = 0; frame < frameCount; frame++) { let v = mel[band * frameCount + frame]; lo = Math.min(lo, v); hi = Math.max(hi, v); } offsets[band] = lo; scales[band] = hi > lo ? hi - lo : 1.0; for (let frame = 0; frame < frameCount; frame++) { let q = <i32>Math.round((mel[band * frameCount + frame] - lo) / scales[band] * levels); codes[band * frameCount + frame] = <u8>Math.max(0, Math.min(<i32>levels, q)); } } }
  else { raw = mel.slice(0); for (let band = 0; band < N_MELS; band++) { offsets[band] = 0.0; scales[band] = 1.0; } }
  let packet = new DevicePacket(audioStartSample, x.length, firstFrameSample, frameCount, rms, activity, useQuant, useQuant ? bits : 0, offsets, scales, codes, raw, onsetFluxFromMel(mel, frameCount)); packet.serialized = serializePacket(packet); return packet;
}

function makePacketFromMel(audioStartSample: i32, sampleCount: i32, firstFrameSample: i32, mel: Float64Array, frameCount: i32, rms: f64, activity: f64, bits: i32, quantize: bool): DevicePacket {
  let packet = makePacket(audioStartSample, new Float64Array(0), firstFrameSample, frameCount, mel, bits, quantize); packet.sampleCount = sampleCount; packet.rms = rms; packet.activity = activity; packet.serialized = serializePacket(packet); return packet;
}

function parsePacket(bytes: Uint8Array): DevicePacket {
  let view = new DataView(bytes.buffer); if (bytes.length < PACKET_HEADER_BYTES || view.getInt32(0, true) != PACKET_MAGIC || view.getInt32(4, true) != PACKET_VERSION) return new DevicePacket(0, 0, 0, 0, 0.0, 0.0, false, 0, new Float64Array(N_MELS), new Float64Array(N_MELS), new Uint8Array(0), new Float64Array(0), new Float64Array(0));
  let quantized = view.getInt32(8, true) != 0, bits = view.getInt32(12, true), audioStart = view.getInt32(16, true), sampleCount = view.getInt32(20, true), firstFrame = view.getInt32(24, true), frameCount = view.getInt32(28, true), rms = view.getFloat64(32, true), activity = view.getFloat64(40, true), offsets = new Float64Array(N_MELS), scales = new Float64Array(N_MELS); let offset = 48;
  for (let band = 0; band < N_MELS; band++) { offsets[band] = view.getFloat64(offset, true); offset += 8; } for (let band = 0; band < N_MELS; band++) { scales[band] = view.getFloat64(offset, true); offset += 8; }
  let count = N_MELS * frameCount, codes = new Uint8Array(0), raw = new Float64Array(0), mel = new Float64Array(count);
  if (quantized) { codes = bytes.slice(offset, offset + count); let levels = <f64>((1 << bits) - 1); for (let band = 0; band < N_MELS; band++) for (let frame = 0; frame < frameCount; frame++) { let i = band * frameCount + frame; mel[i] = offsets[band] + scales[band] * <f64>codes[i] / levels; } }
  else { raw = new Float64Array(count); for (let i = 0; i < count; i++) { raw[i] = view.getFloat64(offset + i * 8, true); mel[i] = raw[i]; } }
  let packet = new DevicePacket(audioStart, sampleCount, firstFrame, frameCount, rms, activity, quantized, bits, offsets, scales, codes, raw, onsetFluxFromMel(mel, frameCount)); packet.serialized = bytes.slice(0); return packet;
}

function zscore(values: Float64Array): Float64Array { let mean: f64 = 0.0; for (let i = 0; i < values.length; i++) mean += values[i]; mean /= <f64>values.length; let variance: f64 = 0.0; for (let i = 0; i < values.length; i++) variance += (values[i] - mean) * (values[i] - mean); let sd = Math.max(Math.sqrt(variance / <f64>values.length), 1e-6), result = new Float64Array(values.length); for (let i = 0; i < values.length; i++) result[i] = (values[i] - mean) / sd; return result; }

// The inverse FFT is linear: sum the 40 cross-spectra, then invert once.
function xcorrMel(a: DevicePacket, b: DevicePacket, a0: i32, b0: i32, t: i32): Correlation {
  let nfft = nextFastLen(2 * t - 1), reSum = new Float64Array(nfft / 2 + 1), imSum = new Float64Array(nfft / 2 + 1);
  for (let band = 0; band < N_MELS; band++) { let av = new Float64Array(t), bv = new Float64Array(t); for (let frame = 0; frame < t; frame++) { av[frame] = packetMel(a, band, a0 + frame); bv[frame] = packetMel(b, band, b0 + frame); } let aa = rfft(zscore(av), nfft), bb = rfft(zscore(bv), nfft); for (let i = 0; i < reSum.length; i++) { reSum[i] += (aa.re[i] * bb.re[i] + aa.im[i] * bb.im[i]) / <f64>N_MELS; imSum[i] += (aa.im[i] * bb.re[i] - aa.re[i] * bb.im[i]) / <f64>N_MELS; } }
  return correlationFromCircular(new Spectrum(reSum, imSum, nfft), t);
}
function xcorrFlux(a: DevicePacket, b: DevicePacket, a0: i32, b0: i32, t: i32): Correlation { let av = new Float64Array(t), bv = new Float64Array(t); for (let frame = 0; frame < t; frame++) { av[frame] = a.flux[a0 + frame]; bv[frame] = b.flux[b0 + frame]; } let nfft = nextFastLen(2 * t - 1), aa = rfft(zscore(av), nfft), bb = rfft(zscore(bv), nfft), re = new Float64Array(aa.re.length), im = new Float64Array(aa.re.length); for (let i = 0; i < re.length; i++) { re[i] = aa.re[i] * bb.re[i] + aa.im[i] * bb.im[i]; im[i] = aa.im[i] * bb.re[i] - aa.re[i] * bb.im[i]; } return correlationFromCircular(new Spectrum(re, im, nfft), t); }
function correlationFromCircular(spec: Spectrum, t: i32): Correlation { let circular = irfft(spec), lags = new Float64Array(2 * t - 1), cc = new Float64Array(2 * t - 1); for (let i = 0; i < 2 * t - 1; i++) { let lag = i - (t - 1); lags[i] = <f64>lag / FRAME_RATE; cc[i] = (i < t - 1 ? circular[spec.n - (t - 1) + i] : circular[i - (t - 1)]) / <f64>(t - Math.abs(lag)); } return new Correlation(lags, cc); }
function peak(correlation: Correlation, maxLag: f64): Float64Array { let value: f64 = -Infinity, lag: f64 = 0.0; for (let i = 0; i < correlation.lags.length; i++) if (Math.abs(correlation.lags[i]) <= maxLag + 1e-9 && correlation.cc[i] > value) { value = correlation.cc[i]; lag = correlation.lags[i]; } let result = new Float64Array(2); result[0] = value; result[1] = lag; return result; }
function windowFeatures(a: DevicePacket, b: DevicePacket, a0: i32, b0: i32, t: i32): Float64Array { let mel = peak(xcorrMel(a, b, a0, b0, t), modelMaxLag), flux = peak(xcorrFlux(a, b, a0, b0, t), modelMaxLag), result = new Float64Array(4); result[0] = mel[0]; result[1] = mel[1]; result[2] = flux[0]; result[3] = flux[1]; return result; }
function expit(z: f64): f64 { return 1.0 / (1.0 + Math.exp(-z)); }
function median(values: Float64Array): f64 { let sorted = values.slice(0); sorted.sort(); let mid = sorted.length / 2; return sorted.length % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0; }
function packetFrameIndex(packet: DevicePacket, sample: i32): i32 { return <i32>Math.max(0, Math.min(packet.frameCount, (sample - packet.firstFrameSample) / HOP)); }
function addPacket(packet: DevicePacket): i32 { packets.push(packet); return packets.length - 1; }

export const FLOAT64ARRAY_ID: usize = idof<Float64Array>();
export const UINT8ARRAY_ID: usize = idof<Uint8Array>();
export function configure(intercept: f64, mean0: f64, mean1: f64, std0: f64, std1: f64, coef0: f64, coef1: f64, windowSec: f64, hopSec: f64, maxLag: f64, minSec: f64): void { modelIntercept = intercept; modelMean[0] = mean0; modelMean[1] = mean1; modelStd[0] = std0; modelStd[1] = std1; modelCoef[0] = coef0; modelCoef[1] = coef1; modelWindowSec = windowSec; modelHopSec = hopSec; modelMaxLag = maxLag; modelMinSec = minSec; }

export function prepareDevice(audio: Float64Array, globalStartSample: i32, bitDepth: i32, quantize: bool): i32 {
  let first = <i32>Math.ceil(<f64>globalStartSample / <f64>HOP) * HOP, last = globalStartSample + audio.length - N_FFT, frameCount = last < first ? 0 : 1 + (last - first) / HOP, mel = new Float64Array(N_MELS * frameCount);
  for (let frame = 0; frame < frameCount; frame++) { let values = logMelFrame(audio, first - globalStartSample + frame * HOP); for (let band = 0; band < N_MELS; band++) mel[band * frameCount + frame] = values[band]; }
  return addPacket(makePacket(globalStartSample, audio, first, frameCount, mel, bitDepth, quantize));
}
export function loadDevicePacket(bytes: Uint8Array): i32 { return addPacket(parsePacket(bytes)); }

export function mergeDevices(firstHandle: i32, secondHandle: i32): i32 {
  let a = packets[firstHandle], b = packets[secondHandle]; if (a.frameCount == 0) return secondHandle; if (b.frameCount == 0) return firstHandle;
  let firstFrame = <i32>Math.min(a.firstFrameSample, b.firstFrameSample), endFrame = <i32>Math.max(a.firstFrameSample + (a.frameCount - 1) * HOP, b.firstFrameSample + (b.frameCount - 1) * HOP), frameCount = <i32>(1 + (endFrame - firstFrame) / HOP), mel = new Float64Array(N_MELS * frameCount);
  for (let band = 0; band < N_MELS; band++) for (let frame = 0; frame < a.frameCount; frame++) mel[band * frameCount + <i32>((a.firstFrameSample - firstFrame) / HOP) + frame] = packetMel(a, band, frame);
  for (let band = 0; band < N_MELS; band++) for (let frame = 0; frame < b.frameCount; frame++) mel[band * frameCount + <i32>((b.firstFrameSample - firstFrame) / HOP) + frame] = packetMel(b, band, frame);
  let audioStart = <i32>Math.min(a.audioStartSample, b.audioStartSample), audioEnd = <i32>Math.max(a.audioStartSample + a.sampleCount, b.audioStartSample + b.sampleCount), quantize = a.quantized && b.quantized && a.bits == b.bits;
  return addPacket(makePacketFromMel(audioStart, audioEnd - audioStart, firstFrame, mel, frameCount, Math.min(a.rms, b.rms), Math.min(a.activity, b.activity), quantize ? a.bits : 0, quantize));
}

export function compareDevices(firstHandle: i32, secondHandle: i32): f64 {
  let a = packets[firstHandle], b = packets[secondHandle], n = <i32>Math.min(a.sampleCount, b.sampleCount); resultSeconds = <f64>n / SR; resultLevel = Math.min(a.rms, b.rms); resultActivity = Math.min(a.activity, b.activity); resultQualityFlags = 0; resultWindowCount = 0;
  if (n < modelMinSec * SR) { resultScore = -1.0; return resultScore; } if (resultLevel < -60.0) resultQualityFlags |= 1; if (resultActivity < 1.0) resultQualityFlags |= 2;
  let win: i32 = <i32>Math.round(modelWindowSec * FRAME_RATE) * HOP, hop: i32 = <i32>Math.round(modelHopSec * FRAME_RATE) * HOP, starts = new Array<i32>();
  if (n < win) starts.push(0); else { let last: i32 = <i32>(((n - win) / HOP) * HOP); for (let start = 0; start <= last; start += hop) starts.push(start); if (last - starts[starts.length - 1] > hop / 2) starts.push(last); }
  resultWindowCount = starts.length; let logits = new Float64Array(starts.length), mel = new Float64Array(starts.length), flux = new Float64Array(starts.length), melLag = new Float64Array(starts.length), fluxLag = new Float64Array(starts.length);
  for (let i = 0; i < starts.length; i++) { let length = n < win ? n : win, expected = length < N_FFT ? 0 : 1 + (length - N_FFT) / HOP, a0 = packetFrameIndex(a, starts[i]), b0 = packetFrameIndex(b, starts[i]), t = <i32>Math.min(expected, Math.min(a.frameCount - a0, b.frameCount - b0)); if (t < 2) continue; let f = windowFeatures(a, b, a0, b0, t), z = modelIntercept; z += ((f[0] - modelMean[0]) / modelStd[0]) * modelCoef[0]; z += ((f[2] - modelMean[1]) / modelStd[1]) * modelCoef[1]; logits[i] = z; resultWindowScores[i] = expit(z); mel[i] = f[0]; melLag[i] = f[1]; flux[i] = f[2]; fluxLag[i] = f[3]; }
  let meanLogit: f64 = 0.0; for (let i = 0; i < starts.length; i++) meanLogit += logits[i]; resultScore = expit(meanLogit / <f64>starts.length); resultLabel = resultScore >= 0.75 ? 2 : resultScore >= 0.25 ? 1 : 0; resultFeatures[0] = median(mel); resultFeatures[1] = median(flux); resultLags[0] = median(melLag); resultLags[1] = median(fluxLag); if (n < modelWindowSec * SR) resultQualityFlags |= 4;
  let minScore = resultWindowScores[0], maxScore = resultWindowScores[0]; for (let i = 1; i < starts.length; i++) { minScore = Math.min(minScore, resultWindowScores[i]); maxScore = Math.max(maxScore, resultWindowScores[i]); } if (starts.length > 1 && maxScore - minScore > 0.5) resultQualityFlags |= 8; return resultScore;
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
export function getPacketByteLength(handle: i32): i32 { return packets[handle].serialized.length; }
export function getPacketByte(handle: i32, index: i32): i32 { return packets[handle].serialized[index]; }
export function getPacketBytes(handle: i32): Uint8Array { return packets[handle].serialized; }
export function getPacketFrameCount(handle: i32): i32 { return packets[handle].frameCount; }
export function getPacketFirstFrameSample(handle: i32): i32 { return packets[handle].firstFrameSample; }
export function getPacketSampleCount(handle: i32): i32 { return packets[handle].sampleCount; }
export function getPacketQuantized(handle: i32): bool { return packets[handle].quantized; }
export function getPacketBitDepth(handle: i32): i32 { return packets[handle].bits; }
export function getPacketMelValue(handle: i32, band: i32, frame: i32): f64 { return packetMel(packets[handle], band, frame); }
export function getPacketFluxValue(handle: i32, frame: i32): f64 { return packets[handle].flux[frame]; }
