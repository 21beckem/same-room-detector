const CHUNK_FRAMES = 2048;

class RawCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(CHUNK_FRAMES);
    this.pendingLength = 0;
  }

  process(inputs, outputs) {
    const channels = inputs[0];
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }
    if (!channels || channels.length === 0) return true;

    const frames = channels[0].length;
    const channel = channels[0];
    for (let frame = 0; frame < frames; frame += 1) {
      this.pending[this.pendingLength++] = channel[frame] || 0;
      if (this.pendingLength === CHUNK_FRAMES) {
        this.port.postMessage(this.pending.buffer, [this.pending.buffer]);
        this.pending = new Float32Array(CHUNK_FRAMES);
        this.pendingLength = 0;
      }
    }
    return true;
  }
}

registerProcessor("raw-capture", RawCaptureProcessor);
