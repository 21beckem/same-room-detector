import loader from "./vendor/assemblyscript-loader.js";

function label(value) {
  return value === 2 ? "close" : value === 1 ? "middle" : "unrelated";
}

function qualityNotes(flags, windowSeconds) {
  const notes = [];
  if (flags & 1) notes.push("very quiet input");
  if (flags & 2) notes.push("very steady sound: little happening to compare");
  if (flags & 4) notes.push(`shorter than the ${windowSeconds.toFixed(0)} s training window`);
  if (flags & 8) notes.push("windows disagree with each other");
  return notes;
}

export class SameRoomModel {
  constructor(model, wasmInstance) {
    this.model = model;
    this.exports = wasmInstance.exports;
    const c = model.config;
    this.exports.configure(
      model.intercept,
      model.mean[0], model.mean[1], model.mean[2],
      model.std[0], model.std[1], model.std[2],
      model.coef[0], model.coef[1], model.coef[2],
      c.window_sec, c.hop_sec, c.max_lag, c.min_sec,
    );
  }

  static async load({ modelUrl = "../model_output/model.json", wasmUrl = "../web-calibration/wasm_parity/wasm/same_room.wasm" } = {}) {
    const [modelResponse, wasmResponse] = await Promise.all([fetch(modelUrl), fetch(wasmUrl)]);
    if (!modelResponse.ok) throw new Error(`Could not load model (${modelResponse.status})`);
    if (!wasmResponse.ok) throw new Error(`Could not load WASM (${wasmResponse.status})`);
    const [model, wasmBytes] = await Promise.all([modelResponse.json(), wasmResponse.arrayBuffer()]);
    const wasmInstance = await loader.instantiate(wasmBytes, {});
    return new SameRoomModel(model, wasmInstance);
  }

  scoreBuffers(audioA, audioB) {
    const a = audioA instanceof Float64Array ? audioA : Float64Array.from(audioA);
    const b = audioB instanceof Float64Array ? audioB : Float64Array.from(audioB);
    const n = Math.min(a.length, b.length);
    const minSamples = this.model.config.min_sec * 16000;
    if (n < minSamples) {
      throw new Error(`Need at least ${this.model.config.min_sec.toFixed(0)} s of audio from each device (got ${(n / 16000).toFixed(1)} s).`);
    }

    const started = performance.now();
    let wasmA = 0;
    let wasmB = 0;
    try {
      wasmA = this.exports.__pin(this.exports.__newArray(this.exports.FLOAT64ARRAY_ID, a));
      wasmB = this.exports.__pin(this.exports.__newArray(this.exports.FLOAT64ARRAY_ID, b));
      this.exports.scoreAudio(wasmA, wasmB);

      const flags = this.exports.getQualityFlags();
      const windowScores = [];
      for (let i = 0; i < this.exports.getWindowCount(); i += 1) windowScores.push(this.exports.getWindowScore(i));
      return {
        score: this.exports.getScore(),
        label: label(this.exports.getLabel()),
        window_scores: windowScores,
        features: {
          gcc_peak: this.exports.getFeature(0),
          mel_peak: this.exports.getFeature(1),
          flux_peak: this.exports.getFeature(2),
        },
        lags: {
          gcc: this.exports.getLag(0),
          mel: this.exports.getLag(1),
          flux: this.exports.getLag(2),
        },
        quality: {
          ok: flags === 0,
          notes: qualityNotes(flags, this.model.config.window_sec),
          level_dbfs: this.exports.getLevel(),
          activity_db: this.exports.getActivity(),
        },
        seconds: this.exports.getSeconds(),
        wasm_ms: performance.now() - started,
      };
    } finally {
      if (wasmB) this.exports.__unpin(wasmB);
      if (wasmA) this.exports.__unpin(wasmA);
      if (typeof this.exports.__collect === "function") this.exports.__collect();
    }
  }
}
