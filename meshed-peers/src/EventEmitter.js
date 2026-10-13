export class EventEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(name, listener) {
    if (typeof listener !== "function") throw new TypeError("Listener must be a function");
    const bucket = this.listeners.get(name) || new Set();
    bucket.add(listener);
    this.listeners.set(name, bucket);
    return () => this.off(name, listener);
  }

  off(name, listener) {
    this.listeners.get(name)?.delete(listener);
    return this;
  }

  once(name, listener) {
    const unsubscribe = this.on(name, (...args) => {
      unsubscribe();
      listener(...args);
    });
    return unsubscribe;
  }

  emit(name, ...args) {
    for (const listener of this.listeners.get(name) || []) {
      try {
        listener(...args);
      } catch (error) {
        if (name !== "error") queueMicrotask(() => this.emit("error", null, error));
      }
    }
    return this;
  }
}
