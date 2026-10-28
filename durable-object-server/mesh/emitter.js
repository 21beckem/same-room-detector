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

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(callback => callback(data));
        }
    }
}