import { alignLiveBuffers, estimateLiveOffset } from "./live-sync.js";
import { SameRoomModel } from "./wasm-model.js";

let model = null;

async function compare(message) {
  const started = performance.now();
  let audioA = new Float64Array(message.audioA);
  let audioB = new Float64Array(message.audioB);
  let alignment = null;
  if (message.live) {
    alignment = estimateLiveOffset(audioA, audioB, message.maxAlignmentSeconds ?? 5);
    const aligned = alignLiveBuffers(audioA, audioB, alignment.usable ? alignment.offset_seconds : 0, model.model.config.window_sec);
    audioA = aligned.audioA;
    audioB = aligned.audioB;
  }
  return { ...model.scoreBuffers(audioA, audioB), alignment, total_ms: performance.now() - started };
}

self.onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    if (type === "init") {
      model = await SameRoomModel.load(event.data);
      self.postMessage({ id, type: "ready" });
    } else if (type === "compare") {
      if (!model) throw new Error("Analyzer is not loaded");
      self.postMessage({ id, type: "result", result: await compare(event.data) });
    } else throw new Error(`Unknown worker message: ${type}`);
  } catch (error) {
    self.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
