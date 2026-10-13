const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;

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
    } else if (correlation > secondBest) secondBest = correlation;
  }
  return {
    offset_seconds: bestOffset * FRAME_SAMPLES / SAMPLE_RATE,
    correlation: Math.max(0, bestCorrelation),
    margin: Math.max(0, bestCorrelation - Math.max(0, secondBest)),
    usable: bestCorrelation >= 0.35,
  };
}

export function alignTimestampedSnapshots(local, remote, remoteToLocalOffsetMs = null, targetSeconds = 12, minimumSeconds = 8) {
  const localStart = Number.isFinite(local?.captureStartMs) ? local.captureStartMs : null;
  const localEnd = Number.isFinite(local?.captureEndMs) ? local.captureEndMs : null;
  const remoteStart = Number.isFinite(remote?.captureStartMs) && Number.isFinite(remoteToLocalOffsetMs)
    ? remote.captureStartMs + remoteToLocalOffsetMs
    : null;
  const remoteEnd = Number.isFinite(remote?.captureEndMs) && Number.isFinite(remoteToLocalOffsetMs)
    ? remote.captureEndMs + remoteToLocalOffsetMs
    : null;
  if (localStart === null || localEnd === null || remoteStart === null || remoteEnd === null) {
    return {
      audioA: local.samples,
      audioB: remote.samples,
      usable: true,
      usedTimestamps: false,
      overlapSeconds: Math.min(local.samples.length / local.sampleRate, remote.samples.length / remote.sampleRate),
      offsetMs: null,
    };
  }

  const overlapStart = Math.max(localStart, remoteStart);
  const overlapEnd = Math.min(localEnd, remoteEnd);
  const overlapSeconds = Math.max(0, (overlapEnd - overlapStart) / 1000);
  if (overlapSeconds < minimumSeconds) {
    return { usable: false, usedTimestamps: true, overlapSeconds, offsetMs: remoteToLocalOffsetMs };
  }

  const selectedEnd = overlapEnd;
  const selectedStart = Math.max(overlapStart, selectedEnd - targetSeconds * 1000);
  const localStartIndex = Math.max(0, Math.round((selectedStart - localStart) * local.sampleRate / 1000));
  const localEndIndex = Math.min(local.samples.length, Math.round((selectedEnd - localStart) * local.sampleRate / 1000));
  const remoteStartIndex = Math.max(0, Math.round((selectedStart - remoteStart) * remote.sampleRate / 1000));
  const remoteEndIndex = Math.min(remote.samples.length, Math.round((selectedEnd - remoteStart) * remote.sampleRate / 1000));
  const localLength = localEndIndex - localStartIndex;
  const remoteLength = remoteEndIndex - remoteStartIndex;
  const sampleCount = Math.min(localLength, remoteLength);
  if (sampleCount < Math.floor(minimumSeconds * Math.min(local.sampleRate, remote.sampleRate))) {
    return { usable: false, usedTimestamps: true, overlapSeconds, offsetMs: remoteToLocalOffsetMs };
  }
  return {
    audioA: local.samples.slice(localEndIndex - sampleCount, localEndIndex),
    audioB: remote.samples.slice(remoteEndIndex - sampleCount, remoteEndIndex),
    usable: true,
    usedTimestamps: true,
    overlapSeconds,
    offsetMs: remoteToLocalOffsetMs,
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
