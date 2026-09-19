const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');

const app = express();
app.get('/health', (_request, response) => response.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 128 * 1024
});

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;

function validSignal(message) {
  if (!message || typeof message !== 'object' || !message.data) return false;
  const { type, data } = message;
  if (type === 'media-map') return isId(data.screen) && isId(data.camera);
  if (type === 'offer' || type === 'answer') {
    return data.type === type && typeof data.sdp === 'string' && data.sdp.length <= 100_000;
  }
  if (type === 'ice') {
    return typeof data.candidate === 'string' && data.candidate.length <= 4096;
  }
  return false;
}

io.on('connection', (socket) => {
  socket.on('join-room', async (room, reply) => {
    if (typeof reply !== 'function') return;
    if (typeof room !== 'string' || !/^[a-f0-9]{64}$/.test(room)) {
      reply({ ok: false, error: 'Nom de salon invalide.' });
      return;
    }
    if (socket.data.room) {
      reply({ ok: false, error: 'Vous êtes déjà dans un salon.' });
      return;
    }
    const peers = io.sockets.adapter.rooms.get(room);
    if (peers && peers.size >= 2) {
      reply({ ok: false, error: 'Ce salon est complet (2 personnes maximum).' });
      return;
    }
    const peerPresent = Boolean(peers?.size);
    await socket.join(room);
    socket.data.room = room;
    reply({ ok: true, peerPresent });
    if (peerPresent) socket.to(room).emit('peer-joined');
  });

  socket.on('signal', (message) => {
    const room = socket.data.room;
    if (!room || !validSignal(message)) return;
    socket.to(room).emit('signal', { type: message.type, data: message.data });
  });

  socket.on('disconnecting', () => {
    if (socket.data.room) socket.to(socket.data.room).emit('peer-left');
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Signalisation prête sur le port ${port}`));
