import { fetchPreparedAudio } from "./audio.js";
import { SameRoomModel } from "./wasm-model.js";

let model = null;

function pairDetails(a, b) {
  const hasGroupMetadata = a.cat !== undefined && a.gid !== undefined && b.cat !== undefined && b.gid !== undefined;
  const sameGroup = hasGroupMetadata && a.cat === b.cat && a.gid === b.gid;
  if (!hasGroupMetadata) return { expected: null, truth: "group truth unavailable", held_out_score: null };
  const expected = sameGroup ? model.model.targets[a.cat] : 0;
  const truth = sameGroup
    ? `same group (${a.cat}), target ${expected.toFixed(2)}`
    : "different groups, target 0.00";
  const keyA = `${a.cat}/g${a.gid}`;
  const keyB = `${b.cat}/g${b.gid}`;
  const heldOut = keyA === keyB ? (model.model.cv?.held_out_scores?.[keyA] ?? null) : null;
  return { expected, truth, held_out_score: heldOut };
}

async function compare(message) {
  const started = performance.now();
  let audioA;
  let audioB;
  if (message.kind === "recordings") {
    [audioA, audioB] = await Promise.all([
      fetchPreparedAudio(message.a.url),
      fetchPreparedAudio(message.b.url),
    ]);
  } else {
    audioA = new Float64Array(message.audioA);
    audioB = new Float64Array(message.audioB);
  }
  const result = model.scoreBuffers(audioA, audioB);
  return {
    ...result,
    pair: { a: message.a, b: message.b },
    ...pairDetails(message.a, message.b),
    total_ms: performance.now() - started,
  };
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
    } else {
      throw new Error(`Unknown worker message: ${type}`);
    }
  } catch (error) {
    self.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
