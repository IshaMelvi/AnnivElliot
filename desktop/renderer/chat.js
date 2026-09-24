export function createChat({ getSocket, getPeerName }) {
  const $ = (id) => document.getElementById(id);
  const log = $('chat-messages');
  const input = $('chat-input');
  let ready = false;
  let pending = false;
  let generation = 0;
  function connected(value) {
    ready = value;
    input.disabled = !ready;
    $('chat-send').disabled = !ready || pending;
    $('chat-status').textContent = ready ? 'Messages du salon · non enregistrés' : 'Chat en attente de connexion…';
  }
  function append(text, name, sentAt, self = false) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    const row = document.createElement('div');
    row.className = 'chat-message' + (self ? ' chat-self' : '');
    const author = document.createElement('strong');
    author.textContent = name + ' · ';
    const body = document.createElement('span');
    body.textContent = text;
    const time = document.createElement('time');
    const date = new Date(Number.isFinite(sentAt) ? sentAt : Date.now());
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.append(author, body, time);
    log.append(row);
    while (log.childElementCount > 100) log.firstElementChild.remove();
    if (nearBottom || self) log.scrollTop = log.scrollHeight;
    else $('chat-new').hidden = false;
  }
  $('chat-new').addEventListener('click', () => { log.scrollTop = log.scrollHeight; $('chat-new').hidden = true; });
  log.addEventListener('scroll', () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 30) $('chat-new').hidden = true; });
  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    const socket = getSocket();
    if (!ready || pending || !socket?.connected || !text) return;
    const version = generation;
    pending = true;
    $('chat-send').disabled = true;
    $('chat-status').textContent = 'Envoi…';
    // Never queue messages while disconnected, or automatically retry ambiguous acknowledgements.
    socket.volatile.timeout(5000).emit('chat-message', { text }, (error, response) => {
      if (version !== generation || getSocket() !== socket) return;
      pending = false;
      $('chat-send').disabled = !ready;
      if (error || !response?.ok) {
        $('chat-status').textContent = error ? 'Envoi non confirmé. Vérifiez la connexion et la version du serveur ; le texte est conservé.' : response.error;
        return;
      }
      append(text, 'Vous', response.sentAt, true);
      if (input.value.trim() === text) input.value = '';
      $('chat-status').textContent = 'Message transmis au salon';
    });
  });
  connected(false);
  return {
    connected,
    receive(data) {
      if (typeof data?.text === 'string' && data.text.length <= 1000) append(data.text, getPeerName(), data.sentAt);
    },
    reset() { generation++; pending = false; input.value = ''; log.replaceChildren(); $('chat-new').hidden = true; connected(false); }
  };
}
