import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { PeerServer } from 'peer';
import { Clients } from './clients.js';

const peerServer = PeerServer({ 
  port: 9000, 
  path: '/peer'
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});
app.use('/peerjs', peerServer);

const clients = new Clients();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('<h1>Hello world</h1>');
});

io.on('connection', (socket) => {
    clients.addFromSocket(socket);
});

server.listen(PORT, () => {
    console.log(`listening on *:${PORT}`);
});