import { Socket } from 'socket.io';
import { debug } from './debug.js';

export class Client {
    #socket;
    constructor(socket) {
        if (!(socket instanceof Socket))
            throw new TypeError('socket must be an instance of Socket.');
        this.#socket = socket;
    }
    get id() { return this.#socket.id; }
    get socket() { return this.#socket; }
    get isConnected() { return this.#socket.connected; }
    get isDisconnected() { return !this.#socket.connected; }
    get on() { return this.#socket.on.bind(this.#socket); }
    get emit() { return this.#socket.emit.bind(this.#socket); }
    destroy() {
        debug.log(`Destroying client with id ${this.id}`);
        this.#socket.disconnect(true);
    }
}

export class Clients {
    #clients;
    constructor() {
        this.#clients = new Map();
    }
    addFromSocket(socket) {
        if (!(socket instanceof Socket))
            throw new TypeError('socket must be an instance of Socket.');
        if (this.#clients.has(socket.id))
            throw new Error('Client already exists.');

        const client = new Client(socket);

        this.#add(client);

        return client;
    }
    #add(client) {
        if (!(client instanceof Client))
            throw new TypeError('client must be an instance of Client.');
        if (this.#clients.has(client.id))
            throw new Error('Client already exists.');
        
        this.#clients.set(client.id, client);

        client.on('disconnect', () => this.remove(client.id));
        client.on('error', (err) => {
            debug.error(`Client with id ${client.id} encountered an error:`, err);
            this.remove(client.id);
        });
        client.on('close', () => this.remove(client.id));
        client.on('end', () => this.remove(client.id));
        client.on('timeout', () => this.remove(client.id));
        client.on('broadcast', (msg) => {
            debug.log(`Client with id ${client.id} emitted broadcast event:`, msg);
        });
        client.on('discover', () => this.#onDiscover(client));

        debug.log(`Added client with id ${client.id}`);

        this.#clients.set(client.id, client);
    }
    #onDiscover(client) {
        debug.log(`Client with id ${client.id} requested discovery of other clients.`);
        client.emit('discover', Array.from(this.#clients.keys()).filter(id => id !== client.id));
    }
    get(id) {
        return this.#clients.get(id);
    }
    remove(id) {
        if (!this.#clients.has(id)) {
            console.warn(`Attempted to remove client with id ${id}, but it does not exist.`);
            return;
        }
        debug.log(`Removing client with id ${id}`);

        this.#clients.get(id).destroy();
        this.#clients.delete(id);
    }
}