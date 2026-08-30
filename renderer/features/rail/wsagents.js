/* Workspace agent lists — the expanded rail's workspace rows fold open into
 * the agents running inside them.
 *
 * A row is an activity indicator plus a very short summary of what that agent
 * was asked to do; clicking one selects the workspace and focuses the pane.
 * The summary is derived from the agent's launch prompt here in the renderer
 * (no model call, nothing injected into the agent — see CLAUDE.md).
 *
 * topbar.js owns the workspace tiles and calls in twice: attach() when it
 * rebuilds a tile, sync() on every chrome beat. */

import { elt } from '../../lib/dom.js';
import { Icons } from '../../lib/icons.js';

export const WsAgents = (() => {
  const KEY = 'swarmeye.wsAgents'; // workspace ids the user folded *shut*

  // default is open, so only the closed ones need remembering
  let closed = new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(raw)) closed = new Set(raw);
  } catch { /* a corrupt entry just means "everything open" */ }

  const save = () => localStorage.setItem(KEY, JSON.stringify([...closed]));

  // wsId -> {list, caret}, so a caret click can repaint its own list alone
  const groups = new Map();
  // sessionId -> {src, text}: the summary is only recomputed when the prompt
  // behind it changes, not on every beat
  const summaries = new Map();

  /* ---- the row's activity indicator ----
   * Both indicators are built once and live in the row: the dot for idle,
   * attention and exited, and the shared busy equalizer (.sw-busy — the same
   * one the pane header runs) for working. rail.css shows whichever the row's
   * status class calls for, so a status flip writes no DOM here. */
  function indicator() {
    const ind = elt('span', 'ws-agent-ind');
    const busy = elt('span', 'sw-busy');
    for (let i = 0; i < 5; i++) {
      const bar = elt('span', 'sw-busy-bar');
      bar.style.animationDelay = `${i * 0.1}s`;
      busy.appendChild(bar);
    }
    ind.append(elt('span', 'ws-agent-dot'), busy);
    return ind;
  }

  /* ---- summary ----
   * The launch prompt, cut down to something that fits a 200px row. Not a
   * paraphrase: leading slash-commands and politeness go, the first few real
   * words stay. */
  const POLITE = /^(?:hi|hey|hello|ok|okay|so|now|please|kindly|pls|can you|could you|would you|i want you to|i'd like you to|i would like you to|let's|lets|we need to|you should|go ahead and|help me)\b[\s,:-]*/i;

  function summarize(text, fallback) {
    let s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return fallback;
    // "/plan refactor the reaper" -> "refactor the reaper", but a bare
    // "/clear" keeps its name
    const slash = /^\/[\w:-]+\s+(.+)$/.exec(s);
    if (slash) s = slash[1];
    s = s.replace(/[`*_#>]/g, '').trim();
    // politeness can stack ("hey, could you please …")
    for (let i = 0; i < 3; i += 1) {
      const cut = s.replace(POLITE, '');
      if (cut === s) break;
      s = cut;
    }
    s = s.trim();
    if (!s) return fallback;
    if (s.length <= 34) return s;
    const head = s.slice(0, 34);
    const sp = head.lastIndexOf(' ');
    return (sp > 14 ? head.slice(0, sp) : head).replace(/[\s,.;:-]+$/, '') + '…';
  }

  function summaryFor(pane) {
    const src = pane.initialCommandText || '';
    const hit = summaries.get(pane.session.id);
    if (hit && hit.src === src) return hit.text;
    const text = summarize(src, pane.session.agentName);
    summaries.set(pane.session.id, { src, text });
    return text;
  }

  /* ---- fold state ---- */
  function isOpen(wsId) { return !closed.has(wsId); }

  function paint(wsId) {
    const g = groups.get(wsId);
    if (!g) return;
    const open = isOpen(wsId);
    g.list.classList.toggle('collapsed', !open);
    g.caret.classList.toggle('shut', !open);
    g.caret.setAttribute('aria-expanded', String(open));
    g.caret.dataset.tip = open ? 'Hide the agents in this workspace' : 'Show the agents in this workspace';
  }

  // a workspace with no agents has nothing to fold, so its tile stays a plain
  // select and its caret is hidden (see sync)
  function toggle(wsId) {
    const g = groups.get(wsId);
    if (!g || g.empty) return;
    if (closed.has(wsId)) closed.delete(wsId); else closed.add(wsId);
    save();
    paint(wsId);
  }

  /* ---- wiring ----
   * topbar.js rebuilds every tile at once, so the element registry is dropped
   * whole rather than diffed. The fold state above outlives it. */
  function reset() { groups.clear(); }

  /* Called while topbar.js builds a workspace tile: the caret goes in the
   * tile, the returned list becomes the tile's next sibling. */
  function attach(tile, wsId) {
    // a span, not a button: the tile it lives in is itself a <button>, and a
    // nested one is invalid markup that screen readers refuse to reach
    const caret = elt('span', 'ws-caret');
    caret.setAttribute('role', 'button');
    caret.tabIndex = 0;
    Icons.set(caret, 'chevron');
    caret.addEventListener('click', (e) => {
      e.stopPropagation(); // the tile's own click selects the workspace
      toggle(wsId);
    });
    caret.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      toggle(wsId);
    });
    tile.prepend(caret);
    // the whole tile folds too — the caret is only the affordance for it.
    // Only the workspace that is already selected folds on a click: clicking
    // a different one just moves the selection and leaves every list as it was.
    tile.addEventListener('click', () => {
      if (tile.classList.contains('selected')) toggle(wsId);
    });

    const list = elt('div', 'ws-agents');
    groups.set(wsId, { list, caret, empty: true });
    paint(wsId);
    return list;
  }

  /* Reconciled in place rather than rebuilt: this runs on every status flip,
   * and wiping the rows would drop the one the cursor is resting on — Chromium
   * fires no mouseout for a removed node, so its tooltip would orphan. */
  function sync(wsId, panes, onOpen) {
    const g = groups.get(wsId);
    if (!g) return;
    const { list } = g;
    list.hidden = panes.length === 0;
    g.empty = panes.length === 0;
    g.caret.classList.toggle('empty', g.empty);
    while (list.children.length > panes.length) list.lastChild.remove();
    while (list.children.length < panes.length) {
      const row = document.createElement('button');
      row.className = 'ws-agent';
      row.type = 'button';
      row.append(indicator(), elt('span', 'ws-agent-name'));
      row.addEventListener('click', () => {
        if (row.dataset.sid && row.__onOpen) row.__onOpen(row.dataset.sid);
      });
      list.appendChild(row);
    }
    panes.forEach((pane, i) => {
      const row = list.children[i];
      row.__onOpen = onOpen;
      const st = pane.exited ? 'exited'
        : pane.status === 'working' ? 'working'
        : pane.status === 'attention' ? 'attn'
        : 'idle';
      const text = summaryFor(pane);
      // one signature per row: nothing below is written unless something moved
      const sig = `${pane.session.id}|${st}|${text}`;
      if (row.dataset.sig === sig) return;
      row.dataset.sig = sig;
      row.dataset.sid = pane.session.id;
      row.className = 'ws-agent ws-agent-' + st;
      row.dataset.tip = pane.session.agentName;
      if (pane.initialCommandText) row.dataset.tipSecondary = pane.initialCommandText;
      else delete row.dataset.tipSecondary;
      row.children[1].textContent = text;
    });
  }

  return { reset, attach, sync };
})();
