/* Notes: the workspace notebook (.swarmeye/notes.md) in a popover.
 *
 * What one agent learned about a repo, so the next one starts with it instead
 * of rediscovering it. Every agent launched in a workspace that has a non-empty
 * notes file is told the path (main/sessions.js NOTES_PROMPT) — a pointer, not
 * the contents, so a long notebook costs one line of context rather than being
 * re-sent on every turn of every agent.
 *
 * Saving is explicit. An editor that wrote on every keystroke would have the
 * file change under an agent that was reading it. Exposes window.Notes. */

const Notes = (() => {
  const popEl = document.getElementById('notes-pop');
  const titleEl = document.getElementById('notes-title');
  const textEl = document.getElementById('notes-text');
  const hintEl = document.getElementById('notes-hint');
  const saveBtn = document.getElementById('notes-save');
  const closeBtn = document.getElementById('notes-close');

  let wsId = null;
  let loaded = ''; // what is on disk, to know whether anything actually changed
  let toast = () => {};

  const dirty = () => textEl.value !== loaded;

  function syncHint() {
    if (dirty()) {
      hintEl.textContent = 'unsaved — Ctrl+Enter to save';
      hintEl.classList.add('warn');
      return;
    }
    hintEl.classList.remove('warn');
    hintEl.textContent = loaded
      ? 'every agent started here is told to read this file'
      : 'empty — while it stays empty, agents are not pointed at it';
  }

  async function open(ws) {
    wsId = ws.id;
    titleEl.textContent = 'Notes · ' + ws.name;
    textEl.value = '';
    loaded = '';
    hintEl.textContent = 'loading…';
    hintEl.classList.remove('warn');
    popEl.hidden = false;
    const res = await window.swarm.readNotes(ws.id);
    // a second open while this one was in flight owns the box now
    if (wsId !== ws.id || popEl.hidden) return;
    loaded = (res && res.ok && res.text) || '';
    textEl.value = loaded;
    syncHint();
    textEl.focus();
  }

  async function save() {
    if (!wsId || !dirty()) return;
    const text = textEl.value;
    const res = await window.swarm.writeNotes(wsId, text);
    if (!res || !res.ok) {
      toast('could not save notes: ' + ((res && res.reason) || 'unknown'));
      return;
    }
    loaded = text;
    syncHint();
    toast('notes saved');
  }

  /* Closing with unsaved text would silently lose it, and this popover shuts
   * on any outside click — so an edited box saves on the way out rather than
   * asking. Nothing here is destructive; the file is the only copy. */
  function close() {
    if (popEl.hidden) return;
    if (dirty()) save();
    popEl.hidden = true;
    wsId = null;
  }

  function init(h) {
    toast = (h && h.toast) || (() => {});
    textEl.addEventListener('input', syncHint);
    textEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // no agent cycling or app shortcuts while writing
      if (e.key === 'Enter' && modHeld(e)) { e.preventDefault(); save(); } // modHeld: app.js's one modifier rule
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    saveBtn.addEventListener('click', save);
    closeBtn.addEventListener('click', close);
    document.addEventListener('click', (e) => {
      if (!popEl.hidden && !popEl.contains(e.target)) close();
    });
  }

  return { init, open, close, isOpen: () => !popEl.hidden };
})();

window.Notes = Notes;
