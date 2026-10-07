const MAX_BUFFER_SECONDS = 20;

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

  snapshot() {
    const result = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
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
