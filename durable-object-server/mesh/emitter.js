export class Emitter {
    constructor() {
        this.listeners = {};
    }

    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }

    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);

        return () => this.off(event, callback);
    }

    one(event, callback) {
        const off = this.on(event, (...args) => {
            off();
            callback(...args);
        });
    }

    emit(event, ...args) {
        if (this.listeners[event]) {
            // Copy the listener list so a listener can unsubscribe itself while
            // an event is being delivered without changing this dispatch.
            [...this.listeners[event]].forEach(callback => callback(...args));
        }
    }
}