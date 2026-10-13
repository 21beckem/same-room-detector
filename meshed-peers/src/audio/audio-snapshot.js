const LEGACY_MAGIC = 0x4d505331; // "MPS1"
const MAGIC = 0x4d505332; // "MPS2"
const LEGACY_HEADER_BYTES = 16;
const HEADER_BYTES = 32;

export function encodeAudioSnapshot(samples, sampleRate, snapshotId = 0, metadata = {}) {
  const values = Float32Array.from(samples);
  const buffer = new ArrayBuffer(HEADER_BYTES + values.byteLength);
  const header = new DataView(buffer, 0, HEADER_BYTES);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, sampleRate, true);
  header.setUint32(8, values.length, true);
  header.setUint32(12, snapshotId >>> 0, true);
  header.setFloat64(16, Number.isFinite(metadata.captureStartMs) ? metadata.captureStartMs : NaN, true);
  header.setFloat64(24, Number.isFinite(metadata.captureEndMs) ? metadata.captureEndMs : NaN, true);
  new Float32Array(buffer, HEADER_BYTES, values.length).set(values);
  return buffer;
}

export async function decodeAudioSnapshot(payload) {
  const buffer = typeof Blob !== "undefined" && payload instanceof Blob ? await payload.arrayBuffer() : payload;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < LEGACY_HEADER_BYTES) return null;
  const magic = new DataView(buffer, 0, LEGACY_HEADER_BYTES).getUint32(0, true);
  const headerBytes = magic === MAGIC ? HEADER_BYTES : magic === LEGACY_MAGIC ? LEGACY_HEADER_BYTES : 0;
  if (!headerBytes || buffer.byteLength < headerBytes) return null;
  const header = new DataView(buffer, 0, headerBytes);
  const sampleRate = header.getUint32(4, true);
  const sampleCount = header.getUint32(8, true);
  if (!sampleRate || headerBytes + sampleCount * Float32Array.BYTES_PER_ELEMENT > buffer.byteLength) return null;
  const captureStartMs = headerBytes === HEADER_BYTES ? header.getFloat64(16, true) : NaN;
  const captureEndMs = headerBytes === HEADER_BYTES ? header.getFloat64(24, true) : NaN;
  return {
    sampleRate,
    snapshotId: header.getUint32(12, true),
    captureStartMs: Number.isFinite(captureStartMs) ? captureStartMs : null,
    captureEndMs: Number.isFinite(captureEndMs) ? captureEndMs : null,
    samples: new Float32Array(buffer.slice(headerBytes, headerBytes + sampleCount * Float32Array.BYTES_PER_ELEMENT)),
  };
}
