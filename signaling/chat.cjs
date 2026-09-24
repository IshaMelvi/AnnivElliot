const MAX_MESSAGE = 1000;
function attachChat(io, socket) {
  let lastSent = -Infinity;
  socket.on('chat-message', (data, ack) => {
    if (typeof ack !== 'function') return;
    const room = socket.data.room;
    if (!room || !socket.rooms.has(room)) return ack({ ok: false, error: 'Rejoignez un salon.' });
    if (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > MAX_MESSAGE) {
      return ack({ ok: false, error: 'Le message doit contenir entre 1 et 1 000 caractères.' });
    }
    if (Date.now() - lastSent < 500) return ack({ ok: false, error: 'Attendez un instant avant de renvoyer un message.' });
    const peers = io.sockets.adapter.rooms.get(room);
    if (!peers || peers.size < 2) return ack({ ok: false, error: 'Votre ami doit être dans le salon pour recevoir le message.' });
    lastSent = Date.now();
    socket.to(room).emit('chat-message', { text: data.text.trim(), sentAt: lastSent });
    ack({ ok: true, sentAt: lastSent });
  });
}
module.exports = { attachChat, MAX_MESSAGE };
