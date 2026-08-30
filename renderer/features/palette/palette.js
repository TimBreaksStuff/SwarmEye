/* Palette: one box (Ctrl+K) that reaches every workspace, agent, task, skill,
 * view and option, plus the verbs that act on them.
 *
 * With ten panes across five workspaces, the rail plus Tab cycling is the
 * bottleneck — this is the keyboard route to anything.
 *
 * It owns matching, rendering and keys only. The item list is built by app.js
 * (which is the one place that knows the app's state and what each entry
 * should do) and handed over through `getItems`, rebuilt on every open so a
 * closed agent or a finished task is never offered. Exposes window.Palette. */

export const Palette = (() => {
  const popEl = document.getElementById('palette-pop');
  const inputEl = document.getElementById('palette-input');
  const listEl = document.getElementById('palette-list');
  const emptyEl = document.getElementById('palette-empty');

  const MAX_SHOWN = 40; // a list longer than this is a search, not a menu

  let getItems = () => [];
  let items = [];
  let shown = [];
  let sel = 0;

  /* Subsequence match, scored so the obvious candidate sorts first.
   *
   * Every character of the query must appear in order; beyond that the score
   * rewards what a person actually means when they type three letters —
   * matches at the start of a word ("tb" → "Task Board") and runs of adjacent
   * characters ("tas" matches "Task Board") — and penalises how far it had to skip.
   * Returns -1 for no match, so 0 stays a legitimate (if poor) score. */
  function score(text, query) {
    if (!query) return 0;
    const hay = text.toLowerCase();
    let i = 0;
    let points = 0;
    let run = 0;
    for (const ch of query) {
      const at = hay.indexOf(ch, i);
      if (at < 0) return -1;
      const wordStart = at === 0 || /[\s\-_/·.]/.test(hay[at - 1]);
      if (wordStart) points += 8;
      if (at === i && i > 0) { run += 1; points += 4 + run; } else run = 0;
      points -= Math.min(4, at - i); // a big skip is a worse match, but only so much
      i = at + 1;
    }
    // a short label that used most of its characters beats a long one that didn't
    return points + Math.max(0, 12 - text.length / 4);
  }

  function refilter() {
    const q = inputEl.value.trim().toLowerCase();
    shown = items
      .map((it) => ({ it, s: score(it.label + ' ' + (it.hint || ''), q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_SHOWN)
      .map((r) => r.it);
    sel = 0;
    render();
  }

  function render() {
    listEl.innerHTML = '';
    emptyEl.hidden = shown.length > 0;
    shown.forEach((it, idx) => {
      const row = document.createElement('button');
      row.className = 'palette-row' + (idx === sel ? ' sel' : '');
      const group = document.createElement('span');
      group.className = 'palette-group';
      group.textContent = it.group;
      const label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = it.label;
      const hint = document.createElement('span');
      hint.className = 'palette-hint';
      hint.textContent = it.hint || '';
      row.append(group, label, hint);
      // mousedown, not click: the input's blur would close the popover first
      row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(idx); });
      listEl.appendChild(row);
    });
    const active = listEl.children[sel];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!shown.length) return;
    sel = (sel + delta + shown.length) % shown.length;
    render();
  }

  function choose(idx) {
    const it = shown[idx];
    if (!it) return;
    close(); // before run(): an entry that opens another view must not be undone
    it.run();
  }

  function open() {
    items = getItems() || [];
    inputEl.value = '';
    popEl.hidden = false;
    refilter();
    inputEl.focus();
  }

  /* Put text in the box as if it had been typed — how the top bar's mic
   * dictates into the palette. Opens it first if it isn't up. */
  function setQuery(text) {
    if (popEl.hidden) open();
    inputEl.value = text;
    refilter();
  }

  function close() {
    if (popEl.hidden) return;
    popEl.hidden = true;
    listEl.innerHTML = '';
    items = [];
    shown = [];
  }

  function init(h) {
    getItems = (h && h.getItems) || (() => []);
    inputEl.addEventListener('input', refilter);
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // no agent cycling or pane shortcuts while filtering
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.addEventListener('click', (e) => {
      // [data-palette-keep] opts out: the top bar's mic opens the palette and
      // its own click would otherwise close it again on the way back up
      if (!popEl.hidden && !popEl.contains(e.target) && !e.target.closest('[data-palette-keep]')) close();
    });
  }

  return { init, open, close, setQuery, toggle: () => (popEl.hidden ? open() : close()), isOpen: () => !popEl.hidden };
})();
