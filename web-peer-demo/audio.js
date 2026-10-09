const SAMPLE_RATE = 16000;
const MAX_SECONDS = 30;

function ascii(view, offset, length) {
  let value = "";
  for (let i = 0; i < length; i += 1) value += String.fromCharCode(view.getUint8(offset + i));
  return value;
}

function readWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") throw new Error("Not a RIFF/WAVE file");
  let format = null;
  let dataOffset = null;
  let dataLength = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + length > view.byteLength) throw new Error("WAV chunk exceeds file length");
    if (id === "fmt ") {
      format = {
        encoding: view.getUint16(body, true),
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
  if (!format || dataOffset === null) throw new Error("WAV is missing fmt/data chunks");
  if (!format.channels || format.bits % 8 !== 0) throw new Error("Unsupported WAV channel or sample width");

  const bytesPerSample = format.bits / 8;
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(dataLength / frameBytes);
  const mono = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const at = dataOffset + (frame * format.channels + channel) * bytesPerSample;
      let sample;
      if (format.encoding === 3 && format.bits === 32) sample = view.getFloat32(at, true);
      else if (format.encoding === 1 && format.bits === 8) sample = (view.getUint8(at) - 128) / 128;
      else if (format.encoding === 1 && format.bits === 16) sample = view.getInt16(at, true) / 32768;
      else if (format.encoding === 1 && format.bits === 24) {
        let raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        if (raw & 0x800000) raw -= 0x1000000;
        sample = raw / 2147483648;
      } else if (format.encoding === 1 && format.bits === 32) sample = view.getInt32(at, true) / 2147483648;
      else throw new Error(`Unsupported WAV encoding=${format.encoding}, bits=${format.bits}`);
      total += sample;
    }
    mono[frame] = total / format.channels;
  }
  return { samples: mono, sampleRate: format.sampleRate };
}

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
  const factor = gcd(up, down);
  up /= factor;
  down /= factor;
  if (up === 1 && down === 1) return Float64Array.from(x);
  const maxRate = Math.max(up, down);
  const halfLen = 10 * maxRate;
  const base = scipyFirwin(2 * halfLen + 1, 1 / maxRate);
  const nPrePad = down - (halfLen % down);
  const filter = new Float64Array(nPrePad + base.length);
  for (let i = 0; i < base.length; i += 1) filter[nPrePad + i] = base[i] * up;
  const output = new Float64Array(Math.floor((x.length * up + down - 1) / down));
  const nPreRemove = Math.floor((halfLen + nPrePad) / down);
  for (let k = 0; k < output.length; k += 1) {
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

export function prepareSamples(input, sampleRate, maxSeconds = MAX_SECONDS) {
  let samples = Float64Array.from(input);
  if (sampleRate !== SAMPLE_RATE) {
    const factor = gcd(sampleRate, SAMPLE_RATE);
    samples = resamplePoly(samples, SAMPLE_RATE / factor, sampleRate / factor);
  }
  samples = samples.slice(0, Math.floor(maxSeconds * SAMPLE_RATE));
  if (!samples.length) throw new Error("WAV contains no samples");
  let mean = 0;
  for (const value of samples) mean += value;
  mean /= samples.length;
  for (let i = 0; i < samples.length; i += 1) samples[i] -= mean;
  return samples;
}

export function prepareAudio(arrayBuffer) {
  const wav = readWav(arrayBuffer);
  return prepareSamples(wav.samples, wav.sampleRate);
}

export async function fetchPreparedAudio(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load audio (${response.status}): ${url}`);
  return prepareAudio(await response.arrayBuffer());
}
