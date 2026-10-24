const CHUNK_FRAMES = 2048;

// Windowed-sinc conversion with a persistent input ring and fractional phase.
// Only the context's device-rate variant uses this; 16 kHz capture bypasses it.
export class StreamingResampler {
  constructor(inputRate, outputRate) {
    if (![inputRate, outputRate].every((rate) => Number.isInteger(rate) && rate > 0)) {
      throw new RangeError("Resampling rates must be positive integers.");
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.radius = Math.ceil(32 * Math.max(1, inputRate / outputRate));
    this.buffer = new Float32Array(2 * this.radius + 2);
    this.inputFrames = 0;
    this.outputFrames = 0;
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const phases = outputRate / gcd(inputRate, outputRate);
    this.phaseCount = Math.min(phases, 1024);
    this.kernels = [];
    const cutoff = 0.45 * Math.min(1, outputRate / inputRate);
    for (let phase = 0; phase < this.phaseCount; phase += 1) {
      const kernel = new Float64Array(2 * this.radius + 1);
      let sum = 0;
      for (let tap = 0; tap < kernel.length; tap += 1) {
        const distance = tap - this.radius - phase / this.phaseCount;
        const x = distance / this.radius;
        const window = Math.abs(x) > 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
        const sinc = Math.abs(distance) < 1e-12 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        kernel[tap] = sinc * window;
        sum += kernel[tap];
      }
      for (let tap = 0; tap < kernel.length; tap += 1) kernel[tap] /= sum;
      this.kernels.push(kernel);
    }
  }

  process(input, emit) {
    for (const value of input) {
      const lastFrame = this.inputFrames++;
      this.buffer[lastFrame % this.buffer.length] = value;
      // Integer frame counters avoid accumulating fractional clock error.
      while (true) {
        const positionNumerator = this.outputFrames * this.inputRate;
        const center = Math.floor(positionNumerator / this.outputRate);
        if (center + this.radius > lastFrame) break;
        const fraction = (positionNumerator % this.outputRate) / this.outputRate;
        const phase = Math.min(this.phaseCount - 1, Math.floor(fraction * this.phaseCount + 1e-8));
        const kernel = this.kernels[phase];
        let sample = 0;
        for (let tap = 0; tap < kernel.length; tap += 1) {
          const frame = center + tap - this.radius;
          if (frame >= 0) sample += this.buffer[frame % this.buffer.length] * kernel[tap];
        }
        this.outputFrames += 1;
        emit(sample);
      }
    }
  }
}

class RawCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.includeDiagnostics = Boolean(options?.processorOptions?.diagnostics);
    this.pending = new Float32Array(CHUNK_FRAMES);
    this.pendingLength = 0;
    this.pendingStartFrame = 0;
    this.totalFrames = 0;
    this.inputFrames = 0;
    this.sequence = 0;
    this.outputRate = options?.processorOptions?.outputSampleRate || sampleRate;
    this.resampler = this.outputRate === sampleRate ? null : new StreamingResampler(sampleRate, this.outputRate);
    this.emitSample = (value) => this.appendSample(value);
  }

  appendSample(value) {
    if (this.pendingLength === 0) this.pendingStartFrame = this.totalFrames;
    this.pending[this.pendingLength++] = value || 0;
    this.totalFrames += 1;
    if (this.pendingLength !== CHUNK_FRAMES) return;
    if (this.includeDiagnostics) {
      this.port.postMessage({
        buffer: this.pending.buffer,
        sequence: this.sequence++,
        frameStart: this.pendingStartFrame,
        frameEnd: this.totalFrames,
        audioTimeStart: this.pendingStartFrame / this.outputRate,
        audioTimeEnd: this.totalFrames / this.outputRate,
        inputSampleRate: sampleRate,
        outputSampleRate: this.outputRate,
        // These are context/input frames; frameStart/frameEnd above are 16 kHz.
        inputFramesProcessed: this.inputFrames,
        renderFrameEnd: this.renderFrameEnd,
      }, [this.pending.buffer]);
    } else {
      this.port.postMessage(this.pending.buffer, [this.pending.buffer]);
    }
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
    this.inputFrames += frames;
    this.renderFrameEnd = currentFrame + frames;
    if (this.resampler) this.resampler.process(channel, this.emitSample);
    else for (let frame = 0; frame < frames; frame += 1) this.appendSample(channel[frame]);
    return true;
  }
}

registerProcessor("audio-compare-capture", RawCaptureProcessor);
