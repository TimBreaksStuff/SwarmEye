/* App state + wiring. The grid shows only the selected workspace's agents;
 * agents in other workspaces keep running hidden.
 *
 * Every feature is a module and every edge below is an import. There is no
 * load order to keep any more: boot.js is the entry, every edge is an import,
 * and what each file needs it says at the top of itself. */

/* The features that were classic scripts until this sweep. They published a
 * global and app.js read it; now they export and app.js imports, which is the
 * only reason index.html no longer carries a hand-sorted <script> list. */
import { Pane } from './features/pane/index.js';
import { Board } from './features/board/board.js';
import { GridController } from './features/grid/grid.js';
import { Topbar } from './features/rail/topbar.js';
import { Launcher } from './features/launcher/launcher.js';
import { Preview } from './features/preview/preview.js';
import { Palette } from './features/palette/palette.js';
import { Skills } from './features/skills/skills.js';
import { Coordinator } from './features/coordinator/coordinator.js';
import { Sounds } from './features/sounds/sounds.js';
import { Speech } from './features/speech/speech.js';
import { OpenRouterUI } from './features/openrouter/openrouter.js';
import { toast } from './lib/toast.js';

/* The two areas lifted out of this file. Workspaces owns the list and what is
 * done to it; shortcuts owns the keyboard map and the Escape chain. Both take
 * the state and the verbs they need from here, because this is still where
 * the state and the agent lifecycle live. */
import {
  init as initWorkspaces,
  selectWorkspace,
  killSessionChecked,
  removeWorkspace,
  renameWorkspace,
  reorderWorkspaces,
  cycleWorkspace,
} from './features/workspaces/workspaces.js';
import {
  init as initShortcuts,
  focusedPane,
  isShortcut,
} from './features/shortcuts/shortcuts.js';

/* Wired by being loaded: the hover tooltip's delegated listeners and the
 * rail's drag-to-resize grip. Neither exports anything. */
import './lib/tooltip.js';
import './features/rail/railgrip.js';

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
  // the launch sequence, as verbs. The scheduler owns what a just-created
  // session still owes; this file only reports what happened to it.
  forgetSession,
  noteManualLaunch,
  noteSessionStarted,
  noteAgentTurn,
  isStartingUp,
  TASK_INJECT_FALLBACK_MS,
  startManualSession,
  renderBoard,
  renderArchive,
  runScheduler,
  effortFlagValue,
  startTask,
  applyTaskSummary,
  startChain,
  startRepeat,
  noteStartFailure,
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
import { init as initAddAgentMenu } from './features/addagent/addagent.js';
import { check as checkUsageWarnings } from './features/usage/usage-warnings.js';

const grid = new GridController(document.getElementById('grid'));
const gridWrapEl = document.getElementById('grid-wrap');
const emptyState = document.getElementById('empty-state');
Launcher.init(emptyState, emptyState.querySelector('.big'), emptyState.querySelector('.empty-hint'),
  (n, settings) => spawnAgents(n, settings));
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

/* main.js's SWARMEYE_TEST dump used to read `state` and `grid` off the global
 * scope; both are module-locals. It asks through this instead. */
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
    // the pane's own half of "nobody is looking at this": it skips the header
    // chips of a scan while off screen, and catches them up on the way back
    pane.setOnScreen(visible.has(id));
    const timer = reclaimTimers.get(id);
    if (visible.has(id)) {
      if (timer) { clearTimeout(timer); reclaimTimers.delete(id); }
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
  // ...and the other half: a single workspace can hold more panes than the
  // page has WebGL contexts, which the reclaim above never sees
  Pane.applyRendererBudget(grid.panes);
  /* main batches a session's pty output before it crosses IPC; the ones
   * behind the grid get the slow batch (see queuePtyData). Pushed from here
   * because this is the one place that knows which panes are on screen. */
  window.swarm.setVisibleSessions([...visible]);
}



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
    /* A detached pane's agent is still running in tmux and closing the pane
     * has always left it there, so it is the one case that stays untouched.
     * Everything else goes through main: a live agent to kill, and — for a
     * pane that already exited — nothing to kill but a worktree to land
     * (main/worktree.js), which kill() does on the way out. */
    if (!pane.exited || !pane.detached) killSessionChecked(pane.session.id);
    // closing a still-active task's agent window is how you stop it — send
    // the task to Completed marked 'stopped' instead of leaving it stuck in
    // Active forever. A task already completed (onStatusChange below) has no
    // 'active' status left to match, so that path never double-fires this.
    const task = state.tasks.find((t) => t.paneId === pane.session.id && t.status === 'active');
    if (task) {
      task.status = 'completed';
      task.completedAt = Date.now();
      task.stopped = true;
      // main files the transcript away under the task's id (main/tasklogs.js);
      // the copy kept here is what the board's popup reads until a reload
      task.sessionLog = pane.getBufferText();
      task.hasSessionLog = true;
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
      const injecting = isStartingUp(pane.session.id);
      const task = injecting ? null : state.tasks.find((t) => t.paneId === pane.session.id && t.status === 'active');
      if (task) {
        task.status = 'completed';
        task.completedAt = Date.now();
        task.sessionLog = pane.getBufferText(); // filed away by main — see onClose
        task.hasSessionLog = true;
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
  if (launch) noteManualLaunch(res.session.id, launch);
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
  forgetSession(id);
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
  if (['UserPromptSubmit', 'PreToolUse', 'Notification'].includes(payload.event)) noteAgentTurn(payload.id);
  // SessionStart = claude's CLI is up — the readiness signal for injecting
  // active skills (every session) and a task's initial prompt (task
  // sessions only; see tryInjectPrompt's and tryInjectSkills's own fallback
  // timers too, for sessions whose hooks never fire)
  if (payload.event === 'SessionStart') noteSessionStarted(payload.id);
});

/* Every pane reads its workspace's git entry (main/git.js) — unless it has a
 * worktree of its own, which is polled under its session id and is the branch
 * the agent is actually on. */
function gitFor(session) {
  return state.git['wt:' + session.id] || state.git[session.workspaceId];
}

window.swarm.onGitUpdate((info) => {
  state.git = info || {};
  for (const pane of state.panes.values()) pane.setGit(gitFor(pane.session));
  if (!boardEl.hidden) renderBoard(); // keep board branch chips current while it's open
});

/* What became of a closed agent's worktree (main/worktree.js). A merge that
 * landed is worth one line; a branch that had to be kept is worth naming,
 * because nothing else will mention it again. */
window.swarm.onWorktreeNotice((res) => {
  if (!res) return;
  if (res.state === 'merged') {
    toast(`merged ${res.branch} into ${res.base} (${res.commits} commit${res.commits === 1 ? '' : 's'})`);
  } else if (res.state === 'kept') {
    const why = res.reason === 'moved' ? `${res.base} is not checked out any more`
      : res.reason === 'unreachable' ? 'the shell could not be reached'
        : 'the merge did not apply cleanly';
    toast(`kept branch ${res.branch} — ${why}`);
  }
});

window.swarm.onUsageUpdate((snapshot) => {
  Topbar.renderUsage(snapshot);
  setUsageSnapshot(snapshot);
  // each pane's cost panel measures its own burn against this window
  Pane.setUsageWindow(snapshot && snapshot.ok ? snapshot.fiveHour : null);
  checkUsageWarnings(snapshot, toast);
  runScheduler();
});

/* Escape closes the innermost thing that is open — order matters, so this is
 * a list rather than a set: the first open one wins and nothing below it sees
 * the key. Elements are looked up lazily, since several are declared further
 * down this file. features/shortcuts/ drives it; it is built here because
 * every entry names another area's element and that area's close function,
 * and this is the one file that already imports all of them. */
const ESCAPABLE = [
  // outermost of the popovers: it opens over whatever view you were on, so it
  // has to go before anything it might be covering
  [() => document.getElementById('palette-pop'), () => Palette.close()],
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

/* Both areas that came out of this file. They are wired here, this late,
 * because everything they close over — the board and skills elements, the two
 * view toggles, the agent shortcuts — is declared above and would still be in
 * its temporal dead zone anywhere earlier. */
initWorkspaces({
  state,
  grid,
  syncGrid,
  syncChrome,
  panesForWs,
});

initShortcuts({
  state,
  grid,
  boardEl,
  escapable: ESCAPABLE,
  toggleBoard,
  toggleSkills,
  selectWorkspace,
  cycleWorkspace,
  newAgentShortcut,
  cloneActiveAgent,
});

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
Speech.wire(document.getElementById('voice-btn'), {
  interim: true,
  hold: true, // push-to-talk — open only while the button is held down
  onStart: () => Palette.open(),
  onResult: (text) => Palette.setQuery(text),
});


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
