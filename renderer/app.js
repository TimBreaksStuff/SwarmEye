/* App state + wiring. The grid shows only the selected workspace's agents;
 * agents in other workspaces keep running hidden.
 *
 * This is the one module script in the renderer — everything else is still a
 * classic <script>, which is why the globals below (Pane, Board, Topbar, …)
 * resolve without an import. Classic scripts all run before any module does,
 * so a feature converted to a real module can still read them; the reverse is
 * not true, which is why app.js is the file being converted first. */

import {
  init as initSettings,
  applyConfig as applySettingsConfig,
  kbdPop,
  kbdShortcutsPop,
  kbdHelpBtn,
  themeDots,
  applyTheme,
  // live bindings: settings owns these values and reassigns them, and every
  // read below sees the current one
  maxAgents,
  autoUsageLimit,
  taskSummaries,
  desktopNotifs,
  notifSpeech,
  notifSound,
} from './features/settings/settings.js';

import {
  init as initNotifications,
  notifPopEl,
  notifPanelEl,
  notifHandlers,
  pushNotif,
  renderNotifs,
  closeNotifPop,
  notifyOS,
  speakDone,
  notifMuted, // live binding: the bell's double-click mute
} from './features/notifications/notifications.js';

import {
  init as initScheduler,
  setUsageSnapshot,
  // the launch-sequence bookkeeping app.js's session lifecycle adds to and
  // clears — exported by reference, so no setter is needed
  pendingTaskStarts,
  skillInjectAttempted,
  awaitingTaskTurn,
  manualStartRun,
  manualLaunchOpts,
  sessionStarted,
  TASK_INJECT_SETTLE_MS,
  TASK_INJECT_FALLBACK_MS,
  TASK_SUBMIT_DELAY_MS,
  TASK_MODEL_SETTLE_MS,
  waitForInjectionsToSettle,
  startManualSession,
  renderBoard,
  renderArchive,
  runScheduler,
  effortFlagValue,
  startTask,
  tryInjectPrompt,
  applyTaskSummary,
  startChain,
  startRepeat,
  noteStartFailure,
  boardHandlers,
} from './features/scheduler/scheduler.js';

import {
  init as initOrchestrator,
  close as closeOrchestratorCard,
  popEl as orchPopEl,
  restore as restoreLeads,
  onWorkerDone,
  onWorkerGaveUp,
  isCrewWorker,
  hiddenIds as crewHidden,
  paintCrew,
} from './features/orchestrator/orchestrator.js';

import { init as initUpdate } from './features/update/update.js';
import {
  init as initGlobalSearch,
  toggle as toggleGlobalSearch,
  popEl as gsearchEl,
} from './features/gsearch/gsearch.js';
import { init as initAddAgentMenu } from './features/addagent/addagent.js';
import { check as checkUsageWarnings } from './features/usage/usage-warnings.js';

const grid = new GridController(document.getElementById('grid'));
const gridWrapEl = document.getElementById('grid-wrap');
const emptyState = document.getElementById('empty-state');
Launcher.init(emptyState, emptyState.querySelector('.big'), emptyState.querySelector('.empty-hint'),
  (n, settings) => spawnAgents(n, settings));
const toastEl = document.getElementById('toast');

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
/* Same reason as modHeld below: skills.js and speech.js call this by
 * name, and pane.js guards every call with `window.toast` — so since app.js
 * became a module they have been throwing and the panes have been silently
 * swallowing their toasts. */
window.toast = toast;

/* Same reason again: main.js's SWARMEYE_TEST dump read `state` and `grid` off
 * the global scope, and both became module-locals in the split — it has been
 * logging `state is not defined` ever since. It asks through this instead. */
window.__swarmTestState = () => ({
  total: state.panes.size,
  visible: grid.panes.length,
  selectedWs: state.selectedWorkspaceId,
  names: [...state.panes.values()].map((p) => p.session.agentName),
  status: [...state.panes.values()].map((p) => p.status),
});

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
  // a worker mounts through mountPane, which knows nothing about crews and puts
  // it straight in the grid — and its task only learns its pane id a beat later.
  // This is the first beat after that, so it is where the slot is reclaimed.
  const hiddenCrew = crewHidden();
  if (grid.panes.some((p) => hiddenCrew.has(p.session.id))) syncGrid();
  else paintCrew(); // statuses in the crew select stay live on this beat too
  const counts = {};
  for (const pane of state.panes.values()) {
    const id = pane.session.workspaceId;
    counts[id] = counts[id] || { n: 0, attn: false, panes: [] };
    counts[id].n += 1;
    counts[id].panes.push(pane); // the rail's fold-out agent rows
    if (pane.status === 'attention') counts[id].attn = true;
  }
  Topbar.renderWorkspaces(state.workspaces, state.selectedWorkspaceId, counts, {
    onSelect: (id) => { toggleBoard(false); selectWorkspace(id); }, // a pill always means "show me the grid"
    onOpenAgent: notifHandlers.onOpen, // a fold-out agent row focuses its pane

    onRemove: removeWorkspace,
    onReorder: reorderWorkspaces,
    onRename: renameWorkspace,
    // the rail menu's count chips. A launch always lands in the selected
    // workspace, so switch to the right-clicked one first and await it.
    onAddAgents: async (id, n) => {
      toggleBoard(false);
      await selectWorkspace(id);
      spawnAgents(n);
    },
  });
  Topbar.updateAgentCap(liveAgentCount(), maxAgents);
  emptyState.style.display = grid.panes.length ? 'none' : '';
  Launcher.sync({
    // the id, not a boolean: the card's Scope field offers this workspace's
    // own folders (renderer/features/scope/scope.js)
    workspace: state.selectedWorkspaceId,
    free: Math.max(0, maxAgents - liveAgentCount()),
  });
  reattachAllBtn.hidden = ![...state.panes.values()].some((p) => p.detached);
}

function syncGrid() {
  // a lead agent and its workers share one cell (features/orchestrator): the
  // members that aren't showing keep running unmounted, like the panes of an
  // unselected workspace. Filtered here rather than in panesForWs, which every
  // "all the agents in this workspace" caller — killing a workspace, above all
  // — must keep seeing whole.
  const hidden = crewHidden();
  grid.setPanes(panesForWs(state.selectedWorkspaceId).filter((p) => !hidden.has(p.session.id)),
    state.selectedWorkspaceId);
  paintCrew();
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

/* main refuses the kill when it can't reach tmux (the agent would be left
 * running invisibly) — the pane is already gone from the UI by then, so all
 * that's left to do is say so; the kept metadata reattaches it next launch */
function killSessionChecked(id) {
  window.swarm.killSession(id).then((res) => {
    if (res && !res.ok) toast('could not reach tmux — that agent is still running and will reattach on the next launch');
  });
}

/* removing a workspace kills its agents — armed through the app-wide Confirm
 * like every other destructive control, so an armed pane ✕ and an armed
 * workspace ✕ can never be live at once */
async function removeWorkspace(id, btn) {
  const agents = panesForWs(id);
  if (agents.length && btn) {
    const fired = Confirm.armOrFire(btn, 'ws-remove:' + id, () => doRemoveWorkspace(id));
    if (!fired) {
      const running = agents.filter((p) => !p.exited || p.detached).length;
      toast(running
        ? `this workspace has ${running} running agent${running > 1 ? 's' : ''} — click ✕ again to remove it and kill them`
        : 'click ✕ again to remove this workspace and its exited panes');
    }
    return;
  }
  doRemoveWorkspace(id, agents);
}

// the armed path re-reads the panes when it finally fires, seconds later
async function doRemoveWorkspace(id, agents = panesForWs(id)) {
  for (const pane of agents) {
    // detached panes read as exited but their tmux agent is still running —
    // kill those too, or removing the workspace would orphan live agents
    if (!pane.exited || pane.detached) killSessionChecked(pane.session.id);
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
  // the standard CLAUDE.md, if one is set and the folder had none of its own —
  // worth saying out loud, since it wrote a file into the user's repo
  if (res.template && res.template.copied) toast('CLAUDE.md added from your standard');
  syncGrid();
  syncChrome();
}

function cycleWorkspace(dir) {
  // the rail's own order — Ctrl+Tab must walk what's on screen
  const list = state.workspaces;
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
 * MOD+M                new agent copying the active one
 * MOD+.                focus the agent that has been blocked longest, then
 *                      the next one down on the press after that
 * MOD+X                close focused agent (again within 5s: confirm kill)
 * MOD+T                task board, new-task form (dashboard)
 * MOD+R                dictate — mic in the focused pane, or the task-board
 *                      form's mic if the board is open
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
/* board.js, launcher.js and coordinator.js are classic
 * scripts and call this by name: it was a global until app.js became a module,
 * and their listeners have been throwing ReferenceError on every keydown since.
 * A classic script cannot import from a module, so the predicate stays defined
 * here — the one modifier rule — and is published for them. */
window.modHeld = modHeld;

function isShortcut(e) {
  if (e.type !== 'keydown' || e.altKey) return false;
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.shiftKey) return true;
  if (e.key === 'Tab') return e.ctrlKey && !e.metaKey;
  if (!modHeld(e)) return false;
  if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') return true;
  if (e.key === '0' && !e.shiftKey) return true;
  if (e.code === 'KeyN' && !e.shiftKey) return true;
  if (e.code === 'KeyM' && !e.shiftKey) return true;
  if (e.code === 'KeyX' && !e.shiftKey) return true;
  if (e.code === 'KeyT' && !e.shiftKey) return true;
  if (e.code === 'KeyR' && !e.shiftKey) return true;
  if (e.code === 'KeyK' && !e.shiftKey) return true;
  if (e.code === 'Period' && !e.shiftKey) return true;
  if (!e.shiftKey) return false;
  return e.code === 'KeyM' || e.code === 'KeyF' || e.code === 'KeyG' || e.code === 'KeyB'
    || e.code === 'KeyS' || e.code === 'KeyE' || /^Digit\d$/.test(e.code);
}

/* MOD+. — the attention queue. Running many agents *is* answering whoever is
 * blocked, and that loop used to start with a visual scan of every pane for a
 * dot that had changed colour. Oldest wait first; pressing it again moves down
 * the queue, since the queue is re-derived on every press (a pane that started
 * waiting, or stopped, simply changes where the next press lands). */
async function focusLongestWaiting() {
  const waiting = [...state.panes.values()]
    .filter((p) => !p.exited && p.awaitingPrompt && p.waitingSince > 0)
    .sort((a, b) => a.waitingSince - b.waitingSince);
  if (!waiting.length) { toast('nobody is waiting'); return; }
  // -1 (nothing focused, or the focused pane is not in the queue) lands on the
  // oldest; the oldest itself lands on the next one down
  const at = waiting.indexOf(focusedPane());
  const pane = waiting[(at + 1) % waiting.length];
  toggleBoard(false);
  if (pane.session.workspaceId !== state.selectedWorkspaceId) {
    await selectWorkspace(pane.session.workspaceId);
  }
  pane.focus();
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

  if (e.code === 'Period' && !e.shiftKey) { focusLongestWaiting(); return true; }
  if (e.code === 'KeyK' && !e.shiftKey) { Palette.toggle(); return true; }
  if (e.code === 'KeyN' && !e.shiftKey) { newAgentShortcut(); return true; }
  if (e.code === 'KeyM' && !e.shiftKey) { cloneActiveAgent(); return true; }
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
  // outermost of the popovers: it opens over whatever view you were on, so it
  // has to go before anything it might be covering
  [() => document.getElementById('palette-pop'), () => Palette.close()],
  [() => gsearchEl, () => toggleGlobalSearch(false)],
  [() => msgPopEl, () => Messenger.close()],
  [() => kbdShortcutsPop, () => { kbdShortcutsPop.hidden = true; }],
  [() => kbdPop, () => { kbdPop.hidden = true; }],
  [() => document.getElementById('coord-modal'), () => Coordinator.close()],
  [() => orchPopEl, () => closeOrchestratorCard()],
  [() => notifPopEl, () => closeNotifPop()],
  [() => notifPanelEl, () => { notifPanelEl.hidden = true; }],
  [() => sessionViewEl, () => Board.closeSessionView()],
  // the board's category-manage popover is a top-level element, so closing the
  // board would otherwise leave it floating over the agent grid with live
  // handlers — it has to be reachable before the board itself
  [() => document.getElementById('board-category-pop'),
    () => { document.getElementById('board-category-pop').hidden = true; }],
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

/* the ⌨ options popover and its shortcuts submenu are wired in
 * features/settings/settings.js — kbdPop/kbdShortcutsPop are imported above
 * because ESCAPABLE closes over them */

initNotifications({
  state,
  toast,
  toggleBoard,
  selectWorkspace,
});

initSettings({
  state,
  grid,
  gridWrapEl,
  toast,
  syncChrome,
  runScheduler,
  renderBoard,
  notifPopEl,
  closeNotifPop,
});

/* ---- task board: queued todos for agents, started now or auto-scheduled
 * once an agent slot and usage headroom are both available ---- */

const boardEl = document.getElementById('board');
const sessionViewEl = document.getElementById('session-view'); // completed-task transcript popup, owned by board.js
// the lead agent's plan file, its workers, and the reports that go back to it
initOrchestrator({ state, toast, syncGrid });

initScheduler({
  state,
  toast,
  grid,
  liveAgentCount,
  mountPane,
  syncChrome,
  killSessionChecked,
  toggleBoard,
  selectWorkspace,
});

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
  // the board's transcript modal and its mic live outside #board-view, so
  // hiding that container alone leaves the modal painted over this screen and
  // the mic recording into a textarea nobody can see (toggleBoard's own close
  // path does the same two calls)
  Board.stopDictation?.();
  Board.closeSessionView?.();
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
    if (!pane.exited) killSessionChecked(pane.session.id);
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
    if (status === 'done') {
      // whatever it just built is on screen in the dock — refresh it
      Preview.onAgentDone(pane.session.workspaceId);
      // fired on every Stop hook, watched or not — task completion must not
      // ride on the attention path, which flagAttention suppresses while the
      // user is looking at the pane (and skips when attention is already set)
      const watching = pane.el.isConnected && pane.el.classList.contains('focused') && document.hasFocus();
      if (!watching && !isCrewWorker(pane.session.id)) {
        notifyOS(pane, 'finished its turn'); // taskbar flash + OS toast; the bell below carries the detail
        pushNotif(pane, 'done', 'finished its turn');
        if (!notifMuted) Sounds.play(notifSound);
        speakDone(pane); // "Agent X in workspace Y is finished"
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
        onWorkerDone(task); // no-op unless a lead agent queued this one
      }
    } else if (status === 'attention') {
      // the pane's status text says why (hook-driven): 'done' = turn finished
      // (already handled by the dedicated 'done' status above — a later bell
      // must not repeat it, and neither must a second OS toast), anything else
      // = blocked on the user; empty = bell/heuristic fallback
      const reason = pane.statusEl.textContent;
      if (reason !== 'done' && !isCrewWorker(pane.session.id)) {
        notifyOS(pane, reason || 'needs attention');
        pushNotif(pane, 'wait', reason || 'needs attention');
        if (!notifMuted && notifSound !== 'none') Sounds.play('alert'); // distinct from the done chime
      } else if (reason === 'done') {
        window.swarm.notify({}); // flash only — 'done' announces itself above
      }
    } else if (status === 'prompt') {
      // a yes/no menu appeared or went away — the bell's ✓/✕ (and the swarm
      // view's, via renderNotifs) follow the pane's
      renderNotifs();
    }
    syncChrome(); // keep workspace pill badges current
  },
  async onRestart(pane, { resume, model, scope }) {
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
      // only set by the pane's right-sizing offer; a plain restart comes back
      // on whatever tier it was launched with — s.model, which main persists
      // for exactly that (and, for an OpenRouter pick, so its env prefix can
      // be rebuilt).
      model: model || s.model,
      // the folder it was confined to, handed back the way the role is: the
      // deny rules live in the launch, not in the conversation being resumed.
      // The pane's scope picker passes a different one instead (null lifts it)
      scope: scope === undefined ? s.scope : scope || undefined,
      // a clean agent's conversation is keyed by the session id it ran under —
      // this is what lets its restart-with-resume continue it (main verifies)
      oldId: s.id,
    });
    if (!res.ok) {
      toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not restart: ' + res.reason);
      return false;
    }
    if (resume && !res.resumed) toast('no previous conversation in this folder — started fresh');
    if (model) toast(`${s.agentName} restarted on ${model}`);
    if (scope !== undefined) {
      toast(scope ? `${s.agentName} scoped to ${scope.label} — edits outside it are denied`
        : `${s.agentName} unscoped — may edit the whole workspace`);
    }
    for (const task of state.tasks) {
      if (task.paneId === s.id) task.paneId = res.session.id;
    }
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
  pane.setGit(gitFor(session));
  state.panes.set(session.id, pane);
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
// launch: the empty-workspace card's picks for this one launch — model here,
// the rest handed to startManualSession (see manualLaunchOpts).
async function addAgent({ refPane, direction, role, keepView, launch, claudeOnly, scope } = {}) {
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
  let defaultModel = launch ? launch.model : localStorage.getItem('swarmeye.defaultModel');
  // an explicit "Claude" provider pick must not inherit an OpenRouter
  // Options default — that menu's whole point is choosing the provider
  if (claudeOnly && OpenRouterUI.isOpenRouter(defaultModel)) defaultModel = null;
  // ... unless the caller knows the exact model rather than a default: a copy
  // of a running agent (Ctrl+M) carries both its role and the model it was
  // really on, which is the role's only when the agent never moved off it
  const roleDecides = role && !(launch && launch.model);
  const modelArg = !roleDecides && defaultModel && defaultModel !== 'default' ? defaultModel : undefined;
  // effort costs no startup turn as a launch flag, so unlike the typed-command
  // era every agent — + Agent and Ctrl+N included — gets the Options default
  const effortArg = effortFlagValue(launch ? launch.effort : undefined);
  // the folder this agent may edit inside — from the launch card's Scope
  // field, or the + Agent menu's folder picker. Main refuses the launch
  // rather than dropping a boundary it cannot honour.
  const scopeArg = scope || (launch && launch.scope) || undefined;
  const res = await window.swarm.createSession(state.selectedWorkspaceId, 100, 30, modelArg, role, effortArg, scopeArg);
  if (!res.ok) {
    toast(res.reason === 'cap' ? `limit of ${maxAgents} sessions reached` : 'could not start session: ' + res.reason);
    return;
  }
  if (launch) manualLaunchOpts.set(res.session.id, launch);
  if (!keepView) toggleBoard(false);
  const pane = mountPane(res.session, { refPane, direction });
  // not for OpenRouter models: main drops --effort there, so the chip would lie
  if (effortArg && !OpenRouterUI.isOpenRouter(modelArg)) pane.setEffort(effortArg); // launched via --effort, so no confirmation line for the buffer scan to catch
  if (!keepView) pane.focus();
  // once per launch, not per agent — keepView is false for the first one only
  if (scopeArg && !keepView) toast(`scoped to ${scopeArg.label} — edits outside it are denied`);
  setTimeout(() => startManualSession(res.session.id), TASK_INJECT_FALLBACK_MS);
  return pane;
}

/* Ctrl+N. With an OpenRouter catalog installed the shortcut asks which
 * provider first — unless Options → "New agent shortcut" (or the menu's own
 * remember checkbox, which writes the same setting) already answered. Without
 * a catalog, or without a workspace to spawn into, it stays a straight
 * addAgent — which owns the missing-workspace toast. */
function newAgentShortcut() {
  const pick = (provider) => {
    // an OpenRouter pick goes on to the same catalog menu the + Agent entry
    // uses, riding the one-launch `launch` channel; Claude keeps the plain path
    if (provider === 'openrouter') OpenRouterUI.openModelMenu(addAgentBtn, (model) => addAgent({
      launch: { model, effort: 'default', focus: null, startMode: localStorage.getItem('swarmeye.defaultStartMode') || 'default' },
    }));
    else addAgent({ claudeOnly: true });
  };
  if (!OpenRouterUI.models.length || !state.selectedWorkspaceId) return addAgent();
  const pref = localStorage.getItem('swarmeye.newAgentProvider') || 'ask';
  if (pref === 'ask') OpenRouterUI.openProviderMenu(addAgentBtn, pick);
  else pick(pref);
}

/* Ctrl+M: a copy of the agent you are looking at rather than a new one
 * off the Options defaults — its model (harness prefix and all, so an opencode
 * agent begets an opencode agent), its effort, its role and the permission mode
 * its pane is currently showing. The source is the focused pane when that pane
 * belongs to the selected workspace, else the newest live agent there; with
 * nothing to copy it falls back to the plain new-agent shortcut.
 *
 * A bare harness (clean, opencode, pi) has no permission mode to carry —
 * startManualSession skips mode steering for those, as it does for every other
 * launch. */
function cloneActiveAgent() {
  const here = (p) => p && !p.exited && p.session.workspaceId === state.selectedWorkspaceId;
  let src = focusedPane();
  if (!here(src)) {
    src = null;
    for (const p of state.panes.values()) {
      if (here(p) && (!src || (p.session.createdAt || 0) >= (src.session.createdAt || 0))) src = p;
    }
  }
  if (!src) return newAgentShortcut();
  addAgent({
    role: src.session.role,
    launch: {
      model: src.session.model, effort: src.effortLabel || 'default', focus: null,
      startMode: src.modeSel.value || 'default',
    },
  });
}

/* the empty workspace's launch card. Sequential, so main's session cap sees
 * each one and a refusal stops the run; only the first takes focus. */
async function spawnAgents(n, launch) {
  for (let i = 0; i < n; i++) {
    const pane = await addAgent({ keepView: i > 0, launch });
    if (!pane) return; // cap reached or spawn failed — addAgent has toasted
  }
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
    // a lead's worker is reported to its lead, not to the bell (isCrewWorker)
    if (isCrewWorker(id)) { /* silent: the lead speaks for its crew */ }
    else if (detached) pushNotif(pane, 'detach', 'detached — agent still running, ↻ reconnects');
    else pushNotif(pane, 'exit', `exited (${exitCode})`);
    syncChrome();
  }
  pendingOutput.delete(id);
  pendingTaskStarts.delete(id);
  awaitingTaskTurn.delete(id);
  skillInjectAttempted.delete(id);
  manualStartRun.delete(id);
  manualLaunchOpts.delete(id);
  sessionStarted.delete(id);
  if (orphanedTask) {
    orphanedTask.status = 'pending';
    orphanedTask.paneId = null;
    window.swarm.updateTask(orphanedTask.id, { status: 'pending', paneId: null });
    // an agent that dies the moment it starts would otherwise be restarted for
    // as long as the app is up — the queue's allowance is three laps
    if (!noteStartFailure(orphanedTask)) onWorkerGaveUp(orphanedTask);
    renderBoard();
  }
  runScheduler(); // a freed slot may unblock a queued auto task
});

// precise agent state from Claude Code hooks (working / waiting / done)
window.swarm.onSessionState((payload) => {
  const pane = state.panes.get(payload.id);
  if (pane) pane.applyHookEvent(payload);
  // the closing message still lands on the task card; the voice no longer
  // waits for it (see speakDone). Only from a settled read: the one a Stop
  // triggers directly carries the *previous* turn's text, because Claude Code
  // writes the message after firing the hook (main/hooks.js settleSummary).
  if (payload.summary && payload.settled) applyTaskSummary(payload.id, payload.summary);
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

/* every pane reads its workspace's git entry (main/git.js) */
function gitFor(session) {
  return state.git[session.workspaceId];
}

window.swarm.onGitUpdate((info) => {
  state.git = info || {};
  for (const pane of state.panes.values()) pane.setGit(gitFor(pane.session));
  if (!boardEl.hidden) renderBoard(); // keep board branch chips current while it's open
});

window.swarm.onUsageUpdate((snapshot) => {
  Topbar.renderUsage(snapshot);
  setUsageSnapshot(snapshot);
  // each pane's cost panel measures its own burn against this window
  Pane.setUsageWindow(snapshot && snapshot.ok ? snapshot.fiveHour : null);
  checkUsageWarnings(snapshot, toast);
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

initUpdate({ toast, openOptions: () => kbdHelpBtn.click() });

/* ---- messages between agents ----
 * One line, addressed with @name (several names allowed) or @all, written
 * straight into those sessions. The two-write channel is the same one a task's
 * prompt goes down — text, a beat, then Enter — so Claude's input box sees a
 * real keystroke instead of a pasted chunk with a newline in it. */
const msgPopEl = document.getElementById('msg-pop');

/* Everything the palette (Ctrl+K) can reach. Built fresh on every open — a
 * closed agent or a finished task must never still be offered — and kept here
 * rather than in palette.js because this is the one file that knows both the
 * app's state and what each entry should actually do. */
Palette.init({
  getItems() {
    const out = [];
    const wsName = (id) => (state.workspaces.find((w) => w.id === id) || {}).name || '?';

    for (const pane of state.panes.values()) {
      if (pane.exited) continue;
      out.push({
        group: 'agent',
        label: pane.session.agentName,
        hint: `${pane.session.workspaceName} · ${pane.status}`,
        run: () => notifHandlers.onOpen(pane.session.id), // swaps workspace and view too
      });
      // the two verbs that would otherwise mean finding the pane first. Restart
      // goes through the same handler as ↻ (which arms) — from here the palette
      // entry *is* the deliberate act, so it fires straight away.
      out.push({
        group: 'restart',
        label: 'Restart ' + pane.session.agentName,
        hint: 'keeps the conversation',
        run: () => paneHandlers.onRestart(pane, { resume: true }),
      });
      out.push({
        group: 'close',
        label: 'Close ' + pane.session.agentName,
        hint: pane.session.workspaceName,
        run: () => paneHandlers.onClose(pane),
      });
    }

    const idle = [...state.panes.values()].filter((p) => !p.exited && p.status === 'idle');
    if (idle.length) {
      out.push({
        group: 'action',
        label: `Close ${idle.length} idle agent${idle.length === 1 ? '' : 's'}`,
        hint: idle.map((p) => p.session.agentName).join(', ').slice(0, 60),
        run: () => {
          idle.forEach((p) => paneHandlers.onClose(p));
          toast(`closed ${idle.length} idle agent${idle.length === 1 ? '' : 's'}`);
        },
      });
    }

    for (const ws of state.workspaces) {
      out.push({ group: 'workspace', label: ws.name, hint: ws.path, run: () => { toggleBoard(false); selectWorkspace(ws.id); } });
      out.push({
        group: 'new agent',
        label: 'New agent in ' + ws.name,
        hint: 'spawn',
        run: async () => { await selectWorkspace(ws.id); addAgent(); },
      });
    }

    for (const t of state.tasks) {
      if (t.status === 'completed') continue;
      out.push({
        group: 'task',
        label: t.text.replace(/\s+/g, ' ').slice(0, 90),
        hint: `${t.status} · ${wsName(t.workspaceId)}`,
        run: () => toggleBoard(true),
      });
      // "run task Y" — anything not already running can be started from here
      // instead of finding its card and pressing ▶
      if (t.status !== 'active') {
        out.push({
          group: 'run task',
          label: 'Run now · ' + t.text.replace(/\s+/g, ' ').slice(0, 80),
          hint: wsName(t.workspaceId),
          run: () => startTask(t, { notify: true }),
        });
      }
    }

    for (const s of Skills.installed()) {
      out.push({ group: 'skill', label: s.name, hint: s.repo || 'skill', run: () => toggleSkills(true) });
    }

    const views = [
      ['Agent grid', () => { toggleBoard(false); toggleSkills(false); }],
      ['Task Board', () => toggleBoard(true)],
      ['Skills', () => toggleSkills(true)],
    ];
    for (const [label, run] of views) out.push({ group: 'view', label, hint: 'open', run });

    for (const dot of themeDots) {
      out.push({ group: 'theme', label: dot.dataset.tip, hint: 'switch theme', run: () => applyTheme(dot.dataset.theme) });
    }

    out.push({ group: 'action', label: 'Message agents', hint: 'Ctrl+Shift+E', run: () => Messenger.open() });
    out.push({ group: 'action', label: 'Search across all agents', hint: 'Ctrl+Shift+G', run: () => toggleGlobalSearch(true) });
    out.push({ group: 'action', label: 'Options & shortcuts', hint: 'gear', run: () => kbdHelpBtn.click() });
    return out;
  },
});

/* The top bar's mic: dictation for the app itself rather than for one agent.
 * It fills the palette's box, so speech reaches every verb the palette already
 * has without a second intent layer — hold it, say "task board", release, press
 * Enter. Push-to-talk rather than a toggle: an app-wide mic left open listens
 * to the room. Interim results are shown as they arrive; the top match is never
 * run for you, since a mishearing would otherwise spawn or close an agent. */
window.Speech.wire(document.getElementById('voice-btn'), {
  interim: true,
  hold: true, // push-to-talk — open only while the button is held down
  onStart: () => Palette.open(),
  onResult: (text) => Palette.setQuery(text),
});

Messenger.init({
  toast,
  // the @ picker offers files from the selected workspace — a message can be
  // addressed across workspaces, but the file you are pointing at is in the
  // one you are looking at
  workspaceId: () => state.selectedWorkspaceId,
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

initGlobalSearch({ state, focusedPane, toggleBoard, selectWorkspace });

document.getElementById('add-workspace').addEventListener('click', addWorkspace);
initAddAgentMenu({
  toast,
  addAgent,
  selectedWorkspace: () => state.workspaces.find((w) => w.id === state.selectedWorkspaceId),
});

// the number and the gauges are two elements showing one thing — clicking
// either refreshes it
async function refreshUsageNow() {
  const snap = await window.swarm.refreshUsage();
  Topbar.renderUsage(snap);
  setUsageSnapshot(snap);
  checkUsageWarnings(snap, toast);
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
  OpenRouterUI.install(cfg.openrouterModels || []); // extends the model selects
  state.workspaces = cfg.workspaces || [];
  state.selectedWorkspaceId = cfg.selectedWorkspaceId || null;
  state.tasks = cfg.tasks || [];
  state.archivedTasks = cfg.archivedTasks || [];
  applySettingsConfig(cfg); // the three options main owns: cap, usage limit, skip-permissions
  Preview.init({ getWorkspaceId: () => state.selectedWorkspaceId });
  syncChrome();
  renderBoard();

  // reattach agents that survived the last app run (tmux)
  const { sessions, probeFailed } = await window.swarm.listSessions();
  for (const session of sessions) mountPane(session);
  if (sessions.length) toast(`reattached ${sessions.length} running agent${sessions.length > 1 ? 's' : ''}`);
  // lead agents whose panes came back keep watching their plan file; the rest
  // are dropped. After the mount loop, because that is what it checks against.
  restoreLeads();

  // a task left "active" whose agent didn't come back (tmux itself died, not
  // just the app — WSL restart, host reboot, tmux missing) would otherwise sit
  // stuck forever pointing at a pane that will never exist in this run, since
  // onSessionExit only fires for sessions that are actually live to exit.
  // Re-run it in a fresh agent, same as a queued task starting. Not when the
  // tmux probe failed, though — that empty session list means "couldn't reach
  // tmux", and respawning would double up every still-running task's agent.
  if (probeFailed) {
    toast('could not reach tmux — surviving agents will reattach on the next launch');
  } else {
    const liveIds = new Set(sessions.map((s) => s.id));
    const orphaned = state.tasks.filter((t) => t.status === 'active' && !liveIds.has(t.paneId));
    for (const task of orphaned) {
      task.status = 'pending';
      task.paneId = null;
      window.swarm.updateTask(task.id, { status: 'pending', paneId: null });
      await startTask(task);
    }
    if (orphaned.length) toast(`resumed ${orphaned.length} task${orphaned.length > 1 ? 's' : ''} in a new agent — previous one didn't survive the restart`);
  }
  renderBoard();

  runScheduler(); // pick up any pending "auto" tasks now instead of waiting for the interval below
  // periodic safety net: catches any missed usage/session-exit trigger
  setInterval(runScheduler, 5000);
})().catch((err) => {
  // a rejected invoke mid-boot (one bad session, a slow main) must not leave
  // the app with no panes, no scheduler and no explanation
  console.error('[boot]', err);
  try { toast('startup hit an error — some agents may not have reattached'); } catch { /* toast not ready */ }
  setInterval(runScheduler, 5000);
});
