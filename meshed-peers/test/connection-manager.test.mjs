import assert from "node:assert/strict";
import { PeerConnectionManager } from "../src/PeerConnectionManager.js";

class FakeConnection {
  constructor(peer, { label, metadata } = {}) {
    this.peer = peer;
    this.label = label;
    this.metadata = metadata;
    this.open = false;
    this.handlers = new Map();
  }

  on(name, listener) {
    const listeners = this.handlers.get(name) || new Set();
    listeners.add(listener);
    this.handlers.set(name, listeners);
  }

  close() {
    this.open = false;
  }
}

const manager = new PeerConnectionManager();
const audio = new FakeConnection("remote", { label: "meshed-peers-audio" });
const control = new FakeConnection("remote", { label: "meshed-peers-control" });
manager.attachData(audio);
manager.attachData(control);

const session = manager.sessions.get("remote");
assert.equal(session.audioData, audio);
assert.equal(session.data, control);
assert.equal(session.audioDataOpen, false);
assert.equal(session.dataOpen, false);
console.log("connection-manager-channel-classification-ok");
