/* App state + wiring. The grid shows only the selected workspace's agents;
 * agents in other workspaces keep running hidden. */

let maxAgents = 10; // cap on simultaneous agents — loaded from config at boot, adjustable in the ⌨ options
let autoUsageLimit = 85; // usage-% ceiling for auto-scheduled tasks — loaded at boot, adjustable in the ⌨ options

const grid = new GridController(document.getElementById('grid'));
const gridWrapEl = document.getElementById('grid-wrap');
const emptyState = document.getElementById('empty-state');
const toastEl = document.getElementById('toast');
// the swarm view's own wiring lives further down, but renderSwarmView() is
// reached from renderNotifs() while this file is still evaluating — these two
// have to exist by then
const swarmViewEl = document.getElementById('swarm-view');
const swarmViewBtn = document.getElementById('swarm-view-btn');

const state = {
  workspaces: [],
  selectedWorkspaceId: null,
  panes: new Map(), // sessionId -> Pane (all workspaces)
  lastFocused: null,
  git: {}, // workspaceId -> {branch, dirty}
  tasks: [], // task board: {id, text, workspaceId, mode, startMode, priority, status, paneId, createdAt, startedAt, completedAt}
  archivedTasks: [], // tasks removed from the board, viewable/purgeable in the board's Archive view
};

// pty output that arrives before its pane exists
const pendingOutput = new Map();

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function panesForWs(wsId) {
  return [...state.panes.values()].filter((p) => p.session.workspaceId === wsId);
}

/* state.panes keeps exited panes around (closed only by an explicit ✕ click,
 * so their output stays reviewable) — main's own session cap forgets them the
 * instant the pty exits (sessions.js _handleExit), so counting raw pane size
 * here drifts high and can wedge the cap forever. Mirror main: don't count
 * exited panes as occupying a slot. */
function liveAgentCount() {
  let n = 0;
  for (const p of state.panes.values()) if (!p.exited) n += 1;
  return n;
}

/* status flips arrive per pane per hook event — with many busy agents that
 * is several calls a second, each rebuilding the pills/counter DOM. Coalesce
 * to at most one real rebuild per animation frame. */
let chromeQueued = false;
function syncChrome() {
  if (chromeQueued) return;
  chromeQueued = true;
  requestAnimationFrame(() => {
    chromeQueued = false;
    syncChromeNow();
  });
}

function syncChromeNow() {
  const counts = {};
  for (const pane of state.panes.values()) {
    const id = pane.session.workspaceId;
    counts[id] = counts[id] || { n: 0, attn: false };
    counts[id].n += 1;
    if (pane.status === 'attention') counts[id].attn = true;
  }
  Topbar.renderWorkspaces(orderedWorkspaces(), state.selectedWorkspaceId, counts, {
    onSelect: (id) => { toggleBoard(false); selectWorkspace(id); }, // a pill always means "show me the grid"
    onRemove: removeWorkspace,
    onReorder: reorderWorkspaces,
    onRename: renameWorkspace,
    onSetColor: setWorkspaceColor,
    onSetPinned: setWorkspacePinned,
  });
  const wsColor = {};
  for (const ws of state.workspaces) wsColor[ws.id] = ws.color;
  Topbar.renderSwarmMap([...state.panes.values()], maxAgents, notifHandlers.onOpen, wsColor);
  Topbar.updateAgentCap(liveAgentCount(), maxAgents);
  renderSwarmView(); // same coalesced beat as the rest of the chrome
  emptyState.style.display = grid.panes.length ? 'none' : '';
  reattachAllBtn.hidden = ![...state.panes.values()].some((p) => p.detached);
}

function syncGrid() {
  grid.setPanes(panesForWs(state.selectedWorkspaceId), state.selectedWorkspaceId);
  if (state.lastFocused && !grid.panes.includes(state.lastFocused)) state.lastFocused = null;
  syncRendererReclaim();
  requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
}

/* ---- renderer reclaim for workspaces nobody is looking at ----
 * Agents in other workspaces keep running, and each pane holds a WebGL
 * context for its terminal. Chromium caps a page at ~16 of those, so a busy
 * swarm across a few workspaces walks into contexts being killed under the
 * running app. A pane that has been off screen for a minute gives its context
 * back (xterm falls back to the DOM renderer — nothing is lost but GPU
 * acceleration nobody can see) and takes it again the moment it's shown. */
const RENDERER_RECLAIM_MS = 60000;
const reclaimTimers = new Map(); // sessionId -> pending drop

function syncRendererReclaim() {
  const visible = new Set(grid.panes.map((p) => p.session.id));
  for (const [id, pane] of state.panes) {
    const timer = reclaimTimers.get(id);
    if (visible.has(id)) {
      if (timer) { clearTimeout(timer); reclaimTimers.delete(id); }
      pane.restoreRenderer();
    } else if (!timer && !pane.rendererDropped) {
      reclaimTimers.set(id, setTimeout(() => {
        reclaimTimers.delete(id);
        const p = state.panes.get(id);
        if (p && !grid.panes.includes(p)) p.dropRenderer();
      }, RENDERER_RECLAIM_MS));
    }
  }
  // panes closed while their drop was pending
  for (const [id, timer] of reclaimTimers) {
    if (!state.panes.has(id)) { clearTimeout(timer); reclaimTimers.delete(id); }
  }
}

async function selectWorkspace(id) {
  if (id === state.selectedWorkspaceId) return;
  state.selectedWorkspaceId = id;
  await window.swarm.selectWorkspace(id);
  Preview.setWorkspace(id); // each workspace remembers its own preview address
  syncGrid();
  syncChrome();
}

/* removing a workspace kills its agents — arm/confirm like the pane ✕ */
const pendingRemove = { id: null, timer: null };

async function removeWorkspace(id) {
  const agents = panesForWs(id);
  if (agents.length && pendingRemove.id !== id) {
    pendingRemove.id = id;
    clearTimeout(pendingRemove.timer);
    pendingRemove.timer = setTimeout(() => { pendingRemove.id = null; }, 3000);
    const running = agents.filter((p) => !p.exited || p.detached).length;
    toast(running
      ? `this workspace has ${running} running agent${running > 1 ? 's' : ''} — click ✕ again to remove it and kill them`
      : 'click ✕ again to remove this workspace and its exited panes');
    return;
  }
  clearTimeout(pendingRemove.timer);
  pendingRemove.id = null;

  for (const pane of agents) {
    // detached panes read as exited but their tmux agent is still running —
    // kill those too, or removing the workspace would orphan live agents
    if (!pane.exited || pane.detached) window.swarm.killSession(pane.session.id);
    if (state.lastFocused === pane) state.lastFocused = null;
    state.panes.delete(pane.session.id);
    grid.remove(pane); // disposes; no-op removal if the pane wasn't visible
  }

  const res = await window.swarm.removeWorkspace(id);
  state.workspaces = res.workspaces;
  state.selectedWorkspaceId = res.selectedWorkspaceId;
  syncGrid();
  syncChrome();
  toast('workspace removed');
}

async function renameWorkspace(id, name) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (ws) ws.name = name; // optimistic; syncChrome() below repaints the pill
  await window.swarm.renameWorkspace(id, name);
  syncChrome();
}

/* Pinned workspaces are drawn (and cycled through) first; inside each group
 * the drag order in state.workspaces is preserved, so unpinning a workspace
 * drops it back exactly where it was rather than to the end. */
function orderedWorkspaces() {
  return [...state.workspaces.filter((w) => w.pinned), ...state.workspaces.filter((w) => !w.pinned)];
}

async function setWorkspacePinned(id, pinned) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (ws) ws.pinned = pinned; // optimistic; syncChrome() below re-sorts the rail
  await window.swarm.setWorkspacePinned(id, pinned);
  syncChrome();
}

async function setWorkspaceColor(id, color) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (ws) ws.color = color; // optimistic; syncChrome() repaints tiles + swarm map
  await window.swarm.setWorkspaceColor(id, color);
  syncChrome();
}

/* drag-reorder: move dragId before/after targetId, persist the new order */
function reorderWorkspaces(dragId, targetId, before) {
  const list = state.workspaces;
  const from = list.findIndex((w) => w.id === dragId);
  if (from === -1) return;
  const [moved] = list.splice(from, 1);
  let to = list.findIndex((w) => w.id === targetId);
  if (to === -1) { list.splice(from, 0, moved); return; }
  if (!before) to += 1;
  list.splice(to, 0, moved);
  syncChrome();
  window.swarm.reorderWorkspaces(list.map((w) => w.id));
}

async function addWorkspace() {
  const res = await window.swarm.addWorkspace();
  if (res.canceled) return;
  state.workspaces = res.workspaces;
  if (res.selectedWorkspaceId) state.selectedWorkspaceId = res.selectedWorkspaceId;
  syncGrid();
  syncChrome();
  // pop the new workspace's flyout so its colour can be picked straight away
  // (runs after syncChrome's rAF has built the tile)
  if (res.workspace) requestAnimationFrame(() => Topbar.openWorkspaceFlyout(res.workspace.id));
}

function cycleWorkspace(dir) {
  // the rail's own order, pinned first — Ctrl+Tab must walk what's on screen
  const list = orderedWorkspaces();
  const n = list.length;
  if (n < 2) return;
  const i = list.findIndex((w) => w.id === state.selectedWorkspaceId);
  const next = list[((i === -1 ? 0 : i) + dir + n) % n];
  selectWorkspace(next.id);
}

function focusedPane() {
  return state.lastFocused && grid.panes.includes(state.lastFocused)
    ? state.lastFocused
    : grid.panes[0] || null;
}

function cycleAgent(dir) {
  const n = grid.panes.length;
  if (!n) return;
  const cur = focusedPane();
  const i = grid.panes.indexOf(cur);
  grid.panes[((i === -1 ? 0 : i) + dir + n) % n].focus();
}

/* ---- shortcuts ----
 * MOD is Ctrl on Windows and Cmd on macOS (where Ctrl works too).
 *
 * Tab                  next agent in this workspace
 *                      (Shift+Tab and Ctrl+I pass through to the terminal:
 *                       claude uses Shift+Tab, Ctrl+I types a literal tab)
 * Ctrl+Tab / +Shift    next / previous workspace — Ctrl on both platforms,
 *                      since Cmd+Tab is the macOS app switcher
 * MOD+'+' / '-' / 0    font size of the focused pane (bigger/smaller/reset)
 * MOD+N                new agent
 * MOD+X                close focused agent (again within 5s: confirm kill)
 * MOD+T                task board, new-task form (dashboard)
 * MOD+R                dictate — mic in the focused pane, or the task-board
 *                      form's mic if the board is open
 * MOD+Shift+1..9,0     focus visible pane N (again: toggle maximize)
 * MOD+Shift+M          maximize/restore focused pane
 * MOD+Shift+F          search in focused pane
 * MOD+Shift+G          search across all agents
 * MOD+Shift+B          task board
 * MOD+Shift+S          swarm view
 *
 * Terminals get the pure predicate (via attachCustomKeyEventHandler) so
 * xterm ignores these keys; execution happens exactly once, in the
 * document-level keydown listener the event bubbles up to. */
const IS_MAC = window.swarm.isMac;

/* Windows must not treat the Windows key as the modifier — Chromium reports
 * it as metaKey, so accepting metaKey there would make Win+N spawn an agent. */
function modHeld(e) {
  return IS_MAC ? (e.metaKey || e.ctrlKey) : e.ctrlKey;
}

function isShortcut(e) {
  if (e.type !== 'keydown' || e.altKey) return false;
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.shiftKey) return true;
  if (e.key === 'Tab') return e.ctrlKey && !e.metaKey;
  if (!modHeld(e)) return false;
  if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') return true;
  if (e.key === '0' && !e.shiftKey) return true;
  if (e.code === 'KeyN' && !e.shiftKey) return true;
  if (e.code === 'KeyX' && !e.shiftKey) return true;
  if (e.code === 'KeyT' && !e.shiftKey) return true;
  if (e.code === 'KeyR' && !e.shiftKey) return true;
  if (!e.shiftKey) return false;
  return e.code === 'KeyM' || e.code === 'KeyF' || e.code === 'KeyG' || e.code === 'KeyB'
    || e.code === 'KeyS' || e.code === 'KeyE' || /^Digit\d$/.test(e.code);
}

function handleShortcut(e) {
  if (!isShortcut(e)) return false;

  if (e.key === 'Tab') {
    if (e.ctrlKey) cycleWorkspace(e.shiftKey ? -1 : 1);
    else cycleAgent(1);
    return true;
  }

  const focused = focusedPane();

  if (e.key === '+' || e.key === '=') { if (focused) focused.setFontSize(focused.term.options.fontSize + 1); return true; }
  if (e.key === '-' || e.key === '_') { if (focused) focused.setFontSize(focused.term.options.fontSize - 1); return true; }
  if (e.key === '0' && !e.shiftKey) { if (focused) focused.setFontSize(Pane.DEFAULT_FONT_SIZE); return true; }

  if (e.code === 'KeyN' && !e.shiftKey) { addAgent(); return true; }
  if (e.code === 'KeyX' && !e.shiftKey) { if (focused) focused.requestClose(); return true; }
  if (e.code === 'KeyT' && !e.shiftKey) { toggleBoard(true); return true; }
  if (e.code === 'KeyR' && !e.shiftKey) {
    if (!boardEl.hidden && Board.isFormOpen()) Board.toggleDictation();
    else if (focused) focused.toggleDictation();
    return true;
  }
  if (e.code === 'KeyM' && focused) { grid.toggleMax(focused); return true; }
  if (e.code === 'KeyF' && focused) { focused.toggleSearch(); return true; }
  if (e.code === 'KeyG') { toggleGlobalSearch(gsearchEl.hidden); return true; }
  if (e.code === 'KeyB') { toggleBoard(boardEl.hidden); return true; }
  if (e.code === 'KeyS') { toggleSwarmView(swarmViewEl.hidden); return true; }
  if (e.code === 'KeyE') { if (Messenger.isOpen()) Messenger.close(); else Messenger.open(); return true; }

  const m = /^Digit(\d)$/.exec(e.code);
  if (m) {
    const n = m[1] === '0' ? 10 : Number(m[1]);
    const pane = grid.panes[n - 1];
    if (pane) {
      if (pane === focused && pane.el.classList.contains('focused')) grid.toggleMax(pane);
      else pane.focus();
    }
    return true;
  }
  return false;
}

/* Escape closes the innermost thing that is open — order matters, so this is
 * a list rather than a set: the first open one wins and nothing below it
 * sees the key. Elements are looked up lazily; several are declared further
 * down this file. */
const ESCAPABLE = [
  [() => gsearchEl, () => toggleGlobalSearch(false)],
  [() => msgPopEl, () => Messenger.close()],
  [() => kbdShortcutsPop, () => { kbdShortcutsPop.hidden = true; }],
  [() => kbdPop, () => { kbdPop.hidden = true; }],
  // above the notification entries: the transcript modal is opened from them,
  // so it has to be the innermost thing Escape closes
  [() => document.getElementById('hist-modal'), () => History.closeModal()],
  [() => notifPopEl, () => closeNotifPop()],
  [() => notifPanelEl, () => { notifPanelEl.hidden = true; }],
  [() => sessionViewEl, () => Board.closeSessionView()],
  [() => boardEl, () => toggleBoard(false)],
  [() => skillsEl, () => toggleSkills(false)],
  [() => historyEl, () => toggleHistory(false)],
  [() => swarmViewEl, () => toggleSwarmView(false)],
];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const [el, close] of ESCAPABLE) {
      if (!el().hidden) { close(); return; }
    }
  }
  if (handleShortcut(e)) e.preventDefault();
});

/* keyboard-shortcuts / options popover */
const kbdPop = document.getElementById('kbd-pop');
const kbdHelpBtn = document.getElementById('kbd-help');
kbdHelpBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (kbdPop.hidden) {
    closeNotifPop(); // popovers are mutually exclusive
    // anchor the popover below the gear button — it sits in the top bar's
    // icon group, so it drops down right-aligned with the button
    const r = kbdHelpBtn.getBoundingClientRect();
    kbdPop.style.bottom = '';
    kbdPop.style.left = '';
    kbdPop.style.top = Math.round(r.bottom + 8) + 'px';
    kbdPop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  }
  kbdPop.hidden = !kbdPop.hidden;
  if (kbdPop.hidden) kbdShortcutsPop.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!kbdPop.hidden && !kbdPop.contains(e.target) && !kbdShortcutsPop.contains(e.target)) kbdPop.hidden = true;
  if (!kbdShortcutsPop.hidden && !kbdShortcutsPop.contains(e.target) && !kbdShortcutsBtn.contains(e.target)) kbdShortcutsPop.hidden = true;
});

/* keyboard-shortcuts submenu — a nested popover launched from a button inside
 * the Options popover. It anchors beside kbd-pop itself rather than below the
 * button: the button sits near the bottom of kbd-pop's content, so opening
 * downward would risk running off-screen the way the Archived popover once
 * did. kbd-pop hangs off the right edge now, so this one opens to its left. */
const kbdShortcutsPop = document.getElementById('kbd-shortcuts-pop');
const kbdShortcutsBtn = document.getElementById('kbd-shortcuts-btn');
kbdShortcutsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (kbdShortcutsPop.hidden) {
    const popRect = kbdPop.getBoundingClientRect();
    const btnRect = kbdShortcutsBtn.getBoundingClientRect();
    kbdShortcutsPop.style.left = '';
    kbdShortcutsPop.style.right = Math.min(
      Math.round(window.innerWidth - popRect.left + 12),
      Math.max(8, window.innerWidth - 408)
    ) + 'px';
    kbdShortcutsPop.style.bottom = Math.max(8, Math.round(window.innerHeight - btnRect.bottom)) + 'px';
  }
  kbdShortcutsPop.hidden = !kbdShortcutsPop.hidden;
});

/* notification center: history of agent events (finished / waiting / exited) */
const notifPopEl = document.getElementById('notif-pop');
const notifs = []; // newest first: {paneId, agent, ws, kind, text, time}
let notifUnread = 0;
const NOTIF_MAX = 50;

const notifPanelEl = document.getElementById('notif-panel');
const notifHandlers = {
  onClear() {
    notifs.length = 0;
    notifUnread = 0;
    renderNotifs();
  },
  onExpand() {
    closeNotifPop();
    notifPanelEl.hidden = false;
  },
  async onOpen(paneId) {
    const pane = state.panes.get(paneId);
    if (!pane) { toast('this agent is gone'); return; }
    closeNotifPop();
    toggleBoard(false);
    if (pane.session.workspaceId !== state.selectedWorkspaceId) {
      await selectWorkspace(pane.session.workspaceId);
    }
    pane.focus();
  },
  // the agent's own Claude conversation, in the same modal the History screen
  // uses — the pane doesn't have to still exist for this to work
  onTranscript(n) {
    if (!n.transcriptId) { toast('no transcript recorded for this agent'); return; }
    closeNotifPop();
    History.openTranscript({ workspaceId: n.wsId, id: n.transcriptId, preview: `${n.agent} · ${n.ws}` });
  },
  onApprove(paneId, always) {
    const pane = state.panes.get(paneId);
    if (!pane) { toast('this agent is gone'); return; }
    if (!pane.respondToPrompt('yes', always)) toast("couldn't read the prompt — open the pane");
  },
  onDeny(paneId) {
    const pane = state.panes.get(paneId);
    if (!pane) { toast('this agent is gone'); return; }
    if (!pane.respondToPrompt('no', false)) toast("couldn't read the prompt — open the pane");
  },
};
document.getElementById('notif-panel-close').addEventListener('click', () => { notifPanelEl.hidden = true; });
document.getElementById('notif-panel-clear').addEventListener('click', () => notifHandlers.onClear());

/* drag the panel's left edge to resize it — same handle as the preview dock,
 * width remembered across restarts */
(() => {
  const MIN_WIDTH = 300;
  const handle = document.getElementById('notif-panel-resizer');
  const saved = Number(localStorage.getItem('swarmeye.notifPanelWidth'));
  if (saved >= MIN_WIDTH) notifPanelEl.style.width = saved + 'px';
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = notifPanelEl.getBoundingClientRect().width;
    const onMove = (ev) => {
      const w = Math.max(MIN_WIDTH, Math.min(window.innerWidth - 360, startW + (startX - ev.clientX)));
      notifPanelEl.style.width = Math.round(w) + 'px';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      localStorage.setItem('swarmeye.notifPanelWidth', String(Math.round(notifPanelEl.getBoundingClientRect().width)));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
})();

/* closing the popover marks everything as read — bell back to grey */
function closeNotifPop() {
  if (notifPopEl.hidden) return;
  notifPopEl.hidden = true;
  notifUnread = 0;
  renderNotifs();
}

function renderNotifs() {
  // a 'wait' row only earns its ✓/✕ while its agent still has a yes/no menu
  // up — the row itself is history and outlives the prompt behind it
  for (const n of notifs) {
    const pane = n.kind === 'wait' ? state.panes.get(n.paneId) : null;
    n.canRespond = !!(pane && pane.awaitingPrompt && pane.promptAnswerable);
  }
  Topbar.renderNotifications(notifs, notifUnread, notifHandlers);
  Topbar.renderNotifPanel(notifs, notifHandlers);
}

function pushNotif(pane, kind, text) {
  notifs.unshift({
    paneId: pane.session.id,
    agent: pane.session.agentName,
    ws: pane.session.workspaceName,
    wsId: pane.session.workspaceId,
    transcriptId: pane.transcriptId || null,
    kind,
    text,
    cmd: pane.initialCommandText,
    model: pane.modelLabel || null,
    mode: pane.modeSel.selectedOptions[0].textContent,
    createdAt: pane.session.createdAt || null,
    time: Date.now(),
  });
  if (notifs.length > NOTIF_MAX) notifs.length = NOTIF_MAX;
  if (notifPopEl.hidden) notifUnread += 1;
  renderNotifs();
}

const notifBtnEl = document.getElementById('notif-btn');
notifBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (notifPopEl.hidden) {
    kbdPop.hidden = true; // popovers are mutually exclusive
    kbdShortcutsPop.hidden = true;
    // anchor the popover right below the bell (the top bar can be zoomed)
    const r = notifBtnEl.getBoundingClientRect();
    notifPopEl.style.top = Math.round(r.bottom + 8) + 'px';
    notifPopEl.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    notifPopEl.hidden = false;
  } else {
    closeNotifPop(); // second click on the bell = mark as read
  }
});
document.addEventListener('click', (e) => {
  if (!notifPopEl.hidden && !notifPopEl.contains(e.target)) closeNotifPop();
});
renderNotifs();

const leftbarEl = document.getElementById('leftbar'); // also drives the rail's expand/hover states below

/* The two ± text-size controls (⌨ popover) do the same four things: clamp to
 * 0.7–1.6 in 0.1 steps, scale the elements they own, label the percentage,
 * persist. They differ only in which elements and which storage key.
 *
 * `elements` is a thunk because some of them (gsearch) are declared further
 * down this file — looking them up at click time avoids a TDZ error. */
function makeZoomControl({ storageKey, elements, valueEl, downId, upId }) {
  let zoom = Number(localStorage.getItem(storageKey)) || 1;
  const apply = (z) => {
    zoom = Math.round(Math.max(0.7, Math.min(1.6, z)) * 10) / 10;
    for (const el of elements()) el.style.zoom = zoom;
    valueEl.textContent = Math.round(zoom * 100) + '%';
    localStorage.setItem(storageKey, String(zoom));
  };
  document.getElementById(downId).addEventListener('click', () => apply(zoom - 0.1));
  document.getElementById(upId).addEventListener('click', () => apply(zoom + 0.1));
  apply(zoom);
  return apply;
}

/* menu-bar (top bar + icon rail) scale, plus the sub-menus anchored to it
 * (search, notifications). The options popover is excluded: its text
 * size is owned by "Task board, Skills & Options text size" instead. */
const applyTopbarZoom = makeZoomControl({
  storageKey: 'swarmeye.topbarZoom',
  elements: () => [
    document.getElementById('topbar'),
    leftbarEl,
    document.getElementById('gsearch'),
    document.getElementById('msg-pop'),
    notifPopEl,
  ],
  valueEl: document.getElementById('ui-font-val'),
  downId: 'ui-font-down',
  upId: 'ui-font-up',
});

/* left menu style — collapsed (icons only, hover to preview the expanded
 * view) or expanded (always shows workspace names + usage gauges); the
 * "Small left menu" checkbox in the ⌨ popover, persisted locally. New installs
 * default to expanded (checkbox unchecked). */
let leftbarStyle = localStorage.getItem('swarmeye.leftbarStyle') || 'expanded';
const leftbarSmallToggle = document.getElementById('leftbar-small-toggle');
function applyLeftbarStyle(style) {
  leftbarStyle = style === 'collapsed' ? 'collapsed' : 'expanded';
  localStorage.setItem('swarmeye.leftbarStyle', leftbarStyle);
  leftbarEl.classList.toggle('expanded', leftbarStyle === 'expanded');
  if (leftbarStyle === 'expanded') leftbarEl.classList.remove('hover-expanded');
  leftbarSmallToggle.checked = leftbarStyle === 'collapsed';
}
leftbarSmallToggle.addEventListener('change', () => applyLeftbarStyle(leftbarSmallToggle.checked ? 'collapsed' : 'expanded'));
applyLeftbarStyle(leftbarStyle);

// hovering the collapsed rail previews the expanded layout as a floating
// overlay (#leftbar-surface grows past #leftbar's own reserved width, so
// the grid never reflows just from a mouse pass) — same hide-delay pattern
// as the workspace-tile flyout in topbar.js, so a quick pass-through
// doesn't flicker it open
let leftbarHoverTimer = null;
leftbarEl.addEventListener('mouseenter', () => {
  if (leftbarStyle !== 'collapsed') return;
  clearTimeout(leftbarHoverTimer);
  leftbarEl.classList.add('hover-expanded');
});
leftbarEl.addEventListener('mouseleave', () => {
  clearTimeout(leftbarHoverTimer);
  leftbarHoverTimer = setTimeout(() => leftbarEl.classList.remove('hover-expanded'), 200);
});

/* task board text scale — the ± control in the central Options popover; persisted locally.
 * Applies to board-main (new-task form + columns), board-archive, skills-main
 * and the options popover itself, so every non-terminal UI surface besides the
 * icon rail/top bar (covered by "Menu bar size") and agent panes shares one text size. */
const applyBoardZoom = makeZoomControl({
  storageKey: 'swarmeye.boardZoom',
  elements: () => [
    document.getElementById('board-main'),
    document.getElementById('board-archive'),
    document.getElementById('skills-main'),
    document.getElementById('history-main'),
    kbdPop,
    kbdShortcutsPop,
  ],
  valueEl: document.getElementById('board-font-val'),
  downId: 'board-font-down',
  upId: 'board-font-up',
});

/* agent pane text size — the ± control in the central Options popover; persisted
 * locally as the default new panes start at (same store Ctrl+/- and the pane's
 * own buttons write to). Also pushes the new size to every already-open pane,
 * so it reads as a single "text size" setting rather than just a new-pane default. */
const agentFontVal = document.getElementById('agent-font-val');
function applyAgentFontSize(px) {
  const size = Pane.setDefaultFontSize(px);
  agentFontVal.textContent = size + 'px';
  for (const p of state.panes.values()) p.setFontSize(size);
}
document.getElementById('agent-font-down').addEventListener('click', () => applyAgentFontSize(Pane.getDefaultFontSize() - 1));
document.getElementById('agent-font-up').addEventListener('click', () => applyAgentFontSize(Pane.getDefaultFontSize() + 1));
applyAgentFontSize(Pane.getDefaultFontSize());

/* agent pane text weight — the ± control below the size one, same shape. Its
 * reason to exist is the light themes: dark text on a near-white pane reads
 * thinner than the dark themes' light-on-dark at the same weight. */
const AGENT_WEIGHT_LABELS = { 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semibold' };
const agentWeightVal = document.getElementById('agent-weight-val');
function applyAgentFontWeight(w) {
  const weight = Pane.setDefaultFontWeight(w);
  agentWeightVal.textContent = AGENT_WEIGHT_LABELS[weight];
  for (const p of state.panes.values()) p.setFontWeight(weight);
}
document.getElementById('agent-weight-down').addEventListener('click', () => applyAgentFontWeight(Pane.getDefaultFontWeight() - 100));
document.getElementById('agent-weight-up').addEventListener('click', () => applyAgentFontWeight(Pane.getDefaultFontWeight() + 100));
applyAgentFontWeight(Pane.getDefaultFontWeight());

/* max simultaneous agents — the ± control in the ⌨ popover; persisted in config */
const maxAgentsVal = document.getElementById('max-agents-val');
async function applyMaxAgents(n) {
  const res = await window.swarm.setMaxAgents(n);
  maxAgents = res.maxAgents;
  maxAgentsVal.textContent = maxAgents;
  syncChrome(); // counter and + button follow the new cap
  runScheduler(); // a raised cap can immediately unblock queued tasks
}
document.getElementById('max-agents-down').addEventListener('click', () => applyMaxAgents(maxAgents - 1));
document.getElementById('max-agents-up').addEventListener('click', () => applyMaxAgents(maxAgents + 1));

/* auto-start usage threshold — the ± control in the ⌨ popover; persisted in config */
const autoLimitVal = document.getElementById('auto-limit-val');
async function applyAutoUsageLimit(n) {
  const res = await window.swarm.setAutoUsageLimit(n);
  autoUsageLimit = res.autoUsageLimit;
  autoLimitVal.textContent = autoUsageLimit + '%';
  renderBoard();
  runScheduler(); // a loosened threshold can immediately unblock queued tasks
}
document.getElementById('auto-limit-down').addEventListener('click', () => applyAutoUsageLimit(autoUsageLimit - 5));
document.getElementById('auto-limit-up').addEventListener('click', () => applyAutoUsageLimit(autoUsageLimit + 5));

/* auto mode (bypass permissions) — off by default; the checkbox in the ⌨
 * popover opts in, since it launches claude with --allow-dangerously-skip-permissions.
 * Every flip goes through applySkipPermissions so the checkbox, main's copy and
 * the panes' own copy (pane.js reads it when it decides whether to accept the
 * blocking first-run dialogs) can't drift apart. */
const skipPermissionsToggle = document.getElementById('skip-permissions-toggle');
function applySkipPermissions(on) {
  skipPermissionsToggle.checked = on;
  Pane.setSkipPermissions(on);
  window.swarm.setSkipPermissions(on);
}
skipPermissionsToggle.addEventListener('change', () => applySkipPermissions(skipPermissionsToggle.checked));

/* Every plain checkbox in the ⌨ Options panel is the same wiring — reflect
 * the stored value into the box, persist a flip, run the option's own effect —
 * so only the effect is written per option. Returns the apply function, which
 * the reset button uses to flip options programmatically.
 *
 * Options saved by older versions wrote '' for off rather than '0'; both read
 * back as false, so no migration is needed. */
function boolOption(id, key, defaultOn, effect) {
  const box = document.getElementById(id);
  const apply = (on) => {
    box.checked = on;
    localStorage.setItem('swarmeye.' + key, on ? '1' : '0');
    effect(on);
  };
  box.addEventListener('change', () => apply(box.checked));
  const saved = localStorage.getItem('swarmeye.' + key);
  apply(saved === null ? defaultOn : saved === '1');
  return apply;
}

/* "Show last command in pane header" — off by default; pushed to every
 * already-open pane so it reads as a single live setting */
const applyShowInitialCommand = boolOption('show-initial-cmd-toggle', 'showInitialCommand', false, (on) => {
  Pane.setShowInitialCommand(on);
  for (const p of state.panes.values()) p.syncInitialCommandHeader();
});

/* "Show cost & context panel" — off by default; the panel eats two rows of
 * every pane's terminal, so opening it re-fits each one */
const applyUsagePanel = boolOption('usage-panel-toggle', 'usagePanel', false, (on) => {
  Pane.setShowUsagePanel(on);
  for (const p of state.panes.values()) p.syncUsagePanel();
});

/* "Fixed agent pane buttons" — off by default: the five rarely-used header
 * buttons fold behind each pane's ⋯. On puts them back inline. */
const applyFixedPaneActions = boolOption('pane-fixed-actions-toggle', 'paneFixedActions', false, (on) => {
  Pane.setFixedActions(on);
  for (const p of state.panes.values()) p.syncActionsMode();
});

/* "Auto-organize agent windows" — on by default; off lets each pane's → / ↓
 * buttons place new agents by hand instead of the automatic square-ish grid */
const applyAutoOrganize = boolOption('auto-organize-toggle', 'autoOrganize', true, (on) => {
  Pane.setAutoOrganize(on);
  grid.setAutoOrganize(on);
  for (const p of state.panes.values()) p.syncSplitButtons();
});

/* "Space between agent panes" — on by default (12px gap + draggable divider,
 * plus the grid's own edge padding); off collapses panes flush together with
 * no gap and lets the grid fill the window edge-to-edge too */
const applyAgentPadding = boolOption('agent-padding-toggle', 'agentPadding', true, (on) => {
  grid.setGutter(on ? 12 : 0);
  gridWrapEl.classList.toggle('no-pane-gap', !on);
});

/* "Theme background overlay" state — read before applyTheme below, which
 * needs it: with the overlay off the panes are dark whatever the theme, and
 * the light themes' terminal palettes are built against that backdrop */
let themeOverlayOn = localStorage.getItem('swarmeye.themeOverlay') !== '0';

/* colour theme — swatches in the ⌨ popover; persisted locally */
const themeDots = document.querySelectorAll('#theme-opts .theme-dot');
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('swarmeye.theme', name);
  const xt = Pane.setXtermTheme(name, themeOverlayOn);
  const minContrast = Pane.getMinContrast();
  for (const p of state.panes.values()) {
    p.term.options.theme = xt;
    p.term.options.minimumContrastRatio = minContrast;
  }
  for (const dot of themeDots) dot.classList.toggle('active', dot.dataset.theme === name);
}
themeDots.forEach((dot) => dot.addEventListener('click', () => applyTheme(dot.dataset.theme)));
/* a theme this build no longer ships (the picker used to offer 25) falls back
 * to dark rather than leaving data-theme pointing at a block that is gone */
const savedTheme = localStorage.getItem('swarmeye.theme');
applyTheme([...themeDots].some((d) => d.dataset.theme === savedTheme) ? savedTheme : 'dark');

/* "Theme background overlay" — on by default; off hides the theme-tinted
 * background grid wash and pins the app's chassis (background, left bar,
 * panes, terminals) to the default dark shades, leaving only the theme's
 * colours — borders, text, accents, terminal ramp — themed. See app.css. */
const applyThemeOverlay = boolOption('theme-overlay-toggle', 'themeOverlay', true, (on) => {
  themeOverlayOn = on;
  document.documentElement.dataset.themeOverlay = on ? 'on' : 'off';
  applyTheme(document.documentElement.dataset.theme); // terminal palette follows the backdrop
});

/* "Task summary on completion" — on by default. The agent's closing message
 * is pulled out of the transcript by main/hooks.js on the same read that
 * already runs at every turn boundary, and lands on the completed card, so the
 * board says what came of a task without opening its transcript. */
let taskSummaries = true;
const applyTaskSummaryOption = boolOption('task-summary-toggle', 'taskSummary', true, (on) => {
  taskSummaries = on;
});

/* "Desktop notifications" — on by default. The taskbar flash and the bell only
 * help while SwarmEye is on screen; this is the one that reaches you with the
 * window minimized behind an editor. Main only raises a toast when the window
 * isn't focused, so this never fires at something you're already looking at. */
let desktopNotifs = true;
const applyDesktopNotifs = boolOption('desktop-notif-toggle', 'desktopNotifs', true, (on) => {
  desktopNotifs = on;
});

/* Flash the taskbar/dock and — when the option is on — raise an OS
 * notification naming the agent and what it did. */
function notifyOS(pane, text) {
  window.swarm.notify({
    title: `${pane.session.agentName} · ${pane.session.workspaceName}`,
    body: text,
    desktop: desktopNotifs,
  });
}

/* notification sound — the picker in the ⌨ popover; persisted locally and
 * played whenever an agent's turn finishes (see onStatusChange below) */
const notifSoundSel = document.getElementById('notif-sound-sel');
for (const [value, label] of Sounds.OPTIONS) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  notifSoundSel.appendChild(opt);
}
let notifSound = localStorage.getItem('swarmeye.notifSound') || 'chime';
notifSoundSel.value = notifSound;
notifSoundSel.addEventListener('change', () => {
  notifSound = notifSoundSel.value;
  localStorage.setItem('swarmeye.notifSound', notifSound);
  Sounds.play(notifSound); // preview so the pick is audible immediately
});

/* dictation engine installer — the ⌨ popover row. The engine is a Python venv
 * plus a ~465 MB Whisper model (inside WSL on Windows), so it's never
 * installed automatically; this runs the same scripts/setup-stt.sh that
 * `npm run setup:stt` does, streaming its output into a log box because a
 * multi-minute download behind a disabled button is indistinguishable from a
 * hang. Not part of ↺ Reset — an install isn't a preference. */
const sttStatusEl = document.getElementById('stt-status');
const sttInstallBtn = document.getElementById('stt-install-btn');
const sttLogEl = document.getElementById('stt-log');
const STT_LOG_MAX = 200;

async function refreshSttStatus() {
  const installed = await window.swarm.speechInstalled();
  sttStatusEl.textContent = installed ? 'installed' : 'not installed';
  sttStatusEl.classList.toggle('ok', installed);
  sttInstallBtn.textContent = installed ? 'Reinstall' : 'Install';
}
refreshSttStatus();

// registered once, not per click — preload's onX are bare ipcRenderer.on with
// no unsubscribe, same constraint onSkillUpdateStatus lives with
window.swarm.onSpeechInstallProgress(({ line }) => {
  sttLogEl.textContent += line + '\n';
  const lines = sttLogEl.textContent.split('\n');
  if (lines.length > STT_LOG_MAX) sttLogEl.textContent = lines.slice(-STT_LOG_MAX).join('\n');
  sttLogEl.scrollTop = sttLogEl.scrollHeight;
});

sttInstallBtn.addEventListener('click', async () => {
  sttInstallBtn.disabled = true;
  sttStatusEl.textContent = 'installing…';
  sttStatusEl.classList.remove('ok');
  sttLogEl.textContent = '';
  sttLogEl.hidden = false;
  const res = await window.swarm.speechInstall();
  sttInstallBtn.disabled = false;
  // the main process clears its cached availability check on success, so the
  // mic works straight away — no app restart
  if (res.ok) toast('dictation engine installed — the mic button works now');
  else if (res.reason === 'busy') toast('an install is already running');
  else toast('dictation engine install failed — see the log in ⌨ Options');
  refreshSttStatus();
});

/* The ⌨ popover's three default pickers are one control three times: fill the
 * select from a Pane table, persist the choice locally, and mirror it into the
 * task board's matching per-task select. They differ only in the table, the
 * storage key, and — for start mode — one extra coupling. */
const DEFAULT_PICKERS = [
  {
    id: 'default-startmode-sel',
    table: Pane.MODES,
    key: 'defaultStartMode',
    // 'default' is relabeled from Pane.MODES' own "manual" the same way the
    // task board's picker does, so the two read as the same choice
    optionText: (value, label) => (value === 'default' ? 'default' : label),
    // bypass ("auto") only exists in claude's Shift+Tab cycle when it was
    // launched with --allow-dangerously-skip-permissions, so picking it here
    // silently no-ops unless that prerequisite is also on — flip it on to match
    // instead of leaving the picker looking selectable but non-functional.
    onApply: (name) => {
      if (name === 'bypass' && !skipPermissionsToggle.checked) applySkipPermissions(true);
    },
  },
  { id: 'default-model-sel', table: Pane.MODELS, key: 'defaultModel' },
  { id: 'default-effort-sel', table: Pane.EFFORTS, key: 'defaultEffort' },
];

const applyDefault = {}; // key -> apply(value), for the ↺ Reset button below
for (const { id, table, key, optionText, onApply } of DEFAULT_PICKERS) {
  const sel = document.getElementById(id);
  for (const [value, label] of table) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = optionText ? optionText(value, label) : label;
    sel.appendChild(opt);
  }
  const apply = (name) => {
    sel.value = name;
    localStorage.setItem('swarmeye.' + key, name);
    Board.setDefaults({ [key]: name });
    if (onApply) onApply(name);
  };
  applyDefault[key] = apply;
  sel.addEventListener('change', () => apply(sel.value));
  apply(localStorage.getItem('swarmeye.' + key) || 'default');
}

/* default focus mode — a checkbox rather than a select, so it stays its own
 * few lines instead of bending the table above around one odd case */
const applyDefaultFocus = boolOption('default-focus-toggle', 'defaultFocus', false, (on) => {
  Board.setDefaults({ defaultFocus: on });
});

/* reset to default — restores every setting in the Options popover */
document.getElementById('options-reset-btn').addEventListener('click', async () => {
  applyLeftbarStyle('expanded');
  applyTopbarZoom(1);
  applyBoardZoom(1);
  applyAgentFontSize(Pane.DEFAULT_FONT_SIZE);
  applyAgentFontWeight(Pane.DEFAULT_FONT_WEIGHT);
  await applyMaxAgents(10);
  await applyAutoUsageLimit(85);
  applySkipPermissions(false);
  applyShowInitialCommand(false);
  applyUsagePanel(false);
  applyFixedPaneActions(false);
  applyAutoOrganize(true);
  applyAgentPadding(true);
  for (const { key } of DEFAULT_PICKERS) applyDefault[key]('default');
  applyDefaultFocus(false);
  applyTaskSummaryOption(true);
  applyDesktopNotifs(true);
  applyTheme('dark');
  applyThemeOverlay(true);
  notifSound = 'chime';
  notifSoundSel.value = notifSound;
  localStorage.setItem('swarmeye.notifSound', notifSound);
  toast('options reset to default');
});

/* ---- task board: queued todos for agents, started now or auto-scheduled
 * once an agent slot and usage headroom are both available ---- */

const boardEl = document.getElementById('board');
const sessionViewEl = document.getElementById('session-view'); // completed-task transcript popup, owned by board.js
const pendingTaskStarts = new Map(); // sessionId -> {taskId, injected}
const skillInjectAttempted = new Set(); // sessionId — every new session gets one attempt, task or manual
// sessionId — a task's prompt has been submitted but its own turn hasn't
// started yet. Every startup injection (an active skill's /command, /effort,
// /focus) is a real turn of its own, so it fires a Stop hook; without this
// gate the first of those Stops completes the task and closes the pane before
// the task text has even been typed.
const awaitingTaskTurn = new Set();
const manualStartRun = new Set(); // sessionId — manually-added agents run their startup sequence (skills, then default mode) once
const sessionStarted = new Set(); // sessionId — its SessionStart hook has arrived, i.e. claude's CLI is really up
let usageSnapshot = null;
let schedulerRunning = false;
let schedulerQueued = false;
const TASK_INJECT_SETTLE_MS = 500; // grace after SessionStart for the mode footer to draw
const TASK_INJECT_FALLBACK_MS = 5000; // covers sessions whose hooks never fire
const TASK_SUBMIT_DELAY_MS = 150; // gap before Enter so it lands as its own keystroke, not part of a pasted chunk
const TASK_MODEL_SETTLE_MS = 600; // grace for the "/model"/"/effort"/"/focus" confirmation line to print before the prompt follows
const DEFAULT_MODE_TRIES = 3; // Shift+Tab laps allowed before giving up on the Options default mode
const DEFAULT_MODE_RETRY_MS = 1500; // gap between those laps — also the window autoAcceptDialogs needs to clear a blocking dialog
const CLAUDE_READY_TIMEOUT_MS = 90000; // how long the mode cycler waits for a SessionStart before cycling blind (hookless sessions)
// uninterrupted idle that counts as "the startup turns are over" — longer than
// hooks.js's 3s state sweep, which is what actually delivers those events when
// fs.watch misses a write (the state dir is written from the WSL side)
const INJECT_QUIET_MS = 4000;
const INJECT_QUIET_MAX_MS = 90000; // ... but a wedged startup turn must not hold a task's prompt forever
const INJECT_POLL_MS = 200;

/* Waits for the turns started by the startup injections to finish. Typing an
 * active skill's `/command` (or `/effort`, or `/focus`) is a real turn that
 * ends in a Stop hook — send the agent's actual prompt while one is still
 * running and that Stop lands *after* the prompt is in, where a task reads it
 * as its own completion and 'close on complete' kills the agent mid-work.
 * Waiting the injections out is what keeps the two apart. */
async function waitForInjectionsToSettle(pane) {
  const deadline = Date.now() + INJECT_QUIET_MAX_MS;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (pane.exited) return;
    if (pane.working) quietSince = Date.now();
    else if (Date.now() - quietSince >= INJECT_QUIET_MS) return;
    await new Promise((r) => setTimeout(r, INJECT_POLL_MS));
  }
}

/* Types `/<id>` for every skill marked "active" in the Skills screen, right
 * when a brand-new agent starts — task-created or the plain "+ Coding Agent"
 * button alike — so it's invoked from turn one instead of waiting on the
 * model to notice it's relevant on its own. Idempotent per session: whichever
 * trigger (SessionStart hook or the fallback timer) fires first wins.
 *
 * Several skills go in as one `/a /b /c` message rather than one message
 * each: claude expands a leading skill plus up to five more stacked after it
 * (2.1.199+), so six active skills cost one turn instead of six. Expansion
 * stops at the first token that isn't an inline skill, and everything from
 * there on is read as argument text — so a `context: fork` skill ends the run
 * and is sent on a line of its own instead of silently swallowing whatever
 * followed it.
 *
 * Returns how many messages it typed — each is a turn the caller may have to
 * wait out before sending a prompt of its own. */
const SKILL_STACK_MAX = 6; // claude expands the first skill plus five more
async function tryInjectSkills(sessionId) {
  if (skillInjectAttempted.has(sessionId)) return 0;
  const pane = state.panes.get(sessionId);
  if (!pane || pane.exited) return 0;
  skillInjectAttempted.add(sessionId);
  const active = typeof Skills !== 'undefined' ? await Skills.getActiveSkills() : [];
  // a workspace-local skill only exists for agents running in that folder
  const forHere = active.filter((s) => !s.workspaceId || s.workspaceId === pane.session.workspaceId);
  const runs = [];
  for (const skill of forHere) {
    const open = runs[runs.length - 1];
    const stackable = open && !open.fork && !skill.fork && open.commands.length < SKILL_STACK_MAX;
    if (stackable) open.commands.push('/' + skill.command);
    else runs.push({ fork: !!skill.fork, commands: ['/' + skill.command] });
  }
  for (const run of runs) {
    window.swarm.writeSession(sessionId, run.commands.join(' '));
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
  }
  return runs.length;
}

/* The startup sequence of a manually-added agent (+ Coding Agent / Ctrl+N):
 * active skills first, then the "Default agent permissions" Options setting —
 * strictly in that order, and never twice. The two used to be scheduled as two
 * independent timers, which is why an Options default of "auto" so often
 * didn't take: Shift+Tab landing while a `/skill` command is half-typed is
 * eaten by claude's command autocomplete instead of cycling the mode. Task
 * sessions run the same two steps from tryInjectPrompt, so they are skipped
 * here rather than cycled twice.
 *
 * The mode step waits for the session's SessionStart hook before it starts
 * cycling: on a cold WSL a claude can take the better part of a minute to
 * come up, and Shift+Tab pressed into a terminal it isn't reading yet is
 * simply buffered — the whole 4-press lap arrives at once later and cycles
 * back to where it began. Typed text (the skills above) survives that wait
 * fine, so only the cycling is gated. Sessions whose hooks never fire cycle
 * blind after CLAUDE_READY_TIMEOUT_MS rather than never.
 *
 * setMode is then still retried: it steers by reading claude's footer, which
 * may not have drawn yet, and the very first use of auto mode on a machine
 * lands on the bypass-permissions warning that swallows the keys — the gap
 * between laps is when the pane's own autoAcceptDialogs clears it. */
async function startManualSession(sessionId) {
  if (manualStartRun.has(sessionId) || pendingTaskStarts.has(sessionId)) return;
  const pane = state.panes.get(sessionId);
  if (!pane || pane.exited) return;
  manualStartRun.add(sessionId);
  await tryInjectSkills(sessionId);
  const startMode = localStorage.getItem('swarmeye.defaultStartMode') || 'default';
  if (startMode === 'default') return;
  for (let waited = 0; !sessionStarted.has(sessionId) && waited < CLAUDE_READY_TIMEOUT_MS; waited += 500) {
    if (pane.exited) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (let attempt = 0; attempt < DEFAULT_MODE_TRIES; attempt++) {
    if (pane.exited) return;
    // only the final lap may complain — the earlier ones are expected to fail
    // on a CLI that is still drawing its first screen
    if (await pane.setMode(startMode, { quiet: attempt < DEFAULT_MODE_TRIES - 1 })) return;
    await new Promise((r) => setTimeout(r, DEFAULT_MODE_RETRY_MS));
  }
}

function renderBoard() {
  Board.render(state.tasks, state.archivedTasks, state.workspaces, autoUsageLimit, boardHandlers);
}

function renderArchive() {
  Board.renderArchive(state.archivedTasks, state.workspaces, boardHandlers);
}

/* usage data is percentage-only (Anthropic's API exposes no raw token
 * counts) — "enough budget" gates on the 5-hour session window only. The
 * weekly window resets on its own multi-day clock regardless of what an
 * agent does today, so gating auto-start on it can wedge every "auto" task
 * for days; a task with no session headroom just stays pending and is
 * retried once the next session's usage comes in. Stale/missing data blocks
 * auto-start rather than guessing. */
function usageOk() {
  const s = usageSnapshot;
  if (!s || !s.ok || s.stale) return false;
  const fh = s.fiveHour && s.fiveHour.usedPct;
  return fh != null && fh < autoUsageLimit;
}

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/* starts as many pending "auto"/"next-session" tasks as the agent cap
 * allows, highest priority first (oldest first within the same priority) —
 * this is the literal "spin up as many agents as required within the
 * limit, working the most important tasks first" behavior. "auto" tasks
 * need usage headroom; "next-session" tasks just wait for the wall clock
 * to pass the resets_at captured when they were created. */
async function runScheduler() {
  if (schedulerRunning) { schedulerQueued = true; return; }
  schedulerRunning = true;
  try {
    const pending = state.tasks
      .filter((t) => t.status === 'pending' && (t.mode === 'auto' || t.mode === 'next-session')
        && state.workspaces.some((w) => w.id === t.workspaceId))
      .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
        || a.createdAt - b.createdAt);
    for (const task of pending) {
      if (liveAgentCount() >= maxAgents) break; // agent cap blocks every mode alike
      // a recurring task's next run is queued the moment the previous one
      // finishes — it waits here until its interval is actually up
      if (task.nextRunAt && Date.now() < task.nextRunAt) continue;
      if (task.mode === 'auto') {
        if (!usageOk()) continue;
      } else {
        // no resets_at yet (usage wasn't available at creation) — adopt the
        // first one we see and wait for the tick after it actually passes
        if (task.targetResetsAt == null) {
          const resetsAt = usageSnapshot && usageSnapshot.fiveHour && usageSnapshot.fiveHour.resetsAt;
          if (resetsAt) {
            task.targetResetsAt = resetsAt;
            window.swarm.updateTask(task.id, { targetResetsAt: resetsAt });
          }
          continue;
        }
        // targetResetsAt is normally epoch ms, but tasks created before the
        // resets_at normalization fix may have an ISO string persisted —
        // route through Date() so a stale string doesn't silently compare
        // as NaN (always false) and skip the wait entirely
        if (Date.now() < new Date(task.targetResetsAt).getTime()) continue;
      }
      await startTask(task); // sequential: liveAgentCount() must be current for the next check
    }
  } finally {
    schedulerRunning = false;
    if (schedulerQueued) { schedulerQueued = false; runScheduler(); }
  }
}

/* shared by "start now", manual retry, and the scheduler. notify is only
 * true for user-initiated starts — the scheduler stays silent on failure.
 * Starting a task never jumps the view; it stays wherever the user is
 * (usually the board), so the new active card shows up in place. */
async function startTask(task, { notify = false } = {}) {
  // synchronous re-entry guard: a second start (double-clicked ▶, or the
  // scheduler picking the task up while a manual start's createSession is
  // still in flight) would spawn two agents for one task. `starting` is
  // renderer-only — not in TASK_PATCH_KEYS, so it never persists.
  if (task.starting || task.status === 'active') return null;
  task.starting = true;
  try {
    // launched as a --model flag (session-only), never a typed `/model`
    // command — that saves as the user's default for new sessions and would
    // bleed this task's choice into every agent started afterward
    const modelArg = task.model && task.model !== 'default' ? task.model : undefined;
    const res = await window.swarm.createSession(task.workspaceId, 100, 30, modelArg);
    if (!res.ok) {
      if (notify) {
        toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached — task left pending` : 'could not start task: ' + res.reason);
      }
      return null; // stays pending either way
    }
    const pane = mountPane(res.session, { managed: true });
    task.status = 'active';
    task.paneId = res.session.id;
    task.startedAt = Date.now();
    pane.syncInitialCommandHeader(); // task.paneId is now set, so the lookup in getPaneInitialPrompt resolves
    window.swarm.updateTask(task.id, { status: 'active', paneId: task.paneId, startedAt: task.startedAt });
    renderBoard();
    pendingTaskStarts.set(res.session.id, { taskId: task.id, injected: false });
    setTimeout(() => tryInjectPrompt(res.session.id), TASK_INJECT_FALLBACK_MS);
    return pane;
  } finally {
    delete task.starting;
  }
}

/* delivers the task text through the same safe channel as normal keyboard
 * input (ptys.write) — never the shell command line, which can't safely
 * embed arbitrary text. Fires once: SessionStart or the fallback timer,
 * whichever comes first (`injected` is claimed synchronously).
 * Text and Enter are written as separate, distinctly-timed writes: a single
 * write of `text + '\r'` lands as one chunk that Claude's input box can
 * treat as a paste with an embedded newline (text fills the box but never
 * submits) instead of a real Enter keystroke. */
async function tryInjectPrompt(sessionId) {
  const entry = pendingTaskStarts.get(sessionId);
  if (!entry || entry.injected) return;
  const pane = state.panes.get(sessionId);
  const task = state.tasks.find((t) => t.id === entry.taskId);
  if (!pane || !task || pane.exited) { pendingTaskStarts.delete(sessionId); return; }
  entry.injected = true;
  let typedCommands = await tryInjectSkills(sessionId); // active skills before anything task-specific
  // set the starting permission mode before the prompt lands, so the first
  // tool call in e.g. bypass mode isn't blocked on a manual approval
  if (task.startMode !== 'default') await pane.setMode(task.startMode);
  // model is applied as a --model launch flag in startTask, not here — see
  // the comment there for why a typed `/model` command isn't used
  if (task.effort && task.effort !== 'default') {
    pane.setEffort(task.effort); // the buffer scan catches it too, but only while the confirmation is still on screen
    window.swarm.writeSession(sessionId, '/effort ' + task.effort);
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
    typedCommands++;
  }
  // `/focus` is a toggle, and claude doesn't always start with it off — so
  // only send it when the footer shows it's not already active, or this
  // would just as easily switch it off as on
  if (task.focus && !pane.detectFocus()) {
    window.swarm.writeSession(sessionId, '/focus');
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
    typedCommands++;
  }
  // let those turns finish before the prompt goes in, so their Stop hooks
  // can't be mistaken for this task's own completion (nothing typed = nothing
  // to wait for, and the task starts as immediately as it always did)
  if (typedCommands) await waitForInjectionsToSettle(pane);
  if (pane.exited) { pendingTaskStarts.delete(sessionId); return; }
  // armed before the text goes in and cleared by the first hook event of the
  // task's own turn — until then every Stop belongs to a startup injection
  awaitingTaskTurn.add(sessionId);
  window.swarm.writeSession(sessionId, task.text);
  await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
  window.swarm.writeSession(sessionId, '\r');
  pendingTaskStarts.delete(sessionId);
}

/* The closing message of the turn that just ended, filed on the task that turn
 * completed. It arrives a beat after the Stop that completed the task — the
 * transcript read behind it is async — so the card is matched by pane, and only
 * while its completion is still fresh: a pane reused by a later task must not
 * have that task's summary land on this one. */
const SUMMARY_GRACE_MS = 120000;

function applyTaskSummary(sessionId, summary) {
  if (!taskSummaries) return;
  const task = state.tasks.find((t) => t.paneId === sessionId && t.status === 'completed'
    && t.completedAt && Date.now() - t.completedAt < SUMMARY_GRACE_MS);
  if (!task) return;
  task.summary = summary;
  window.swarm.updateTask(task.id, { summary });
  renderBoard();
}

async function createTask({ text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category, chain, repeat, nextRunAt }) {
  if (!workspaceId) { toast('pick a workspace for this task'); return; }
  const targetResetsAt = mode === 'next-session'
    ? (usageSnapshot && usageSnapshot.fiveHour && usageSnapshot.fiveHour.resetsAt) || null
    : null;
  const res = await window.swarm.createTask({ text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category, chain, repeat, nextRunAt, targetResetsAt });
  if (!res.ok) {
    toast(res.reason === 'empty-text' ? 'task text can’t be empty' : 'could not create task');
    return;
  }
  state.tasks.push(res.task);
  renderBoard();
  if (mode === 'auto' || mode === 'next-session') runScheduler();
  else if (mode === 'now') await startTask(res.task, { notify: true });
  // mode === 'manual': task sits in the Manual column untouched
}

/* pipelines: a task can carry follow-up prompts, and each one is queued as a
 * fresh task (same workspace/model/mode settings) when the previous finishes —
 * build → review → fix, unattended. Only a real completion chains: stopping an
 * agent by hand ends the pipeline with it. */
function startChain(task) {
  const [next, ...rest] = task.chain || [];
  if (!next) return;
  createTask({
    text: next,
    workspaceId: task.workspaceId,
    // an 'auto' pipeline stays auto — a 'now' follow-up that hits the agent cap
    // would sit pending with nothing to pick it up again
    mode: task.mode === 'auto' ? 'auto' : 'now',
    startMode: task.startMode,
    model: task.model,
    effort: task.effort,
    focus: task.focus,
    closeOnComplete: task.closeOnComplete,
    priority: task.priority,
    category: task.category,
    chain: rest,
  });
}

/* recurring tasks: a completed task with a repeat interval queues its own next
 * run as a fresh pending task, due one interval later. Always 'auto' — the
 * scheduler is the only thing that can pick a task up on a timer, and the
 * usage gate it applies keeps a daily job from firing with no budget left.
 * Deleting the queued card is how you stop the series. */
function startRepeat(task) {
  const every = Board.REPEAT_MS[task.repeat];
  if (!every) return;
  createTask({
    text: task.text,
    workspaceId: task.workspaceId,
    mode: 'auto',
    startMode: task.startMode,
    model: task.model,
    effort: task.effort,
    focus: task.focus,
    closeOnComplete: task.closeOnComplete,
    priority: task.priority,
    category: task.category,
    chain: task.chain,
    repeat: task.repeat,
    nextRunAt: Date.now() + every,
  });
}

const boardHandlers = {
  onCreate: createTask,
  onStart(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (task) startTask(task, { notify: true });
  },
  onMoveStatus(id, status) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = status;
    window.swarm.updateTask(id, { status });
    renderBoard();
  },
  // dragging an Active card back to Manual/Scheduled: stop its agent (same
  // kill+cleanup as the pane ✕) and hand the task back unstarted, rather
  // than parking it in Completed the way closing the pane window does.
  onStopAndMove(id, status) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    const pane = state.panes.get(task.paneId);
    if (pane) {
      if (!pane.exited) window.swarm.killSession(pane.session.id);
      if (state.lastFocused === pane) state.lastFocused = null;
      state.panes.delete(pane.session.id);
      grid.remove(pane);
      syncChrome();
    }
    task.status = status;
    task.paneId = null;
    window.swarm.updateTask(id, { status, paneId: null });
    renderBoard();
  },
  onSetPriority(id, priority) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.priority = priority;
    window.swarm.updateTask(id, { priority });
    renderBoard();
    runScheduler(); // priority decides which pending tasks the scheduler picks up first
  },
  onSetCategory(id, category) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.category = category;
    window.swarm.updateTask(id, { category });
    renderBoard();
  },
  async onAddCategory(workspaceId, name) {
    const res = await window.swarm.addWorkspaceCategory(workspaceId, name);
    state.workspaces = res.workspaces || state.workspaces;
    renderBoard();
  },
  async onRemoveCategory(workspaceId, name) {
    const res = await window.swarm.removeWorkspaceCategory(workspaceId, name);
    state.workspaces = res.workspaces || state.workspaces;
    renderBoard();
  },
  async onDelete(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (task && task.paneId) pendingTaskStarts.delete(task.paneId);
    const res = await window.swarm.deleteTask(id);
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.archivedTasks = res.archivedTasks || state.archivedTasks;
    renderBoard();
  },
  async onPurge(id) {
    const res = await window.swarm.purgeTask(id);
    state.archivedTasks = res.archivedTasks || [];
    renderArchive();
  },
  async onPurgeAll() {
    const res = await window.swarm.purgeAllTasks();
    state.archivedTasks = res.archivedTasks || [];
    renderArchive();
  },
  async onJump(paneId) {
    const pane = state.panes.get(paneId);
    if (!pane) { toast('this agent is gone'); return; }
    toggleBoard(false);
    if (pane.session.workspaceId !== state.selectedWorkspaceId) await selectWorkspace(pane.session.workspaceId);
    pane.focus();
  },
  getPaneAgentName(paneId) {
    const pane = state.panes.get(paneId);
    return pane ? pane.session.agentName : null;
  },
  getGit(workspaceId) {
    return state.git[workspaceId];
  },
  onRunAgain(task) {
    createTask({
      text: task.text,
      workspaceId: task.workspaceId,
      mode: 'now',
      startMode: task.startMode,
      model: task.model,
      effort: task.effort,
      focus: task.focus,
      closeOnComplete: task.closeOnComplete,
      priority: task.priority,
      category: task.category,
      chain: task.chain, // re-running a pipeline's first task re-runs the pipeline
    });
  },
  async onExportSession(task) {
    const ws = state.workspaces.find((w) => w.id === task.workspaceId);
    const name = boardHandlers.getPaneAgentName(task.paneId) || (ws ? ws.name : 'task');
    const res = await window.swarm.exportSession(name, task.sessionLog || '');
    if (res.ok) toast('transcript saved to ' + res.path);
    else if (!res.canceled) toast('could not save: ' + res.reason);
  },
};

/* the board is a full view swapped in for the agent grid — like switching
 * workspaces — not a modal floating above it. Any call to toggleBoard also
 * forces the Skills view closed (and vice versa below) so the two full
 * views and the grid stay mutually exclusive no matter which "return to
 * grid" call site (onJump, onClose, workspace select, …) triggered it. */
function toggleBoard(show) {
  boardEl.hidden = !show;
  skillsEl.hidden = true;
  historyEl.hidden = true;
  closeSwarmView();
  gridWrapEl.hidden = show;
  document.getElementById('board-btn').classList.toggle('active', show);
  document.getElementById('skills-btn').classList.remove('active');
  document.getElementById('history-btn').classList.remove('active');
  if (show) { Board.toggleArchive(false); renderBoard(); renderArchive(); Board.showForm(true); }
  else {
    Board.stopDictation(); // closing the board must not leave the mic hot
    Board.closeSessionView();
    // terminals sat behind a hidden container — refit in case anything
    // resized while the board was up (same safety net as syncGrid())
    requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
  }
}
document.getElementById('board-btn').addEventListener('click', () => toggleBoard(boardEl.hidden));
document.getElementById('board-close-btn').addEventListener('click', () => toggleBoard(false));

/* same full-view-swap pattern as the board, mutually exclusive with it */
const skillsEl = document.getElementById('skills-view');
function toggleSkills(show) {
  skillsEl.hidden = !show;
  boardEl.hidden = true;
  historyEl.hidden = true;
  closeSwarmView();
  gridWrapEl.hidden = show;
  document.getElementById('board-btn').classList.remove('active');
  document.getElementById('history-btn').classList.remove('active');
  document.getElementById('skills-btn').classList.toggle('active', show);
  if (show) Skills.refresh();
  else requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
}
document.getElementById('skills-btn').addEventListener('click', () => toggleSkills(skillsEl.hidden));
document.getElementById('skills-close-btn').addEventListener('click', () => toggleSkills(false));

/* and a third: the History screen — past Claude conversations for a
 * workspace, each resumable in a new pane. Same swap slot, same exclusivity. */
const historyEl = document.getElementById('history-view');
const historyHandlers = {
  /* `claude --resume <id>` in a fresh pane. Deliberately a new session (new
   * id, new tmux server entry) rather than anything that reuses the old one:
   * the transcript is the only thing being brought back, the process is not. */
  async onResume(workspaceId, sessionId) {
    if (liveAgentCount() >= maxAgents) { toast(`limit of ${maxAgents} sessions reached`); return; }
    const res = await window.swarm.createSession(workspaceId, 100, 30, undefined, sessionId);
    if (!res.ok) {
      toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not resume: ' + res.reason);
      return;
    }
    toggleHistory(false);
    if (workspaceId !== state.selectedWorkspaceId) await selectWorkspace(workspaceId);
    const pane = mountPane(res.session);
    pane.focus();
    toast('resumed that conversation in ' + pane.session.agentName);
  },
};

function toggleHistory(show) {
  historyEl.hidden = !show;
  boardEl.hidden = true;
  skillsEl.hidden = true;
  closeSwarmView();
  gridWrapEl.hidden = show;
  document.getElementById('board-btn').classList.remove('active');
  document.getElementById('skills-btn').classList.remove('active');
  document.getElementById('history-btn').classList.toggle('active', show);
  // always re-read: agents write new transcripts into that folder while the
  // app runs, so a cached list goes stale between visits
  if (show) History.refresh(state.workspaces, state.selectedWorkspaceId, historyHandlers);
  else requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
}
document.getElementById('history-btn').addEventListener('click', () => toggleHistory(historyEl.hidden));
document.getElementById('history-close-btn').addEventListener('click', () => toggleHistory(false));

/* and a fourth: the swarm view — the whole swarm as a map, agents coloured by
 * workspace and animated by status, with the activity list and notification
 * feed docked beside it. Unlike the other three it owns no state of its own:
 * every paint reads panes/workspaces/notifications from here, so anything
 * that moves an agent (syncChromeNow, renderNotifs) repaints it. */
const swarmViewHandlers = {
  onOpen(paneId) {
    closeSwarmView();
    notifHandlers.onOpen(paneId); // also swaps back to the grid and the right workspace
  },
  onApprove(paneId, always) { notifHandlers.onApprove(paneId, always); },
  onDeny(paneId) { notifHandlers.onDeny(paneId); },
  /* Right-clicking empty map: start an agent in the workspace whose corner of
   * the map you clicked in, optionally with its first prompt already typed.
   * The map stays up — you launched it from here to watch it from here — so
   * the new agent joins the swarm as a node rather than yanking the view over
   * to its workspace grid.
   * The prompt goes down the same two-write channel the task board uses —
   * text, a beat, then Enter — so Claude's input box sees a real keystroke
   * rather than a pasted chunk with a newline in it. */
  async onNewAgentAt(workspaceId, prompt, autoClose) {
    if (workspaceId && workspaceId !== state.selectedWorkspaceId) await selectWorkspace(workspaceId);
    const pane = await addAgent({ keepView: true });
    if (!pane) return;
    const id = pane.session.id;
    // after addAgent's own skill/permission-mode injection, which is scheduled
    // at TASK_INJECT_FALLBACK_MS and types commands of its own
    setTimeout(async () => {
      const live = state.panes.get(id);
      if (!live || live.exited) return;
      // those injections are turns in their own right — wait them out, or
      // their Stop hooks arrive after the arming below and close the agent
      await waitForInjectionsToSettle(live);
      if (live.exited) return;
      if (prompt) {
        window.swarm.writeSession(id, prompt);
        await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
        window.swarm.writeSession(id, '\r');
      }
      // armed only now: a Stop hook fired by the startup injections, before the
      // prompt is even in, would otherwise close the agent as it starts
      if (autoClose) autoClosers.add(id);
    }, TASK_INJECT_FALLBACK_MS + TASK_MODEL_SETTLE_MS);
  },
  /* the map's context menu — the same actions a pane's own header carries, so
   * a swarm can be steered without opening the pane it belongs to */
  onInterrupt(paneId) {
    const pane = state.panes.get(paneId);
    if (!pane || pane.exited) return;
    window.swarm.writeSession(paneId, '\x1b'); // Esc: what stops a turn
    toast('interrupted ' + pane.session.agentName);
  },
  /* the map is where you see who is idle — so the composer opens from here
   * with that agent already addressed, rather than making you find its pane */
  onMessage(paneId) {
    const pane = state.panes.get(paneId);
    if (!pane || pane.exited) return;
    Messenger.open(pane.session.agentName);
  },
  onClear(paneId) {
    const pane = state.panes.get(paneId);
    if (!pane || pane.exited) return;
    window.swarm.writeSession(paneId, '/clear\r');
    toast('cleared ' + pane.session.agentName + "'s context");
  },
  onRestart(paneId) {
    const pane = state.panes.get(paneId);
    if (pane) paneHandlers.onRestart(pane, { resume: true });
  },
  onEnd(paneId) {
    const pane = state.panes.get(paneId);
    if (pane) paneHandlers.onClose(pane);
  },
};

function swarmViewCtx() {
  return {
    panes: [...state.panes.values()],
    workspaces: state.workspaces,
    maxAgents,
    handlers: swarmViewHandlers,
  };
}

/* Hiding only — the other three views call this on their way in, and they set
 * the grid's own visibility themselves right after. */
function closeSwarmView() {
  if (swarmViewEl.hidden) return;
  swarmViewEl.hidden = true;
  swarmViewBtn.classList.remove('active');
  SwarmView.setActive(false);
}

function toggleSwarmView(show) {
  if (!show) {
    closeSwarmView();
    gridWrapEl.hidden = false;
    requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
    return;
  }
  swarmViewEl.hidden = false;
  boardEl.hidden = true;
  skillsEl.hidden = true;
  historyEl.hidden = true;
  gridWrapEl.hidden = true;
  document.getElementById('board-btn').classList.remove('active');
  document.getElementById('skills-btn').classList.remove('active');
  document.getElementById('history-btn').classList.remove('active');
  swarmViewBtn.classList.add('active');
  SwarmView.setActive(true);
  SwarmView.render(swarmViewCtx());
}

function renderSwarmView() {
  if (swarmViewEl.hidden) return;
  SwarmView.render(swarmViewCtx());
  renderTimeline();
}

/* ---- swarm timeline ----
 * One entry per agent per state change, painted as a one-hour ribbon under
 * the map by renderer/timeline.js. Nothing is sampled on a timer: a band runs
 * from its entry to the next one, so an agent that stays busy for ten minutes
 * costs exactly one entry. Renderer-only and not persisted — the ribbon is
 * "what has this swarm been doing since I sat down", not an audit log. */
const timelineLog = new Map(); // sessionId -> [{t, status, tool}]
const svTimelineEl = document.getElementById('sv-timeline');
const svTimelineBtn = document.getElementById('sv-timeline-btn');
let timelineOn = localStorage.getItem('swarmeye.svTimeline') === '1';

/* The pane's own four-way status, named the way the swarm view's legend names
 * it — a pane blocked on a permission prompt reads as 'waiting' whether or not
 * its attention flag has already been cleared by a glance at the pane. */
function timelineStatus(pane) {
  if (pane.exited) return 'exited';
  if (pane.working) return 'busy';
  if (pane.attention || pane.awaitingPrompt) return 'waiting';
  return 'idle';
}

function recordTimeline(pane) {
  const id = pane.session.id;
  const status = timelineStatus(pane);
  const tool = pane.statusText || '';
  const list = timelineLog.get(id) || [];
  const last = list[list.length - 1];
  if (last && last.status === status && last.tool === tool) return;
  list.push({ t: Date.now(), status, tool });
  // drop entries that fell off the left edge, but keep the last one that
  // did — it is what the ribbon's opening band is drawn from
  const cutoff = Date.now() - Timeline.WINDOW_MS;
  let from = 0;
  while (from + 1 < list.length && list[from + 1].t <= cutoff) from += 1;
  timelineLog.set(id, from ? list.slice(from) : list);
}

function renderTimeline() {
  if (!timelineOn || swarmViewEl.hidden) return;
  // panes closed since the last paint stop being tracked here rather than at
  // every one of the several call sites that can remove one
  for (const id of timelineLog.keys()) if (!state.panes.has(id)) timelineLog.delete(id);
  Timeline.render(svTimelineEl, [...state.panes.values()], timelineLog);
}

function applyTimeline(on) {
  timelineOn = !!on;
  localStorage.setItem('swarmeye.svTimeline', timelineOn ? '1' : '0');
  svTimelineEl.hidden = !timelineOn;
  svTimelineBtn.classList.toggle('active', timelineOn);
  renderTimeline();
}
svTimelineBtn.addEventListener('click', () => applyTimeline(!timelineOn));
applyTimeline(timelineOn);
// the "now" edge has to keep moving even when no agent changes state
setInterval(renderTimeline, 10000);

swarmViewBtn.addEventListener('click', () => toggleSwarmView(swarmViewEl.hidden));
document.getElementById('swarm-view-close-btn').addEventListener('click', () => toggleSwarmView(false));

/* Session ids launched with "auto-close once completed" ticked in the map's
 * new-agent form. A task's agent gets the same treatment from its own
 * closeOnComplete flag; this is the manual launch's equivalent, and it is
 * deliberately renderer-only — an agent reattached after a restart is one the
 * user is looking after by hand again. */
const autoClosers = new Set();

const paneHandlers = {
  getPaneInitialPrompt(sessionId) {
    const task = state.tasks.find((t) => t.paneId === sessionId);
    return task ? task.text : null;
  },
  onClose(pane) {
    if (!pane.exited) window.swarm.killSession(pane.session.id);
    autoClosers.delete(pane.session.id);
    // closing a still-active task's agent window is how you stop it — send
    // the task to Completed marked 'stopped' instead of leaving it stuck in
    // Active forever. A task already completed (onStatusChange below) has no
    // 'active' status left to match, so that path never double-fires this.
    const task = state.tasks.find((t) => t.paneId === pane.session.id && t.status === 'active');
    if (task) {
      task.status = 'completed';
      task.completedAt = Date.now();
      task.stopped = true;
      task.sessionLog = pane.getBufferText();
      window.swarm.updateTask(task.id, { status: 'completed', completedAt: task.completedAt, stopped: true, sessionLog: task.sessionLog });
      renderBoard();
    }
    if (state.lastFocused === pane) state.lastFocused = null;
    state.panes.delete(pane.session.id);
    grid.remove(pane);
    syncChrome();
  },
  onMaximize(pane) {
    grid.toggleMax(pane);
  },
  onResize(pane, cols, rows) {
    window.swarm.resizeSession(pane.session.id, cols, rows);
  },
  onRename(pane, name) {
    window.swarm.renameSession(pane.session.id, name);
    syncChrome();
  },
  setLastCommand(pane, cmd) {
    window.swarm.setLastCommand(pane.session.id, cmd);
  },
  onFocus(pane) {
    // also un-focus the previous holder here: panes in non-selected workspaces
    // are detached from the DOM, so pane.js's querySelectorAll('.pane.focused')
    // sweeps can't reach them — a stale .focused left there makes the
    // "user is watching this pane" checks swallow that pane's notifications
    if (state.lastFocused && state.lastFocused !== pane) {
      state.lastFocused.el.classList.remove('focused');
    }
    state.lastFocused = pane;
  },
  onShortcut: isShortcut,
  onSplit(pane, direction) {
    // a role is inherited by the split, so splitting a reviewer gives you a
    // second one
    addAgent({ refPane: pane, direction, role: pane.session.role });
  },
  onStatusChange(pane, status) {
    recordTimeline(pane); // every state flip is a band edge on the swarm timeline
    if (status === 'done') {
      // fired on every Stop hook, watched or not — task completion must not
      // ride on the attention path, which flagAttention suppresses while the
      // user is looking at the pane (and skips when attention is already set)
      const watching = pane.el.isConnected && pane.el.classList.contains('focused') && document.hasFocus();
      if (!watching) {
        notifyOS(pane, 'finished its turn'); // taskbar flash + OS toast; the bell below carries the detail
        pushNotif(pane, 'done', 'finished its turn');
        Sounds.play(notifSound);
      }
      // a Stop that lands before the task's prompt is in (or before its turn
      // has started) belongs to a startup injection, not to the task
      const injecting = pendingTaskStarts.has(pane.session.id) || awaitingTaskTurn.has(pane.session.id);
      const task = injecting ? null : state.tasks.find((t) => t.paneId === pane.session.id && t.status === 'active');
      if (task) {
        task.status = 'completed';
        task.completedAt = Date.now();
        task.sessionLog = pane.getBufferText();
        window.swarm.updateTask(task.id, { status: 'completed', completedAt: task.completedAt, sessionLog: task.sessionLog });
        renderBoard();
        // a task's agent window closes with it unless the task opted out via
        // 'close on complete'; manual agents have no task to match here
        if (task.closeOnComplete !== false) paneHandlers.onClose(pane);
        startChain(task); // after the close, so the freed agent slot is available
        startRepeat(task); // no-op unless the task repeats — queues its next run
      } else if (autoClosers.has(pane.session.id)) {
        // launched from the map with 'auto-close once completed' ticked: the
        // turn it was launched for is over, so the agent goes with it
        toast(pane.session.agentName + ' finished — closing it');
        paneHandlers.onClose(pane); // clears its autoClosers entry
      }
    } else if (status === 'attention') {
      // the pane's status text says why (hook-driven): 'done' = turn finished
      // (already handled by the dedicated 'done' status above — a later bell
      // must not repeat it, and neither must a second OS toast), anything else
      // = blocked on the user; empty = bell/heuristic fallback
      const reason = pane.statusEl.textContent;
      if (reason !== 'done') {
        notifyOS(pane, reason || 'needs attention');
        pushNotif(pane, 'wait', reason || 'needs attention');
      } else {
        window.swarm.notify({}); // flash only — 'done' announces itself above
      }
    } else if (status === 'prompt') {
      // a yes/no menu appeared or went away — the bell's ✓/✕ (and the swarm
      // view's, via renderNotifs) follow the pane's
      renderNotifs();
    }
    syncChrome(); // keep workspace pill badges current
  },
  async onExport(pane) {
    const res = await window.swarm.exportSession(pane.session.agentName, pane.getBufferText());
    if (res.ok) toast('transcript saved to ' + res.path);
    else if (!res.canceled) toast('could not save: ' + res.reason);
  },
  async onRestart(pane, { resume }) {
    // a detached pane's agent is still running — reconnect, don't respawn
    if (pane.detached) {
      if (await reattachPane(pane)) {
        pane.focus();
        toast('reconnected to ' + pane.session.agentName);
      } else {
        toast('agent is gone — ↻ now restarts it');
      }
      syncChrome();
      return false;
    }
    const s = pane.session;
    const res = await window.swarm.restartSession({
      workspaceId: s.workspaceId,
      workspaceName: s.workspaceName,
      agentName: s.agentName,
      cwd: s.cwd,
      cols: pane.term.cols,
      rows: pane.term.rows,
      resume,
      role: s.role,
    });
    if (!res.ok) {
      toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not restart: ' + res.reason);
      return false;
    }
    if (resume && !res.resumed) toast('no previous conversation in this folder — started fresh');
    const fresh = new Pane(res.session, paneHandlers, { managed: pane.managed });
    state.panes.delete(s.id);
    state.panes.set(res.session.id, fresh);
    grid.replace(pane, fresh);
    if (state.lastFocused === pane) state.lastFocused = fresh;
    flushPending(fresh);
    syncChrome();
    requestAnimationFrame(() => {
      fresh.refit();
      fresh.focus();
    });
    return fresh;
  },
};

/* Reconnect the attach client of a detached pane (same session id, so data
 * keeps flowing into the same terminal). False = the agent is really gone. */
async function reattachPane(pane) {
  const res = await window.swarm.reattachSession(pane.session.id, pane.term.cols, pane.term.rows);
  if (res.ok) {
    pane.markReattached();
    return true;
  }
  pane.markExited(pane.exitCode == null ? '?' : pane.exitCode, false);
  return false;
}

function flushPending(pane) {
  const buffered = pendingOutput.get(pane.session.id);
  if (buffered) {
    pane.write(buffered.data);
    clearTimeout(buffered.timer);
    pendingOutput.delete(pane.session.id);
  }
}

function mountPane(session, { managed = false, refPane, direction } = {}) {
  const pane = new Pane(session, paneHandlers, { managed });
  pane.setGit(state.git[session.workspaceId]);
  state.panes.set(session.id, pane);
  recordTimeline(pane); // the lane starts the moment the agent does
  if (session.workspaceId === state.selectedWorkspaceId) {
    if (refPane) grid.insertSplit(pane, refPane, direction);
    else grid.add(pane);
    requestAnimationFrame(() => pane.refit());
  }
  flushPending(pane);
  syncRendererReclaim(); // an agent started in a workspace you're not watching
  syncChrome();
  return pane;
}

// refPane/direction (from a pane's → / ↓ button) position the new agent
// relative to an existing one — see GridController.insertSplit.
// keepView: the caller is showing a full view (the map) and wants to stay
// there, so leave the grid hidden and don't hand keyboard focus to a terminal
// nobody can see.
async function addAgent({ refPane, direction, role, keepView } = {}) {
  if (!state.selectedWorkspaceId) {
    toast('add and select a workspace first');
    return;
  }
  if (liveAgentCount() >= maxAgents) {
    toast(`limit of ${maxAgents} sessions reached`);
    return;
  }
  // same Options default the Task Board pre-fills, applied as a --model launch
  // flag so it can't bleed into Claude's own saved default (see startTask).
  // A role brings its own model (main/sessions.js ROLES) — sending the default
  // as well would override it, so a picked role means "let the role decide".
  const defaultModel = localStorage.getItem('swarmeye.defaultModel');
  const modelArg = !role && defaultModel && defaultModel !== 'default' ? defaultModel : undefined;
  const res = await window.swarm.createSession(state.selectedWorkspaceId, 100, 30, modelArg, undefined, role);
  if (!res.ok) {
    toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not start session: ' + res.reason);
    return;
  }
  if (!keepView) toggleBoard(false);
  const pane = mountPane(res.session, { refPane, direction });
  if (!keepView) pane.focus();
  setTimeout(() => startManualSession(res.session.id), TASK_INJECT_FALLBACK_MS);
  return pane;
}

window.swarm.onSessionData(({ id, data }) => {
  const pane = state.panes.get(id);
  if (pane) {
    pane.write(data);
  } else {
    // don't hoard output for sessions whose pane never materializes: keep
    // only the newest 200KB, and drop the entry 30s after the *last* chunk
    // (one timer per entry — a timer armed by an early chunk must not throw
    // away output that arrived just before it fired)
    const entry = pendingOutput.get(id) || { data: '', timer: null };
    entry.data = (entry.data + data).slice(-200000);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => pendingOutput.delete(id), 30000);
    pendingOutput.set(id, entry);
  }
});

window.swarm.onSessionExit(({ id, exitCode, detached }) => {
  const pane = state.panes.get(id);
  // a real exit (not a mere tmux-detach) orphans any active linked task —
  // it re-enters the queue below instead of being lost or falsely marked done
  const orphanedTask = detached ? null : state.tasks.find((t) => t.paneId === id && t.status === 'active');
  if (pane) {
    pane.markExited(exitCode, detached);
    recordTimeline(pane); // an exit closes the lane's last band
    if (detached) pushNotif(pane, 'detach', 'detached — agent still running, ↻ reconnects');
    else pushNotif(pane, 'exit', `exited (${exitCode})`);
    syncChrome();
  }
  pendingOutput.delete(id);
  pendingTaskStarts.delete(id);
  awaitingTaskTurn.delete(id);
  skillInjectAttempted.delete(id);
  manualStartRun.delete(id);
  sessionStarted.delete(id);
  if (orphanedTask) {
    orphanedTask.status = 'pending';
    orphanedTask.paneId = null;
    window.swarm.updateTask(orphanedTask.id, { status: 'pending', paneId: null });
    renderBoard();
  }
  runScheduler(); // a freed slot may unblock a queued auto task
});

// precise agent state from Claude Code hooks (working / waiting / done)
window.swarm.onSessionState((payload) => {
  const pane = state.panes.get(payload.id);
  if (pane) pane.applyHookEvent(payload);
  if (payload.summary) applyTaskSummary(payload.id, payload.summary);
  // the task's own turn has begun — from here a Stop is its completion. Every
  // event but Stop (and SessionStart, which precedes the prompt) says the
  // agent is live on the prompt we just sent it.
  if (['UserPromptSubmit', 'PreToolUse', 'Notification'].includes(payload.event)) awaitingTaskTurn.delete(payload.id);
  // SessionStart = claude's CLI is up — the readiness signal for injecting
  // active skills (every session) and a task's initial prompt (task
  // sessions only; see tryInjectPrompt's and tryInjectSkills's own fallback
  // timers too, for sessions whose hooks never fire)
  if (payload.event === 'SessionStart') {
    sessionStarted.add(payload.id); // claude's CLI is up: it reads keys from here on
    if (pendingTaskStarts.has(payload.id)) {
      // tryInjectPrompt injects the skills itself first — scheduling both here
      // would type the task text into the middle of a half-entered /command
      setTimeout(() => tryInjectPrompt(payload.id), TASK_INJECT_SETTLE_MS);
    } else {
      setTimeout(() => startManualSession(payload.id), TASK_INJECT_SETTLE_MS);
    }
  }
});

window.swarm.onGitUpdate((info) => {
  state.git = info || {};
  for (const pane of state.panes.values()) pane.setGit(state.git[pane.session.workspaceId]);
  if (!boardEl.hidden) renderBoard(); // keep board branch chips current while it's open
});

/* ---- rate-limit warning ----
 * The rail's gauges already colour themselves amber past 75% and red past 90%,
 * but that only helps while you're looking at them; with a swarm running you
 * can walk into the ceiling and only find out when agents start failing
 * mid-turn. Toast once per crossing, at the same two thresholds the gauges
 * change colour at, so the warning and the gauge always agree.
 *
 * Armed level per window: 0 none, 1 warn, 2 crit. It only ever fires on the
 * way up; dropping back below a threshold (or the window resetting, which
 * moves resetsAt) re-arms it for the next time. */
const USAGE_WARN_PCT = 75;
const USAGE_CRIT_PCT = 90;
const USAGE_WINDOWS = [['fiveHour', '5-hour'], ['weekly', 'weekly']];
const usageWarned = { fiveHour: { level: 0, resetsAt: null }, weekly: { level: 0, resetsAt: null } };

function checkUsageWarnings(snapshot) {
  // no data is not 0% — a degraded or stale snapshot says nothing about the
  // quota, so it must neither warn nor clear an already-armed level
  if (!snapshot || !snapshot.ok || snapshot.stale) return;
  const crossed = [];
  for (const [key, label] of USAGE_WINDOWS) {
    const w = snapshot[key];
    const state = usageWarned[key];
    if (!w || typeof w.usedPct !== 'number') continue;
    if (w.resetsAt !== state.resetsAt) { // a fresh window starts unwarned
      state.resetsAt = w.resetsAt;
      state.level = 0;
    }
    const level = w.usedPct >= USAGE_CRIT_PCT ? 2 : w.usedPct >= USAGE_WARN_PCT ? 1 : 0;
    if (level > state.level) {
      const resets = w.resetsAt ? ' · resets in ' + Topbar.fmtIn(new Date(w.resetsAt) - Date.now()) : '';
      crossed.push(level === 2
        ? `${label} usage ${w.usedPct}% — agents may start failing${resets}`
        : `${label} usage at ${w.usedPct}%${resets}`);
    }
    state.level = level;
  }
  // one toast at a time: both windows crossing on the same poll share it
  if (crossed.length) toast('⚠ ' + crossed.join(' · '));
}

window.swarm.onUsageUpdate((snapshot) => {
  Topbar.renderUsage(snapshot);
  usageSnapshot = snapshot;
  // each pane's cost panel measures its own burn against this window
  Pane.setUsageWindow(snapshot && snapshot.ok ? snapshot.fiveHour : null);
  checkUsageWarnings(snapshot);
  runScheduler();
});

/* index.html spells every shortcut the Windows way. On macOS the modifier is
 * Cmd, and the labels use the glyphs users expect there. Two labels stay Ctrl
 * on both platforms and opt out with data-keep-ctrl: Ctrl+Tab (Cmd+Tab is the
 * macOS app switcher) and Ctrl+I (a literal tab byte for the terminal). */
function localizeShortcutLabels() {
  if (!IS_MAC) return;
  const toMac = (t) => t.replace(/Ctrl\+Shift\+/g, '⌘⇧').replace(/Ctrl\+/g, '⌘');
  for (const el of document.querySelectorAll('kbd:not([data-keep-ctrl])')) {
    el.textContent = toMac(el.textContent);
  }
  for (const el of document.querySelectorAll('[data-tip], [aria-label]')) {
    if (el.hasAttribute('data-keep-ctrl')) continue;
    if (el.dataset.tip) el.dataset.tip = toMac(el.dataset.tip);
    const label = el.getAttribute('aria-label');
    if (label) el.setAttribute('aria-label', toMac(label));
  }
}
localizeShortcutLabels();

/* ---- WSL health + detached agents ---- */

const healthBanner = document.getElementById('health-banner');
const reattachAllBtn = document.getElementById('reattach-all');

window.swarm.onHealthUpdate(({ wsl }) => {
  healthBanner.hidden = wsl !== false;
});

reattachAllBtn.addEventListener('click', async () => {
  const detached = [...state.panes.values()].filter((p) => p.detached);
  let ok = 0;
  for (const pane of detached) {
    if (await reattachPane(pane)) ok += 1;
  }
  toast(`reconnected ${ok} of ${detached.length} agent${detached.length > 1 ? 's' : ''}`);
  syncChrome();
});

/* ---- update: topbar pill + Options row ----
 * The pill is just an at-a-glance indicator; clicking it opens the same
 * Options row the update actually happens in, rather than a browser tab. */
const updatePillEl = document.getElementById('update-pill');
const updateStatusEl = document.getElementById('update-status');
const updateActionBtn = document.getElementById('update-action-btn');
let pendingUpdate = null; // { version, releaseUrl }

window.swarm.getAppVersion().then((version) => {
  if (!pendingUpdate) updateStatusEl.textContent = `v${version} — up to date`;
});

updateActionBtn.addEventListener('click', () => {
  if (updateActionBtn.dataset.action === 'install') {
    updateActionBtn.disabled = true;
    window.swarm.installUpdate();
    return;
  }
  updateActionBtn.disabled = true;
  updateStatusEl.textContent = `v${pendingUpdate.version} — downloading…`;
  window.swarm.downloadUpdate();
});

window.swarm.onUpdateAvailable(({ version, releaseUrl }) => {
  pendingUpdate = { version, releaseUrl };
  updateStatusEl.textContent = `v${version} available`;
  updateActionBtn.textContent = 'Download';
  updateActionBtn.dataset.action = 'download';
  updateActionBtn.disabled = false;
  updateActionBtn.hidden = false;

  updatePillEl.textContent = `v${version} available`;
  updatePillEl.dataset.tip = 'A newer SwarmEye is ready — click to update';
  updatePillEl.hidden = false;
  updatePillEl.onclick = () => kbdHelpBtn.click();
});

window.swarm.onUpdateProgress(({ percent }) => {
  if (!pendingUpdate) return;
  updateStatusEl.textContent = `v${pendingUpdate.version} — downloading… ${percent}%`;
});

window.swarm.onUpdateReady(() => {
  if (!pendingUpdate) return;
  updateStatusEl.textContent = `v${pendingUpdate.version} ready to install`;
  updateActionBtn.textContent = 'Restart & Update';
  updateActionBtn.dataset.action = 'install';
  updateActionBtn.disabled = false;
});

window.swarm.onUpdateError(({ error }) => {
  toast('update failed: ' + error);
  if (!pendingUpdate) return;
  updateStatusEl.textContent = `v${pendingUpdate.version} available`;
  updateActionBtn.textContent = 'Download';
  updateActionBtn.dataset.action = 'download';
  updateActionBtn.disabled = false;
});

/* ---- messages between agents ----
 * One line, addressed with @name (several names allowed) or @all, written
 * straight into those sessions. The two-write channel is the same one a task's
 * prompt goes down — text, a beat, then Enter — so Claude's input box sees a
 * real keystroke instead of a pasted chunk with a newline in it. */
const msgPopEl = document.getElementById('msg-pop');

Messenger.init({
  listAgents: () => [...state.panes.values()]
    .filter((p) => !p.exited)
    .map((p) => ({ id: p.session.id, name: p.session.agentName, ws: p.session.workspaceName })),
  async send(ids, text) {
    for (const id of ids) {
      window.swarm.writeSession(id, text);
      await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
      window.swarm.writeSession(id, '\r');
    }
    toast(`message sent to ${ids.length} agent${ids.length === 1 ? '' : 's'}`);
  },
});

/* ---- global search across all agents ---- */

const gsearchEl = document.getElementById('gsearch');
const gsearchBtnEl = document.getElementById('gsearch-btn');
const gsInput = document.getElementById('gs-input');
const gsResults = document.getElementById('gs-results');
let gsTimer = null;

function toggleGlobalSearch(show) {
  if (show) {
    // anchor the popup right below the button (the top bar can be zoomed)
    const r = gsearchBtnEl.getBoundingClientRect();
    gsearchEl.style.top = Math.round(r.bottom + 8) + 'px';
    gsearchEl.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  }
  gsearchEl.hidden = !show;
  if (show) {
    gsInput.focus();
    gsInput.select();
    runGlobalSearch();
  } else {
    const pane = focusedPane();
    if (pane) pane.term.focus();
  }
}

function runGlobalSearch() {
  const q = gsInput.value.trim().toLowerCase();
  gsResults.innerHTML = '';
  if (q.length < 2) return;
  let total = 0;
  for (const pane of state.panes.values()) {
    const lines = pane.getBufferText().split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) hits.push(i);
    }
    if (!hits.length) continue;
    total += hits.length;
    const group = document.createElement('div');
    group.className = 'gs-group';
    const head = document.createElement('div');
    head.className = 'gs-head';
    head.textContent = `${pane.session.agentName} · ${pane.session.workspaceName} · ${hits.length} match${hits.length > 1 ? 'es' : ''}`;
    group.appendChild(head);
    for (const i of hits.slice(0, 4)) {
      const row = document.createElement('div');
      row.className = 'gs-row';
      row.textContent = lines[i].trim().slice(0, 160) || '(blank line)';
      row.dataset.tip = 'Jump to this match';
      row.addEventListener('click', () => jumpToMatch(pane, i, gsInput.value.trim()));
      group.appendChild(row);
    }
    if (hits.length > 4) {
      const more = document.createElement('div');
      more.className = 'gs-more';
      more.textContent = `… ${hits.length - 4} more — jump in and use the pane search`;
      group.appendChild(more);
    }
    gsResults.appendChild(group);
  }
  if (!total) {
    const none = document.createElement('div');
    none.className = 'gs-none';
    none.textContent = 'no matches in any agent';
    gsResults.appendChild(none);
  }
}

async function jumpToMatch(pane, line, q) {
  toggleGlobalSearch(false);
  toggleBoard(false);
  if (pane.session.workspaceId !== state.selectedWorkspaceId) {
    await selectWorkspace(pane.session.workspaceId);
  }
  pane.focus();
  pane.term.scrollToLine(line);
  pane.searchInput.value = q;
  pane.toggleSearch(true);
  pane.search.findNext(q);
}

gsInput.addEventListener('input', () => {
  clearTimeout(gsTimer);
  gsTimer = setTimeout(runGlobalSearch, 200);
});
gsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { toggleGlobalSearch(false); e.preventDefault(); }
  e.stopPropagation();
});
// click outside the popup closes it
document.addEventListener('click', (e) => {
  if (!gsearchEl.hidden && !gsearchEl.contains(e.target)) toggleGlobalSearch(false);
});
gsearchBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleGlobalSearch(gsearchEl.hidden);
});

document.getElementById('add-workspace').addEventListener('click', addWorkspace);
/* + Coding Agent opens a small popover under the button: a plain Claude, then
 * the role presets (each launches with its own system prompt and model tier —
 * main/sessions.js owns both).
 * (Ctrl/Cmd+N always spawns a plain Claude; a pane's → / ↓ splits inherit its
 * role.) */
const addAgentBtn = document.getElementById('add-agent');
let agentKindMenuEl = null;
let roles = []; // [{key, label, model}] — from main, once
window.swarm.listRoles().then((list) => { roles = list || []; });

function closeAgentKindMenu() {
  if (!agentKindMenuEl) return;
  agentKindMenuEl.remove();
  agentKindMenuEl = null;
  document.removeEventListener('mousedown', onAgentKindDismiss, true);
}
function onAgentKindDismiss(e) {
  if (!agentKindMenuEl.contains(e.target) && e.target !== addAgentBtn) closeAgentKindMenu();
}
addAgentBtn.addEventListener('click', () => {
  if (agentKindMenuEl) { closeAgentKindMenu(); return; }
  const menu = document.createElement('div');
  menu.className = 'branch-menu';
  const entries = [{ label: 'Claude', tip: 'A plain agent — your Options default model, no role prompt' }];
  for (const r of roles) entries.push({ label: r.label, role: r.key, tip: `${r.label} role prompt · ${r.model}` });
  for (const { label, role, tip } of entries) {
    const row = document.createElement('button');
    row.className = 'branch-item';
    row.textContent = label;
    row.dataset.tip = tip;
    row.addEventListener('click', () => {
      closeAgentKindMenu();
      addAgent({ role });
    });
    menu.appendChild(row);
  }
  const r = addAgentBtn.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  document.body.appendChild(menu);
  agentKindMenuEl = menu;
  document.addEventListener('mousedown', onAgentKindDismiss, true);
});
// the number and the gauges are two elements showing one thing — clicking
// either refreshes it
async function refreshUsageNow() {
  const snap = await window.swarm.refreshUsage();
  Topbar.renderUsage(snap);
  usageSnapshot = snap;
  checkUsageWarnings(snap);
  runScheduler();
}
for (const id of ['usage', 'usage-gauges']) {
  document.getElementById(id).addEventListener('click', refreshUsageNow);
}

/* a file dropped outside a terminal must not navigate the window away —
 * panes handle their own drops; everywhere else the drop is swallowed */
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* re-measure terminals once the custom mono font is ready — cell metrics
 * taken against the fallback font are slightly off, which can leave the
 * last row half-clipped under the pane border */
document.fonts.ready.then(() => {
  for (const p of state.panes.values()) {
    const s = p.term.options.fontSize;
    p.term.options.fontSize = s + 1;
    p.term.options.fontSize = s;
    p.refit();
  }
});

(async function boot() {
  const cfg = await window.swarm.getConfig();
  Topbar.setWorkspaceColors(cfg.workspaceColors); // before the first renderWorkspaces
  state.workspaces = cfg.workspaces || [];
  state.selectedWorkspaceId = cfg.selectedWorkspaceId || null;
  maxAgents = cfg.maxAgents || 10;
  maxAgentsVal.textContent = maxAgents;
  state.tasks = cfg.tasks || [];
  state.archivedTasks = cfg.archivedTasks || [];
  autoUsageLimit = cfg.autoUsageLimit ?? 85;
  autoLimitVal.textContent = autoUsageLimit + '%';
  // straight from the stored value: applySkipPermissions would push it back to
  // main, which already has it
  skipPermissionsToggle.checked = !!cfg.skipPermissions;
  Pane.setSkipPermissions(!!cfg.skipPermissions);
  Preview.init({ getWorkspaceId: () => state.selectedWorkspaceId });
  syncChrome();
  renderBoard();

  // reattach agents that survived the last app run (tmux)
  const { sessions } = await window.swarm.listSessions();
  for (const session of sessions) mountPane(session);
  if (sessions.length) toast(`reattached ${sessions.length} running agent${sessions.length > 1 ? 's' : ''}`);

  // a task left "active" whose agent didn't come back (tmux itself died, not
  // just the app — WSL restart, host reboot, tmux missing) would otherwise sit
  // stuck forever pointing at a pane that will never exist in this run, since
  // onSessionExit only fires for sessions that are actually live to exit.
  // Re-run it in a fresh agent, same as a queued task starting.
  const liveIds = new Set(sessions.map((s) => s.id));
  const orphaned = state.tasks.filter((t) => t.status === 'active' && !liveIds.has(t.paneId));
  for (const task of orphaned) {
    task.status = 'pending';
    task.paneId = null;
    window.swarm.updateTask(task.id, { status: 'pending', paneId: null });
    await startTask(task);
  }
  if (orphaned.length) toast(`resumed ${orphaned.length} task${orphaned.length > 1 ? 's' : ''} in a new agent — previous one didn't survive the restart`);
  renderBoard();

  runScheduler(); // pick up any pending "auto" tasks now instead of waiting for the interval below
  // periodic safety net: catches any missed usage/session-exit trigger
  setInterval(runScheduler, 5000);
})();
