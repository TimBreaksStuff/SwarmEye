/* App state + wiring. The grid shows only the selected workspace's agents;
 * agents in other workspaces keep running hidden. */

let maxAgents = 10; // cap on simultaneous agents — loaded from config at boot, adjustable in the ⌨ options
let autoUsageLimit = 85; // usage-% ceiling for auto-scheduled tasks — loaded at boot, adjustable in the ⌨ options

const grid = new GridController(document.getElementById('grid'));
const gridWrapEl = document.getElementById('grid-wrap');
const emptyState = document.getElementById('empty-state');
const toastEl = document.getElementById('toast');

const state = {
  workspaces: [],
  archived: [], // removed workspaces, restorable from the 🗃 popover
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
  const byStatus = { working: 0, idle: 0, exited: 0 };
  for (const pane of state.panes.values()) {
    const id = pane.session.workspaceId;
    counts[id] = counts[id] || { n: 0, attn: false };
    counts[id].n += 1;
    if (pane.status === 'attention') counts[id].attn = true;
    if (pane.status === 'exited') byStatus.exited += 1;
    else if (pane.status === 'working') byStatus.working += 1;
    else byStatus.idle += 1; // idle + attention: not doing work right now
  }
  Topbar.renderWorkspaces(state.workspaces, state.selectedWorkspaceId, counts, {
    onSelect: (id) => { toggleBoard(false); selectWorkspace(id); }, // a pill always means "show me the grid"
    onRemove: removeWorkspace,
    onReorder: reorderWorkspaces,
    onRename: renameWorkspace,
  });
  Topbar.renderArchive(state.archived, archiveHandlers);
  Topbar.updateSessionCount(grid.panes.length, liveAgentCount(), maxAgents, byStatus);
  emptyState.style.display = grid.panes.length ? 'none' : '';
  reattachAllBtn.hidden = ![...state.panes.values()].some((p) => p.detached);
}

function syncGrid() {
  grid.setPanes(panesForWs(state.selectedWorkspaceId), state.selectedWorkspaceId);
  if (state.lastFocused && !grid.panes.includes(state.lastFocused)) state.lastFocused = null;
  requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
}

async function selectWorkspace(id) {
  if (id === state.selectedWorkspaceId) return;
  state.selectedWorkspaceId = id;
  await window.swarm.selectWorkspace(id);
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
  state.archived = res.archivedWorkspaces || state.archived;
  state.selectedWorkspaceId = res.selectedWorkspaceId;
  syncGrid();
  syncChrome();
  toast('workspace archived — bring it back via 🗃');
}

async function renameWorkspace(id, name) {
  const ws = state.workspaces.find((w) => w.id === id);
  if (ws) ws.name = name; // optimistic; syncChrome() below repaints the pill
  await window.swarm.renameWorkspace(id, name);
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

const archiveHandlers = {
  async onRestore(id) {
    const res = await window.swarm.restoreWorkspace(id);
    state.workspaces = res.workspaces;
    state.archived = res.archivedWorkspaces || [];
    if (res.selectedWorkspaceId) state.selectedWorkspaceId = res.selectedWorkspaceId;
    syncGrid();
    syncChrome();
  },
  async onPurge(id) {
    const res = await window.swarm.purgeWorkspace(id);
    state.archived = res.archivedWorkspaces || [];
    syncChrome();
  },
};

async function addWorkspace() {
  const res = await window.swarm.addWorkspace();
  if (res.canceled) return;
  state.workspaces = res.workspaces;
  if (res.selectedWorkspaceId) state.selectedWorkspaceId = res.selectedWorkspaceId;
  syncGrid();
  syncChrome();
}

function cycleWorkspace(dir) {
  const n = state.workspaces.length;
  if (n < 2) return;
  const i = state.workspaces.findIndex((w) => w.id === state.selectedWorkspaceId);
  const next = state.workspaces[((i === -1 ? 0 : i) + dir + n) % n];
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
 * MOD+T                task board, new-task form (dashboard)
 * MOD+Shift+1..9,0     focus visible pane N (again: toggle maximize)
 * MOD+Shift+M          maximize/restore focused pane
 * MOD+Shift+F          search in focused pane
 * MOD+Shift+G          search across all agents
 * MOD+Shift+B          task board
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
  if (e.code === 'KeyT' && !e.shiftKey) return true;
  if (!e.shiftKey) return false;
  return e.code === 'KeyM' || e.code === 'KeyF' || e.code === 'KeyG' || e.code === 'KeyB' || /^Digit\d$/.test(e.code);
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
  if (e.code === 'KeyT' && !e.shiftKey) { toggleBoard(true); return true; }
  if (e.code === 'KeyM' && focused) { grid.toggleMax(focused); return true; }
  if (e.code === 'KeyF' && focused) { focused.toggleSearch(); return true; }
  if (e.code === 'KeyG') { toggleGlobalSearch(gsearchEl.hidden); return true; }
  if (e.code === 'KeyB') { toggleBoard(boardEl.hidden); return true; }

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
  [() => kbdShortcutsPop, () => { kbdShortcutsPop.hidden = true; }],
  [() => kbdPop, () => { kbdPop.hidden = true; }],
  [() => archivePopEl, () => { archivePopEl.hidden = true; }],
  [() => notifPopEl, () => closeNotifPop()],
  [() => notifPanelEl, () => { notifPanelEl.hidden = true; }],
  [() => sessionViewEl, () => Board.closeSessionView()],
  [() => boardEl, () => toggleBoard(false)],
  [() => skillsEl, () => toggleSkills(false)],
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
    // anchor the popover to the right of the gear tile — it sits at the
    // bottom of the icon rail, so it opens beside the rail, bottom-aligned
    const r = kbdHelpBtn.getBoundingClientRect();
    kbdPop.style.top = '';
    kbdPop.style.right = '';
    kbdPop.style.left = Math.round(r.right + 12) + 'px';
    kbdPop.style.bottom = Math.max(8, Math.round(window.innerHeight - r.bottom)) + 'px';
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
 * button: the button sits near the bottom of kbd-pop's content and kbd-pop is
 * itself bottom-anchored near the edge of the viewport, so opening downward
 * would risk running off-screen the same way the Archived popover once did. */
const kbdShortcutsPop = document.getElementById('kbd-shortcuts-pop');
const kbdShortcutsBtn = document.getElementById('kbd-shortcuts-btn');
kbdShortcutsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (kbdShortcutsPop.hidden) {
    const popRect = kbdPop.getBoundingClientRect();
    const btnRect = kbdShortcutsBtn.getBoundingClientRect();
    kbdShortcutsPop.style.left = Math.round(popRect.right + 12) + 'px';
    kbdShortcutsPop.style.bottom = Math.max(8, Math.round(window.innerHeight - btnRect.bottom)) + 'px';
  }
  kbdShortcutsPop.hidden = !kbdShortcutsPop.hidden;
});

/* archive popover */
const archivePopEl = document.getElementById('archive-pop');
const archiveBtnEl = document.getElementById('archive-btn');
archiveBtnEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (archivePopEl.hidden) {
    // anchor above the button, bottom-aligned — archive-btn sits in the
    // rail's bottom cluster (above Skills/Options), so opening downward
    // from r.bottom can push the popover below the viewport (same fix as
    // the #kbd-help popover just below it)
    const r = archiveBtnEl.getBoundingClientRect();
    archivePopEl.style.top = '';
    archivePopEl.style.bottom = Math.max(8, Math.round(window.innerHeight - r.top + 8)) + 'px';
    archivePopEl.style.left = Math.max(8, Math.round(r.left)) + 'px';
  }
  archivePopEl.hidden = !archivePopEl.hidden;
});
document.addEventListener('click', (e) => {
  if (!archivePopEl.hidden && !archivePopEl.contains(e.target)) archivePopEl.hidden = true;
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
};
document.getElementById('notif-panel-close').addEventListener('click', () => { notifPanelEl.hidden = true; });
document.getElementById('notif-panel-clear').addEventListener('click', () => notifHandlers.onClear());

/* closing the popover marks everything as read — bell back to grey */
function closeNotifPop() {
  if (notifPopEl.hidden) return;
  notifPopEl.hidden = true;
  notifUnread = 0;
  renderNotifs();
}

function renderNotifs() {
  Topbar.renderNotifications(notifs, notifUnread, notifHandlers);
  Topbar.renderNotifPanel(notifs, notifHandlers);
}

function pushNotif(pane, kind, text) {
  notifs.unshift({
    paneId: pane.session.id,
    agent: pane.session.agentName,
    ws: pane.session.workspaceName,
    kind,
    text,
    cmd: pane.initialCommandText,
    model: pane.llmEl.textContent || null,
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
 * (search, notifications, archive). The options popover is excluded: its text
 * size is owned by "Task board, Skills & Options text size" instead. */
const applyTopbarZoom = makeZoomControl({
  storageKey: 'swarmeye.topbarZoom',
  elements: () => [
    document.getElementById('topbar'),
    leftbarEl,
    document.getElementById('gsearch'),
    notifPopEl,
    archivePopEl,
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
 * popover opts in, since it launches claude with --allow-dangerously-skip-permissions */
const skipPermissionsToggle = document.getElementById('skip-permissions-toggle');
skipPermissionsToggle.addEventListener('change', () => {
  window.swarm.setSkipPermissions(skipPermissionsToggle.checked);
});

/* "Show initial command in pane header" — off by default; persisted locally
 * and pushed to every already-open pane so it reads as a single live setting */
const showInitialCmdToggle = document.getElementById('show-initial-cmd-toggle');
function applyShowInitialCommand(on) {
  showInitialCmdToggle.checked = on;
  localStorage.setItem('swarmeye.showInitialCommand', on ? '1' : '');
  Pane.setShowInitialCommand(on);
  for (const p of state.panes.values()) p.syncInitialCommandHeader();
}
showInitialCmdToggle.addEventListener('change', () => applyShowInitialCommand(showInitialCmdToggle.checked));
applyShowInitialCommand(!!localStorage.getItem('swarmeye.showInitialCommand'));

/* "Auto-organize agent windows" — on by default; off lets each pane's → / ↓
 * buttons place new agents by hand instead of the automatic square-ish grid */
const autoOrganizeToggle = document.getElementById('auto-organize-toggle');
function applyAutoOrganize(on) {
  autoOrganizeToggle.checked = on;
  localStorage.setItem('swarmeye.autoOrganize', on ? '1' : '0');
  Pane.setAutoOrganize(on);
  grid.setAutoOrganize(on);
  for (const p of state.panes.values()) p.syncSplitButtons();
}
autoOrganizeToggle.addEventListener('change', () => applyAutoOrganize(autoOrganizeToggle.checked));
applyAutoOrganize(localStorage.getItem('swarmeye.autoOrganize') !== '0');

/* colour theme — swatches in the ⌨ popover; persisted locally */
const themeDots = document.querySelectorAll('#theme-opts .theme-dot');
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('swarmeye.theme', name);
  const xt = Pane.setXtermTheme(name);
  for (const p of state.panes.values()) p.term.options.theme = xt;
  for (const dot of themeDots) dot.classList.toggle('active', dot.dataset.theme === name);
}
themeDots.forEach((dot) => dot.addEventListener('click', () => applyTheme(dot.dataset.theme)));
applyTheme(localStorage.getItem('swarmeye.theme') || 'dark');

/* "Theme background overlay" — on by default; off hides the theme-tinted
 * background grid wash while leaving in-app colours themed as normal */
const themeOverlayToggle = document.getElementById('theme-overlay-toggle');
function applyThemeOverlay(on) {
  themeOverlayToggle.checked = on;
  document.documentElement.dataset.themeOverlay = on ? 'on' : 'off';
  localStorage.setItem('swarmeye.themeOverlay', on ? '1' : '0');
}
themeOverlayToggle.addEventListener('change', () => applyThemeOverlay(themeOverlayToggle.checked));
applyThemeOverlay(localStorage.getItem('swarmeye.themeOverlay') !== '0');

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
      if (name === 'bypass' && !skipPermissionsToggle.checked) {
        skipPermissionsToggle.checked = true;
        window.swarm.setSkipPermissions(true);
      }
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
const defaultFocusToggle = document.getElementById('default-focus-toggle');
function applyDefaultFocus(on) {
  defaultFocusToggle.checked = on;
  localStorage.setItem('swarmeye.defaultFocus', on ? '1' : '');
  Board.setDefaults({ defaultFocus: on });
}
defaultFocusToggle.addEventListener('change', () => applyDefaultFocus(defaultFocusToggle.checked));
applyDefaultFocus(!!localStorage.getItem('swarmeye.defaultFocus'));

/* reset to default — restores every setting in the Options popover */
document.getElementById('options-reset-btn').addEventListener('click', async () => {
  applyLeftbarStyle('expanded');
  applyTopbarZoom(1);
  applyBoardZoom(1);
  applyAgentFontSize(Pane.DEFAULT_FONT_SIZE);
  await applyMaxAgents(10);
  await applyAutoUsageLimit(85);
  skipPermissionsToggle.checked = false;
  window.swarm.setSkipPermissions(false);
  applyShowInitialCommand(false);
  applyAutoOrganize(true);
  for (const { key } of DEFAULT_PICKERS) applyDefault[key]('default');
  applyDefaultFocus(false);
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
const defaultModeApplied = new Set(); // sessionId — manually-added agents get one attempt at the Options default mode
let usageSnapshot = null;
let schedulerRunning = false;
let schedulerQueued = false;
const TASK_INJECT_SETTLE_MS = 500; // grace after SessionStart for the mode footer to draw
const TASK_INJECT_FALLBACK_MS = 5000; // covers sessions whose hooks never fire
const TASK_SUBMIT_DELAY_MS = 150; // gap before Enter so it lands as its own keystroke, not part of a pasted chunk
const TASK_MODEL_SETTLE_MS = 600; // grace for the "/model"/"/effort"/"/focus" confirmation line to print before the prompt follows

/* Types `/<id>` for every skill marked "active" in the Skills screen, right
 * when a brand-new agent starts — task-created or the plain "+ Coding Agent"
 * button alike — so it's invoked from turn one instead of waiting on the
 * model to notice it's relevant on its own. Idempotent per session: whichever
 * trigger (SessionStart hook or the fallback timer) fires first wins. */
async function tryInjectSkills(sessionId) {
  if (skillInjectAttempted.has(sessionId)) return;
  const pane = state.panes.get(sessionId);
  if (!pane || pane.exited) return;
  skillInjectAttempted.add(sessionId);
  const active = typeof Skills !== 'undefined' ? Skills.getActiveSkills() : [];
  // a workspace-local skill only exists for agents running in that folder
  const forHere = active.filter((s) => !s.workspaceId || s.workspaceId === pane.session.workspaceId);
  for (const skill of forHere) {
    window.swarm.writeSession(sessionId, '/' + skill.command);
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
  }
}

/* Applies the "Default agent permissions" Options setting to a manually-added
 * agent (+ Coding Agent / Ctrl+N) once claude's CLI is actually up — task
 * sessions apply their own startMode via tryInjectPrompt instead, so those are
 * skipped here to avoid two Shift+Tab cyclers racing each other. Must wait for
 * readiness the same way tryInjectSkills does: calling setMode before the
 * footer draws can never detect the target mode. */
async function tryApplyDefaultMode(sessionId) {
  if (defaultModeApplied.has(sessionId) || pendingTaskStarts.has(sessionId)) return;
  const pane = state.panes.get(sessionId);
  if (!pane || pane.exited) return;
  defaultModeApplied.add(sessionId);
  const startMode = localStorage.getItem('swarmeye.defaultStartMode') || 'default';
  if (startMode !== 'default') await pane.setMode(startMode);
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
        if (Date.now() < task.targetResetsAt) continue;
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
  await tryInjectSkills(sessionId); // active skills before anything task-specific
  // set the starting permission mode before the prompt lands, so the first
  // tool call in e.g. bypass mode isn't blocked on a manual approval
  if (task.startMode !== 'default') await pane.setMode(task.startMode);
  // model is applied as a --model launch flag in startTask, not here — see
  // the comment there for why a typed `/model` command isn't used
  if (task.effort && task.effort !== 'default') {
    window.swarm.writeSession(sessionId, '/effort ' + task.effort);
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
  }
  // `/focus` is a toggle, and claude doesn't always start with it off — so
  // only send it when the footer shows it's not already active, or this
  // would just as easily switch it off as on
  if (task.focus && !pane.detectFocus()) {
    window.swarm.writeSession(sessionId, '/focus');
    await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
    window.swarm.writeSession(sessionId, '\r');
    await new Promise((r) => setTimeout(r, TASK_MODEL_SETTLE_MS));
  }
  window.swarm.writeSession(sessionId, task.text);
  await new Promise((r) => setTimeout(r, TASK_SUBMIT_DELAY_MS));
  window.swarm.writeSession(sessionId, '\r');
  pendingTaskStarts.delete(sessionId);
}

async function createTask({ text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category }) {
  if (!workspaceId) { toast('pick a workspace for this task'); return; }
  const targetResetsAt = mode === 'next-session'
    ? (usageSnapshot && usageSnapshot.fiveHour && usageSnapshot.fiveHour.resetsAt) || null
    : null;
  const res = await window.swarm.createTask({ text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category, targetResetsAt });
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
  gridWrapEl.hidden = show;
  document.getElementById('board-btn').classList.toggle('active', show);
  document.getElementById('skills-btn').classList.remove('active');
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
  gridWrapEl.hidden = show;
  document.getElementById('board-btn').classList.remove('active');
  document.getElementById('skills-btn').classList.toggle('active', show);
  if (show) Skills.refresh();
  else requestAnimationFrame(() => grid.panes.forEach((p) => p.refit()));
}
document.getElementById('skills-btn').addEventListener('click', () => toggleSkills(skillsEl.hidden));
document.getElementById('skills-close-btn').addEventListener('click', () => toggleSkills(false));

const paneHandlers = {
  getPaneInitialPrompt(sessionId) {
    const task = state.tasks.find((t) => t.paneId === sessionId);
    return task ? task.text : null;
  },
  onClose(pane) {
    if (!pane.exited) window.swarm.killSession(pane.session.id);
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
  onFocus(pane) {
    state.lastFocused = pane;
  },
  onShortcut: isShortcut,
  onSplit(pane, direction) {
    addAgent({ refPane: pane, direction });
  },
  onStatusChange(pane, status) {
    if (status === 'done') {
      // fired on every Stop hook, watched or not — task completion must not
      // ride on the attention path, which flagAttention suppresses while the
      // user is looking at the pane (and skips when attention is already set)
      const watching = pane.el.classList.contains('focused') && document.hasFocus();
      if (!watching) {
        window.swarm.notify(pane.session.agentName + ' needs attention', pane.session.workspaceName);
        pushNotif(pane, 'done', 'finished its turn');
        Sounds.play(notifSound);
      }
      const task = state.tasks.find((t) => t.paneId === pane.session.id && t.status === 'active');
      if (task) {
        task.status = 'completed';
        task.completedAt = Date.now();
        task.sessionLog = pane.getBufferText();
        window.swarm.updateTask(task.id, { status: 'completed', completedAt: task.completedAt, sessionLog: task.sessionLog });
        renderBoard();
        // a task's agent window closes with it unless the task opted out via
        // 'close on complete'; manual agents have no task to match here
        if (task.closeOnComplete !== false) paneHandlers.onClose(pane);
      }
    } else if (status === 'attention') {
      window.swarm.notify(pane.session.agentName + ' needs attention', pane.session.workspaceName);
      // the pane's status text says why (hook-driven): 'done' = turn finished
      // (already handled by the dedicated 'done' status above — a later bell
      // must not repeat it), anything else = blocked on the user; empty =
      // bell/heuristic fallback
      const reason = pane.statusEl.textContent;
      if (reason !== 'done') pushNotif(pane, 'wait', reason || 'needs attention');
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
      return;
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
    });
    if (!res.ok) {
      toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not restart: ' + res.reason);
      return;
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
  if (session.workspaceId === state.selectedWorkspaceId) {
    if (refPane) grid.insertSplit(pane, refPane, direction);
    else grid.add(pane);
    requestAnimationFrame(() => pane.refit());
  }
  flushPending(pane);
  syncChrome();
  return pane;
}

// refPane/direction (from a pane's → / ↓ button) position the new agent
// relative to an existing one — see GridController.insertSplit.
async function addAgent({ refPane, direction } = {}) {
  if (!state.selectedWorkspaceId) {
    toast('add and select a workspace first');
    return;
  }
  if (liveAgentCount() >= maxAgents) {
    toast(`limit of ${maxAgents} sessions reached`);
    return;
  }
  // same Options default the Task Board pre-fills, applied as a --model launch
  // flag so it can't bleed into Claude's own saved default (see startTask)
  const defaultModel = localStorage.getItem('swarmeye.defaultModel');
  const modelArg = defaultModel && defaultModel !== 'default' ? defaultModel : undefined;
  const res = await window.swarm.createSession(state.selectedWorkspaceId, 100, 30, modelArg);
  if (!res.ok) {
    toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not start session: ' + res.reason);
    return;
  }
  toggleBoard(false);
  mountPane(res.session, { refPane, direction }).focus();
  setTimeout(() => tryInjectSkills(res.session.id), TASK_INJECT_FALLBACK_MS);
  setTimeout(() => tryApplyDefaultMode(res.session.id), TASK_INJECT_FALLBACK_MS);
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
  if (pane) {
    pane.markExited(exitCode, detached);
    if (detached) pushNotif(pane, 'detach', 'detached — agent still running, ↻ reconnects');
    else pushNotif(pane, 'exit', `exited (${exitCode})`);
    syncChrome();
  }
  pendingOutput.delete(id);
  pendingTaskStarts.delete(id);
  skillInjectAttempted.delete(id);
  defaultModeApplied.delete(id);
  // a real exit (not a mere tmux-detach) orphans any active linked task —
  // it re-enters the queue instead of being lost or falsely marked done
  if (!detached) {
    const task = state.tasks.find((t) => t.paneId === id && t.status === 'active');
    if (task) {
      task.status = 'pending';
      task.paneId = null;
      window.swarm.updateTask(task.id, { status: 'pending', paneId: null });
      renderBoard();
    }
  }
  runScheduler(); // a freed slot may unblock a queued auto task
});

// precise agent state from Claude Code hooks (working / waiting / done)
window.swarm.onSessionState((payload) => {
  const pane = state.panes.get(payload.id);
  if (pane) pane.applyHookEvent(payload);
  // SessionStart = claude's CLI is up — the readiness signal for injecting
  // active skills (every session) and a task's initial prompt (task
  // sessions only; see tryInjectPrompt's and tryInjectSkills's own fallback
  // timers too, for sessions whose hooks never fire)
  if (payload.event === 'SessionStart') {
    setTimeout(() => tryInjectSkills(payload.id), TASK_INJECT_SETTLE_MS);
    if (pendingTaskStarts.has(payload.id)) {
      setTimeout(() => tryInjectPrompt(payload.id), TASK_INJECT_SETTLE_MS);
    } else {
      setTimeout(() => tryApplyDefaultMode(payload.id), TASK_INJECT_SETTLE_MS);
    }
  }
});

window.swarm.onGitUpdate((info) => {
  state.git = info || {};
  for (const pane of state.panes.values()) pane.setGit(state.git[pane.session.workspaceId]);
  if (!boardEl.hidden) renderBoard(); // keep board branch chips current while it's open
});

window.swarm.onUsageUpdate((snapshot) => {
  Topbar.renderUsage(snapshot);
  usageSnapshot = snapshot;
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

/* ---- update pill ---- */

window.swarm.onUpdateAvailable(({ version, url }) => {
  const pill = document.getElementById('update-pill');
  pill.textContent = `v${version} available`;
  pill.dataset.tip = 'A newer SwarmEye is on Gitea — click to open';
  pill.hidden = false;
  pill.onclick = () => window.swarm.openExternal(url);
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
document.getElementById('add-agent').addEventListener('click', addAgent);
// the number and the gauges are two elements showing one thing — clicking
// either refreshes it
async function refreshUsageNow() {
  const snap = await window.swarm.refreshUsage();
  Topbar.renderUsage(snap);
  usageSnapshot = snap;
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
  state.workspaces = cfg.workspaces || [];
  state.archived = cfg.archivedWorkspaces || [];
  state.selectedWorkspaceId = cfg.selectedWorkspaceId || null;
  maxAgents = cfg.maxAgents || 10;
  maxAgentsVal.textContent = maxAgents;
  state.tasks = cfg.tasks || [];
  state.archivedTasks = cfg.archivedTasks || [];
  autoUsageLimit = cfg.autoUsageLimit ?? 85;
  autoLimitVal.textContent = autoUsageLimit + '%';
  skipPermissionsToggle.checked = !!cfg.skipPermissions;
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
