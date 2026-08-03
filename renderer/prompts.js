/* renderer/prompts.js — what you have typed at agents, per workspace.
 *
 * A pane is a raw terminal and Claude Code owns Up/Down inside it, so this is
 * not a second key-driven history: it is a list the palette offers, and
 * choosing one types it into the focused agent without submitting.
 *
 * Renderer-only on purpose — it is a convenience over the same lines pane.js
 * already reports for the "last command" header, so it rides localStorage and
 * costs no IPC and no config field. Exposes window.Prompts. */
const Prompts = (() => {
  const KEY = (wsId) => 'swarmeye.prompts.' + wsId;
  const MAX = 50; // a longer list is scrollback, not a shortlist
  const MAX_LEN = 2000;
  let enabled = true;

  function list(wsId) {
    if (!wsId) return [];
    try {
      const raw = JSON.parse(localStorage.getItem(KEY(wsId)));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  /* Newest first, and a repeat of something already remembered moves up
   * rather than filling the list with the same line. */
  function record(wsId, text) {
    const line = String(text || '').trim();
    if (!enabled || !wsId || !line || line.length > MAX_LEN) return;
    const next = [line, ...list(wsId).filter((p) => p !== line)].slice(0, MAX);
    try { localStorage.setItem(KEY(wsId), JSON.stringify(next)); } catch { /* quota — drop it */ }
  }

  function clear(wsId) {
    if (wsId) localStorage.removeItem(KEY(wsId));
  }

  return { list, record, clear, setEnabled: (on) => { enabled = on; } };
})();
window.Prompts = Prompts;
