// Selection is reusable after a failed capture, but each capture needs a new ticket.
function createCaptureSources(getSources, windows = null) {
  let offered = new Set();
  let selected = null;
  let generation = 0;
  let extended = false;
  return {
    async list(includeWindows = false) {
      const version = ++generation;
      selected = null;
      extended = includeWindows && Boolean(windows);
      const [found, additional] = await Promise.all([
        getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true }),
        extended ? windows.listWindows() : []
      ]);
      if (version !== generation) return [];
      const merged = new Map(found.map((source) => [source.id, source]));
      const handles = new Set(found.filter((source) => source.id.startsWith('window:')).map((source) => source.id.split(':')[1]));
      for (const source of additional) if (!handles.has(source.id.split(':')[1])) merged.set(source.id, source);
      offered = new Set(merged.keys());
      return [...merged.values()].map((source) => ({ id: source.id, name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window', minimized: source.minimized === true,
        thumbnail: source.thumbnail?.toDataURL() || source.appIcon?.toDataURL() || '' }));
    },
    async select(id, systemAudio = true) {
      selected = null;
      if (typeof id !== 'string' || !offered.has(id)) throw new Error('Choisissez une source dans la liste actualisée.');
      const version = generation;
      const found = await getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      if (version !== generation) throw new Error('La liste a changé. Choisissez à nouveau une source.');
      let source = found.find((item) => item.id === id);
      if (!source && extended) {
        source = (await windows.listWindows()).find((item) => item.id === id);
        if (source?.minimized) await windows.restoreWindow(id);
      }
      if (version !== generation) throw new Error('La liste a changé. Choisissez à nouveau une source.');
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
