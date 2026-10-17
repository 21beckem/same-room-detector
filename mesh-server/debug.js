const DEBUG = true;

export class debug {
    static log(...args) {
        if (DEBUG) console.log(...args);
    }
    static warn(...args) {
        if (DEBUG) console.warn(...args);
    }
    static error(...args) {
        if (DEBUG) console.error(...args);
    }
}