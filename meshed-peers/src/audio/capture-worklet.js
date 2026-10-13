const CHUNK_FRAMES = 2048;

class RawCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(CHUNK_FRAMES);
    this.pendingLength = 0;
    this.pendingStartFrame = null;
    this.nextFrame = 0;
  }

  process(inputs, outputs) {
    const channels = inputs[0];
    for (const channel of outputs[0] || []) channel.fill(0);
    const channel = channels?.[0];
    const processStartFrame = typeof currentFrame === "number" ? currentFrame : this.nextFrame;
    if (!channel) {
      this.nextFrame = processStartFrame;
      return true;
    }
    for (let frame = 0; frame < channel.length; frame += 1) {
      if (this.pendingLength === 0) this.pendingStartFrame = processStartFrame + frame;
      this.pending[this.pendingLength++] = channel[frame] || 0;
      if (this.pendingLength === CHUNK_FRAMES) {
        this.port.postMessage({ buffer: this.pending.buffer, startFrame: this.pendingStartFrame }, [this.pending.buffer]);
        this.pending = new Float32Array(CHUNK_FRAMES);
        this.pendingLength = 0;
        this.pendingStartFrame = null;
      }
    }
    this.nextFrame = processStartFrame + channel.length;
    return true;
  }
}

registerProcessor("raw-capture", RawCaptureProcessor);
