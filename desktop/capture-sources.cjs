// Selection is reusable after a failed capture, but each capture needs a new ticket.
function createCaptureSources(getSources) {
  let offered = new Set();
  let selected = null;
  let generation = 0;
  return {
    async list() {
      const version = ++generation;
      selected = null;
      const found = await getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      if (version !== generation) return [];
      offered = new Set(found.map((source) => source.id));
      return found.map((source) => ({ id: source.id, name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: source.thumbnail.toDataURL() }));
    },
    async select(id, systemAudio = true) {
      selected = null;
      if (typeof id !== 'string' || !offered.has(id)) throw new Error('Choisissez une source dans la liste actualisée.');
      const version = generation;
      const found = await getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      if (version !== generation) throw new Error('La liste a changé. Choisissez à nouveau une source.');
      const source = found.find((item) => item.id === id);
      if (!source) throw new Error('Cette fenêtre a été fermée. Actualisez la liste et choisissez une autre source.');
      selected = { source, systemAudio: systemAudio === true };
    },
    consume(audioRequested, platform) {
      const ticket = selected;
      selected = null;
      if (!ticket) return null;
      return platform === 'win32' && audioRequested && ticket.systemAudio
        ? { video: ticket.source, audio: 'loopback' } : { video: ticket.source };
    }
  };
}
module.exports = { createCaptureSources };
