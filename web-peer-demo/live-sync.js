const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms at the normalized analysis rate.

function envelope(samples) {
  const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
  const result = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * FRAME_SAMPLES;
    let energy = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const value = samples[start + i];
      energy += value * value;
    }
    result[frame] = Math.log(Math.sqrt(energy / FRAME_SAMPLES) + 1e-7);
  }
  return result;
}

function normalizedCorrelation(a, b, offset) {
  const aStart = Math.max(0, -offset);
  const bStart = Math.max(0, offset);
  const count = Math.min(a.length - aStart, b.length - bStart);
  if (count < 1) return 0;

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < count; i += 1) {
    meanA += a[aStart + i];
    meanB += b[bStart + i];
  }
  meanA /= count;
  meanB /= count;

  let numerator = 0;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < count; i += 1) {
    const da = a[aStart + i] - meanA;
    const db = b[bStart + i] - meanB;
    numerator += da * db;
    energyA += da * da;
    energyB += db * db;
  }
  if (energyA < 1e-9 || energyB < 1e-9) return 0;
  return numerator / Math.sqrt(energyA * energyB);
}

export function estimateLiveOffset(audioA, audioB, maxSeconds = 5) {
  const a = envelope(audioA);
  const b = envelope(audioB);
  const maxOffsetFrames = Math.floor(maxSeconds * SAMPLE_RATE / FRAME_SAMPLES);
  const minimumFrames = Math.floor(8 * SAMPLE_RATE / FRAME_SAMPLES);
  let bestOffset = 0;
  let bestCorrelation = -1;
  let secondBest = -1;

  for (let offset = -maxOffsetFrames; offset <= maxOffsetFrames; offset += 1) {
    const overlap = Math.min(a.length - Math.max(0, -offset), b.length - Math.max(0, offset));
    if (overlap < minimumFrames) continue;
    const correlation = normalizedCorrelation(a, b, offset);
    if (correlation > bestCorrelation) {
      secondBest = bestCorrelation;
      bestCorrelation = correlation;
      bestOffset = offset;
    } else if (correlation > secondBest) {
      secondBest = correlation;
    }
  }

  return {
    offset_seconds: bestOffset * FRAME_SAMPLES / SAMPLE_RATE,
    correlation: Math.max(0, bestCorrelation),
    margin: Math.max(0, bestCorrelation - Math.max(0, secondBest)),
    usable: bestCorrelation >= 0.35,
  };
}

export function alignLiveBuffers(audioA, audioB, offsetSeconds, targetSeconds = 12) {
  const offset = Math.round(offsetSeconds * SAMPLE_RATE);
  let aStart = 0;
  let bStart = 0;
  let length = Math.min(audioA.length, audioB.length);
  if (offset > 0) {
    bStart = offset;
    length = Math.min(audioA.length, audioB.length - bStart);
  } else if (offset < 0) {
    aStart = -offset;
    length = Math.min(audioA.length - aStart, audioB.length);
  }

  const targetSamples = Math.min(length, Math.floor(targetSeconds * SAMPLE_RATE));
  aStart += length - targetSamples;
  bStart += length - targetSamples;
  return {
    audioA: audioA.slice(aStart, aStart + targetSamples),
    audioB: audioB.slice(bStart, bStart + targetSamples),
  };
}
