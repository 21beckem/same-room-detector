export class SameRoomAnalyzer {
  constructor({
    workerUrl = new URL("./analysis-worker.js", import.meta.url),
    modelUrl,
    wasmUrl,
    baseUrl = typeof document !== "undefined" ? document.baseURI : undefined,
  } = {}) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.baseUrl = baseUrl;
    this.modelUrl = this.resolveAssetUrl(modelUrl);
    this.wasmUrl = this.resolveAssetUrl(wasmUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Analysis worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.loadPromise = null;
  }

  resolveAssetUrl(url) {
    if (!url) return url;
    return this.baseUrl ? new URL(url, this.baseUrl).href : url;
  }

  request(message, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  handleMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(new Error(message.message));
    else pending.resolve(message.result ?? true);
  }

  load() {
    if (!this.loadPromise) {
      this.loadPromise = this.request({
        type: "init",
        modelUrl: this.modelUrl,
        wasmUrl: this.wasmUrl,
        baseUrl: this.baseUrl,
      });
    }
    return this.loadPromise;
  }

  ready() {
    return this.load();
  }

  async compareBuffers(audioA, audioB, options = {}) {
    await this.load();
    const a = Float64Array.from(audioA);
    const b = Float64Array.from(audioB);
    return this.request(
      { type: "compare", live: options.live === true, maxAlignmentSeconds: options.maxAlignmentSeconds, audioA: a.buffer, audioB: b.buffer },
      [a.buffer, b.buffer],
    );
  }

  dispose() {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Analyzer disposed"));
    this.pending.clear();
  }
}
