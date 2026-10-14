const MAX_BUFFER_SECONDS = 18;

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

export class RollingAudioBuffer {
  constructor(maxSeconds = MAX_BUFFER_SECONDS) {
    this.maxSeconds = maxSeconds;
    this.chunks = [];
    this.totalSamples = 0;
    this.sampleRate = null;
    this.lastChunkReceivedAtMs = null;
  }

  append(samples, sampleRate, startFrame = null, captureEndMs = null, receivedAtMs = nowMs()) {
    if (!samples?.length || !sampleRate) return;
    if (!this.sampleRate) this.sampleRate = sampleRate;
    if (this.sampleRate !== sampleRate) throw new Error("Audio sample rate changed during capture");

    const values = Float32Array.from(samples);
    const endMs = finiteNumber(captureEndMs);
    const startMs = endMs === null ? null : endMs - values.length / sampleRate * 1000;
    const previous = this.chunks[this.chunks.length - 1];
    const inferredStartFrame = finiteNumber(startFrame) ?? (
      previous?.endFrame !== null && previous?.endFrame !== undefined
        ? previous.endFrame
        : this.totalSamples
    );
    this.chunks.push({
      samples: values,
      startFrame: inferredStartFrame,
      endFrame: inferredStartFrame === null ? null : inferredStartFrame + values.length,
      startMs,
      endMs,
    });
    this.totalSamples += values.length;
    this.lastChunkReceivedAtMs = finiteNumber(receivedAtMs);

    const maxSamples = Math.ceil(this.maxSeconds * this.sampleRate);
    while (this.totalSamples > maxSamples && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      this.totalSamples -= removed.samples.length;
    }
  }

  get seconds() {
    return this.sampleRate ? this.totalSamples / this.sampleRate : 0;
  }

  get latestCaptureEndMs() {
    return this.chunks[this.chunks.length - 1]?.endMs ?? null;
  }

  isFresh(maxAgeSeconds, currentMs = nowMs()) {
    const endMs = this.latestCaptureEndMs;
    if (endMs === null) return true;
    return currentMs - endMs <= maxAgeSeconds * 1000;
  }

  captureAgeMs(currentMs = nowMs()) {
    if (this.lastChunkReceivedAtMs === null) return null;
    return Math.max(0, currentMs - this.lastChunkReceivedAtMs);
  }

  isCaptureFresh(maxAgeSeconds, currentMs = nowMs()) {
    const ageMs = this.captureAgeMs(currentMs);
    return ageMs !== null && ageMs <= maxAgeSeconds * 1000;
  }

  flatten() {
    if (!this.sampleRate || !this.totalSamples) return new Float32Array();
    const result = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk.samples, offset);
      offset += chunk.samples.length;
    }
    return result;
  }

  snapshot(maxSeconds = this.maxSeconds) {
    return this.snapshotWithMetadata(maxSeconds)?.samples || new Float32Array();
  }

  snapshotWithMetadata(maxSeconds = this.maxSeconds, targetEndMs = null) {
    if (!this.sampleRate || !this.totalSamples) return null;
    const sampleCount = Math.min(this.totalSamples, Math.floor(maxSeconds * this.sampleRate));
    const latestChunk = this.chunks[this.chunks.length - 1];
    const firstChunk = this.chunks[0];
    const requestedEndMs = finiteNumber(targetEndMs);
    let endIndex = this.totalSamples;

    if (requestedEndMs !== null && latestChunk.endMs !== null && firstChunk.startMs !== null) {
      const toleranceMs = 100;
      if (requestedEndMs < firstChunk.startMs - toleranceMs || requestedEndMs > latestChunk.endMs + toleranceMs) return null;
      endIndex = Math.round((requestedEndMs - firstChunk.startMs) * this.sampleRate / 1000);
      endIndex = Math.max(0, Math.min(this.totalSamples, endIndex));
    }

    const startIndex = Math.max(0, endIndex - sampleCount);
    if (endIndex - startIndex < Math.floor(maxSeconds * this.sampleRate)) return null;
    const result = new Float32Array(endIndex - startIndex);
    let sourceIndex = 0;
    let destinationIndex = 0;
    for (const chunk of this.chunks) {
      const chunkStart = sourceIndex;
      const chunkEnd = sourceIndex + chunk.samples.length;
      const visibleStart = Math.max(startIndex, chunkStart);
      const visibleEnd = Math.min(endIndex, chunkEnd);
      if (visibleEnd > visibleStart) {
        result.set(chunk.samples.subarray(visibleStart - chunkStart, visibleEnd - chunkStart), destinationIndex);
        destinationIndex += visibleEnd - visibleStart;
      }
      sourceIndex = chunkEnd;
      if (sourceIndex >= endIndex) break;
    }

    const firstSample = startIndex === 0 ? firstChunk : this.chunkAt(startIndex);
    const lastSample = endIndex === this.totalSamples ? latestChunk : this.chunkAt(endIndex - 1);
    const captureStartMs = firstChunk.startMs === null ? null : firstChunk.startMs + startIndex / this.sampleRate * 1000;
    const captureEndMs = latestChunk.endMs === null ? null : firstChunk.startMs + endIndex / this.sampleRate * 1000;
    const startFrame = firstSample?.startFrame === null || firstSample?.startFrame === undefined
      ? null
      : firstSample.startFrame + (startIndex - this.indexOfChunk(firstSample));
    const endFrame = lastSample?.endFrame === null || lastSample?.endFrame === undefined
      ? null
      : startFrame === null ? null : startFrame + result.length;
    return {
      samples: result,
      sampleRate: this.sampleRate,
      startFrame,
      endFrame,
      captureStartMs,
      captureEndMs,
    };
  }

  chunkAt(sampleIndex) {
    let offset = 0;
    for (const chunk of this.chunks) {
      if (sampleIndex < offset + chunk.samples.length) return chunk;
      offset += chunk.samples.length;
    }
    return this.chunks[this.chunks.length - 1] || null;
  }

  indexOfChunk(target) {
    let offset = 0;
    for (const chunk of this.chunks) {
      if (chunk === target) return offset;
      offset += chunk.samples.length;
    }
    return 0;
  }

  clear() {
    this.chunks = [];
    this.totalSamples = 0;
    this.lastChunkReceivedAtMs = null;
  }

  replace(samples, sampleRate, metadata = {}) {
    this.clear();
    this.append(samples, sampleRate, metadata.startFrame, metadata.captureEndMs, nowMs());
  }
}

export class RawStreamCapture {
  constructor(audioContext, stream, workletUrl, onChunk, { onStateChange = null, onError = null } = {}) {
    this.audioContext = audioContext;
    this.stream = stream;
    this.onChunk = onChunk;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.clockOriginMs = nowMs() - audioContext.currentTime * 1000;
    this.clockRebasePending = false;
    this.lastChunkReceivedAtMs = null;
    this.lastCaptureEndMs = null;
    this.chunkCount = 0;
    this.source = audioContext.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(audioContext, "raw-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      outputChannelCount: [1],
    });
    this.silentSink = audioContext.createGain();
    this.silentSink.gain.value = 0;
    this.stateChangeHandler = () => {
      this.clockRebasePending = true;
      if (this.audioContext.state === "running") this.rebaseClock();
      this.onStateChange?.(this.audioContext.state, this);
    };
    this.audioContext.addEventListener?.("statechange", this.stateChangeHandler);
    this.node.port.onmessage = (event) => {
      const payload = event.data;
      const buffer = payload?.buffer instanceof ArrayBuffer ? payload.buffer : payload;
      if (!(buffer instanceof ArrayBuffer)) return;
      const samples = new Float32Array(buffer);
      const startFrame = finiteNumber(payload?.startFrame);
      const endFrame = startFrame === null ? null : startFrame + samples.length;
      const receivedAtMs = nowMs();
      if (audioContext.state === "running" && this.clockRebasePending) this.rebaseClock(receivedAtMs);
      const captureEndMs = endFrame === null || audioContext.state !== "running"
        ? null
        : this.clockOriginMs + endFrame / audioContext.sampleRate * 1000;
      this.lastChunkReceivedAtMs = receivedAtMs;
      this.lastCaptureEndMs = captureEndMs;
      this.chunkCount += 1;
      try {
        this.onChunk(samples, audioContext.sampleRate, startFrame, captureEndMs, receivedAtMs);
      } catch (error) {
        if (this.onError) this.onError(error, this);
        else throw error;
      }
    };
    this.source.connect(this.node).connect(this.silentSink).connect(audioContext.destination);
  }

  rebaseClock(currentMs = nowMs()) {
    this.clockOriginMs = currentMs - this.audioContext.currentTime * 1000;
    this.clockRebasePending = false;
  }

  dispose() {
    this.node.port.onmessage = null;
    this.audioContext.removeEventListener?.("statechange", this.stateChangeHandler);
    this.source.disconnect();
    this.node.disconnect();
    this.silentSink.disconnect();
  }
}
