const MAX_BUFFER_SECONDS = 12;

export class RollingAudioBuffer {
  constructor(maxSeconds = MAX_BUFFER_SECONDS) {
    this.maxSeconds = maxSeconds;
    this.chunks = [];
    this.totalSamples = 0;
    this.sampleRate = null;
  }

  append(samples, sampleRate) {
    if (!this.sampleRate) this.sampleRate = sampleRate;
    if (this.sampleRate !== sampleRate) throw new Error("Audio sample rate changed during capture");
    this.chunks.push(Float32Array.from(samples));
    this.totalSamples += samples.length;

    const maxSamples = Math.ceil(this.maxSeconds * this.sampleRate);
    while (this.totalSamples > maxSamples && this.chunks.length > 1) {
      this.totalSamples -= this.chunks.shift().length;
    }
  }

  get seconds() {
    return this.sampleRate ? this.totalSamples / this.sampleRate : 0;
  }

  snapshot(maxSeconds = this.maxSeconds) {
    const sampleCount = Math.min(this.totalSamples, Math.floor(maxSeconds * this.sampleRate));
    const result = new Float32Array(sampleCount);
    let skip = this.totalSamples - sampleCount;
    let offset = 0;
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      const start = skip;
      const visible = chunk.subarray(start);
      result.set(visible, offset);
      offset += visible.length;
      skip = 0;
    }
    return result;
  }

  clear() {
    this.chunks = [];
    this.totalSamples = 0;
  }
}

export class RawStreamCapture {
  constructor(audioContext, stream, onChunk) {
    this.audioContext = audioContext;
    this.stream = stream;
    this.onChunk = onChunk;
    this.source = audioContext.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(audioContext, "raw-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    this.silentSink = audioContext.createGain();
    this.silentSink.gain.value = 0;
    this.node.port.onmessage = (event) => {
      this.onChunk(new Float32Array(event.data), audioContext.sampleRate);
    };
    this.source.connect(this.node).connect(this.silentSink).connect(audioContext.destination);
  }

  dispose() {
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    this.silentSink.disconnect();
  }
}
