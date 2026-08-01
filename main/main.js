const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, crashReporter, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { PtyManager, ROLES, NOTES_REL } = require('./sessions');
const { UsageMonitor } = require('./usage');
const { HookMonitor } = require('./hooks');
const { GitMonitor, listBranches, checkoutBranch, diffStat } = require('./git');
const { HealthMonitor } = require('./health');
const { listSessions: listHistory, readSession: readHistory, deleteSessions: deleteHistory } = require('./history');
const { IS_WIN } = require('./platform');
const { UpdateChecker } = require('./update');
const { SpeechBridge } = require('./speech');
const { SkillsManager } = require('./skills');
const coordinator = require('./coordinator');

let win = null;
let ptys = null;
let usage = null;
let ptysReady = null;
let hooks = null;
let git = null;
let health = null;
let updates = null;
let skills = null;
let heartbeatTimer = null;

// writes local minidumps to userData/Crashpad on a native crash (GPU/renderer/
// main) so a silent crash leaves *something* to inspect afterwards
crashReporter.start({ uploadToServer: false, compress: true });

function sendToWin(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* pty output is coalesced per session before crossing IPC: node-pty emits
 * bursts of small chunks under fast output, and forwarding each one wakes
 * the renderer per chunk. One ~16ms batch per session keeps scrolling
 * smooth while cutting IPC message count by an order of magnitude when
 * several agents stream at once. */
const ptyBuffers = new Map(); // sessionId -> queued output
let ptyFlushTimer = null;
function flushPtyBuffers() {
  clearTimeout(ptyFlushTimer);
  ptyFlushTimer = null;
  for (const [id, data] of ptyBuffers) sendToWin('session:data', { id, data });
  ptyBuffers.clear();
}
function queuePtyData(id, data) {
  ptyBuffers.set(id, (ptyBuffers.get(id) || '') + data);
  if (!ptyFlushTimer) ptyFlushTimer = setTimeout(flushPtyBuffers, 16);
}

/* Ungated on purpose — callers are either crash/hang handlers (rare, and
 * always worth a trace) or debugLog below, which does the SWARMEYE_DEBUG
 * check itself. */
function appendLog(line) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'swarmeye.log'),
      new Date().toISOString() + ' ' + line + '\n'
    );
  } catch { /* ignore */ }
}

/* cleanShutdown/lastHeartbeat change every 20s — they live in their own tiny
 * file so the heartbeat doesn't rewrite all of config.json (which can grow
 * large with archived task logs) three times a minute. */
const runstateFile = () => path.join(app.getPath('userData'), 'runstate.json');
function readRunstate() {
  try { return JSON.parse(fs.readFileSync(runstateFile(), 'utf8')); } catch { return null; }
}
function writeRunstate(state) {
  try { fs.writeFileSync(runstateFile(), JSON.stringify(state)); } catch { /* ignore */ }
}

function debugLog(line) {
  if (!process.env.SWARMEYE_DEBUG) return;
  appendLog(line);
}

process.on('uncaughtException', (err) => appendLog('[main] uncaughtException: ' + err.stack));
process.on('unhandledRejection', (err) => appendLog('[main] unhandledRejection: ' + (err && err.stack || err)));
app.on('child-process-gone', (e, details) => {
  appendLog(`[child-process-gone] type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

/* http(s) on this machine and nothing else — the only thing the preview dock
 * is allowed to load. Anything unparseable is not local. */
function isLocalUrl(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

function createWindow() {
  const cfg = config.load();
  const bounds = cfg.windowBounds || { width: 1600, height: 950 };

  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0b0d',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true, // Windows only; macOS has no in-window menu bar
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // the preview dock's <webview> (renderer/preview.js) — locked down to
      // local addresses by the two handlers below
      webviewTag: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // the renderer never legitimately opens windows or navigates away
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  /* The preview dock embeds a <webview>. It exists to show the dev server the
   * agents are building, so it is confined to local addresses — at attach and
   * at every navigation the page tries afterwards — and gets no node access
   * and no preload of its own. */
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (params.src !== 'about:blank' && !isLocalUrl(params.src)) e.preventDefault();
  });
  win.webContents.on('did-attach-webview', (e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (ev, url) => { if (!isLocalUrl(url)) ev.preventDefault(); });
    // will-navigate only covers navigations the *page* starts — a src= set from
    // the renderer goes through loadURL and never fires it. This catches the
    // document request itself instead, in the preview's own session partition
    // (see the webview tag), so nothing else in the app is filtered. Only the
    // top-level document is pinned to localhost: a local page is still free to
    // pull a font or a script from wherever it normally would.
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: details.resourceType === 'mainFrame' && !isLocalUrl(details.url) });
    });
  });
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));

  if (process.env.SWARMEYE_DEBUG) {
    debugLog('--- app started ---');
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      debugLog(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (e, code, desc) => debugLog(`[did-fail-load] ${code} ${desc}`));
  }

  // the renderer process can die independently of main (OOM, GPU crash,
  // native crash) and Electron gives no other signal when it does — without
  // this the window just goes blank/disappears with nothing in any log
  let rendererReloads = [];
  win.webContents.on('render-process-gone', (e, details) => {
    appendLog(`[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return;
    // a renderer that dies as soon as it comes back (bad GPU state, OOM loop)
    // must not reload forever — after 3 strikes in 2 minutes leave it dead
    // so the crash logs stop churning and the user restarts deliberately
    rendererReloads = rendererReloads.filter((t) => Date.now() - t < 120000);
    if (rendererReloads.length >= 3) {
      appendLog('[render-process-gone] reload loop detected — not reloading again');
      return;
    }
    rendererReloads.push(Date.now());
    win.webContents.reload();
  });
  win.webContents.on('unresponsive', () => appendLog('[webContents] unresponsive'));
  win.webContents.on('responsive', () => appendLog('[webContents] responsive again'));

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    config.patch({ windowBounds: win.getBounds() });
  };
  let boundsTimer = null;
  const debouncedSaveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', debouncedSaveBounds);
  win.on('move', debouncedSaveBounds);
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { win = null; });
}

function registerIpc() {
  /* Only the fields the renderer actually reads. The rest of config.json is
   * main's own bookkeeping — every session's persisted usage totals, the tmux
   * session metadata, the installed-skills list, the last usage snapshot — and
   * this file runs well into six figures of bytes once tasks start archiving
   * their transcripts, so returning it whole was a boot payload nobody
   * consumed.
   *
   * The colour palette rides along so the renderer's swatch picker doesn't
   * keep a hand-synced copy of it — main owns the list (it assigns each new
   * workspace's default and validates every pick against it). */
  ipcMain.handle('config:get', () => {
    const cfg = config.load();
    return {
      workspaces: cfg.workspaces,
      archivedWorkspaces: cfg.archivedWorkspaces,
      selectedWorkspaceId: cfg.selectedWorkspaceId,
      maxAgents: cfg.maxAgents,
      tasks: cfg.tasks,
      archivedTasks: cfg.archivedTasks,
      autoUsageLimit: cfg.autoUsageLimit,
      skipPermissions: cfg.skipPermissions,
      workspaceColors: config.WORKSPACE_COLORS,
    };
  });

  ipcMain.handle('config:set-max-agents', (e, n) => {
    const raw = Math.round(Number(n));
    const max = Number.isFinite(raw) ? Math.max(1, raw) : 10;
    config.patch({ maxAgents: max });
    ptys.maxSessions = max;
    return { maxAgents: max };
  });

  ipcMain.handle('workspace:add', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add workspace folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const p = res.filePaths[0];
    const cfg = config.load();
    const existing = cfg.workspaces.find((w) => w.path === p);
    if (existing) return { workspace: existing, workspaces: cfg.workspaces };
    /* Adding a folder that was removed earlier brings the old workspace back
     * rather than minting a second one for the same path: its id is what the
     * tasks, sessions and notes are filed under, so a new id would orphan all
     * of them and leave the archived entry behind forever. */
    const archived = (cfg.archivedWorkspaces || []).find((w) => w.path === p);
    if (archived) {
      cfg.archivedWorkspaces = cfg.archivedWorkspaces.filter((w) => w.id !== archived.id);
      cfg.workspaces.push(archived);
      cfg.selectedWorkspaceId = archived.id;
      config.save(cfg);
      if (git) git.tick();
      return { workspace: archived, workspaces: cfg.workspaces, selectedWorkspaceId: cfg.selectedWorkspaceId };
    }
    const ws = {
      id: 'ws_' + Math.random().toString(36).slice(2, 8),
      name: path.basename(p),
      path: p,
      categories: [...config.DEFAULT_TASK_CATEGORIES],
      color: config.WORKSPACE_COLORS[cfg.workspaces.length % config.WORKSPACE_COLORS.length],
    };
    cfg.workspaces.push(ws);
    if (!cfg.selectedWorkspaceId) cfg.selectedWorkspaceId = ws.id;
    config.save(cfg);
    if (git) git.tick(); // git chip for the new workspace without the poll delay
    return { workspace: ws, workspaces: cfg.workspaces, selectedWorkspaceId: cfg.selectedWorkspaceId };
  });

  // per-workspace task categories — every workspace starts with the same
  // three defaults (config.DEFAULT_TASK_CATEGORIES) but can add/remove freely
  ipcMain.handle('workspace:add-category', (e, { id, name }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    const clean = String(name || '').trim().slice(0, 30);
    if (ws && clean && !ws.categories.includes(clean)) {
      ws.categories = [...ws.categories, clean];
      config.save(cfg);
    }
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:remove-category', (e, { id, name }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (ws) {
      ws.categories = ws.categories.filter((c) => c !== name);
      config.save(cfg);
    }
    return { workspaces: cfg.workspaces };
  });

  /* The workspace notebook (.swarmeye/notes.md). The path is resolved here
   * from the workspace id and always sits under that workspace's own folder —
   * the renderer never names a file, so there is nothing to escape out of.
   * Plain fs, not the shell: the workspace path is a host path on both
   * platforms (it is what node-pty chdirs into), unlike the transcripts. */
  const NOTES_MAX = 20000; // the agent pays to read this file — keep it a page, not a book

  function workspaceNotesFile(workspaceId) {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    return ws ? path.join(ws.path, NOTES_REL) : null;
  }

  ipcMain.handle('notes:read', (e, { workspaceId }) => {
    const file = workspaceNotesFile(workspaceId);
    if (!file) return { ok: false, reason: 'no-workspace' };
    try {
      return { ok: true, text: fs.readFileSync(file, 'utf8') };
    } catch {
      return { ok: true, text: '' }; // not written yet is not a failure
    }
  });

  ipcMain.handle('notes:write', (e, { workspaceId, text }) => {
    const file = workspaceNotesFile(workspaceId);
    if (!file) return { ok: false, reason: 'no-workspace' };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(text || '').slice(0, NOTES_MAX), 'utf8');
      return { ok: true };
    } catch (err) {
      debugLog('[notes:write] FAIL ' + err.message);
      return { ok: false, reason: err.message };
    }
  });

  // removing a workspace archives it (the folder ref, not the agents),
  // so it can be restored from the 🗃 popover later
  ipcMain.handle('workspace:remove', (e, id) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    cfg.workspaces = cfg.workspaces.filter((w) => w.id !== id);
    if (ws) {
      cfg.archivedWorkspaces = (cfg.archivedWorkspaces || []).filter((w) => w.path !== ws.path);
      cfg.archivedWorkspaces.unshift(ws);
    }
    if (cfg.selectedWorkspaceId === id) {
      cfg.selectedWorkspaceId = cfg.workspaces.length ? cfg.workspaces[0].id : null;
    }
    config.save(cfg);
    return {
      workspaces: cfg.workspaces,
      archivedWorkspaces: cfg.archivedWorkspaces,
      selectedWorkspaceId: cfg.selectedWorkspaceId,
    };
  });

  ipcMain.handle('workspace:restore', (e, id) => {
    const cfg = config.load();
    const ws = (cfg.archivedWorkspaces || []).find((w) => w.id === id);
    cfg.archivedWorkspaces = (cfg.archivedWorkspaces || []).filter((w) => w.id !== id);
    if (ws && !cfg.workspaces.some((w) => w.path === ws.path)) {
      cfg.workspaces.push(ws);
      cfg.selectedWorkspaceId = ws.id;
    }
    config.save(cfg);
    if (git) git.tick();
    return {
      workspaces: cfg.workspaces,
      archivedWorkspaces: cfg.archivedWorkspaces,
      selectedWorkspaceId: cfg.selectedWorkspaceId,
    };
  });

  ipcMain.handle('workspace:purge', (e, id) => {
    const cfg = config.load();
    cfg.archivedWorkspaces = (cfg.archivedWorkspaces || []).filter((w) => w.id !== id);
    config.save(cfg);
    return { archivedWorkspaces: cfg.archivedWorkspaces };
  });

  // branch dropdown on the pane git chip
  ipcMain.handle('git:branches', (e, workspaceId) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    return ws ? listBranches(ws) : null;
  });

  // diff summary shown above the branch list in that same popover
  ipcMain.handle('git:diff', (e, workspaceId) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    return ws ? diffStat(ws) : null;
  });

  ipcMain.handle('git:checkout', async (e, { workspaceId, branch, create }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, error: 'unknown workspace' };
    const res = await checkoutBranch(ws, String(branch || ''), { create: !!create });
    if (res.ok && git) git.tick(); // update every chip without the poll delay
    return res;
  });

  ipcMain.handle('workspace:reorder', (e, ids) => {
    const cfg = config.load();
    const byId = new Map(cfg.workspaces.map((w) => [w.id, w]));
    const next = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const w = byId.get(id);
      if (w) { next.push(w); byId.delete(id); }
    }
    next.push(...byId.values()); // never lose a workspace the renderer forgot
    cfg.workspaces = next;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:rename', (e, { id, name }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    const trimmed = String(name || '').trim().slice(0, 40);
    if (ws && trimmed) ws.name = trimmed;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:set-color', (e, { id, color }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    // only accept a colour from the known palette — the value ends up inline in
    // the renderer's styles, so don't let an arbitrary string through
    if (ws && config.WORKSPACE_COLORS.includes(color)) ws.color = color;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  // pinned workspaces sort to the top of the rail (the renderer does the
  // sorting; this only remembers the flag)
  ipcMain.handle('workspace:set-pinned', (e, { id, pinned }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (ws) ws.pinned = !!pinned;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:select', (e, id) => {
    config.patch({ selectedWorkspaceId: id });
    return { ok: true };
  });

  ipcMain.handle('config:set-auto-usage-limit', (e, n) => {
    const raw = Math.round(Number(n));
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : 85;
    config.patch({ autoUsageLimit: limit });
    return { autoUsageLimit: limit };
  });

  // launches new/restarted agents with --allow-dangerously-skip-permissions so
  // claude actually offers its bypass-permissions ("auto") mode in the
  // Shift+Tab cycle — without this flag claude refuses to enter that mode
  ipcMain.handle('config:set-skip-permissions', (e, on) => {
    const skipPermissions = !!on;
    config.patch({ skipPermissions });
    return { skipPermissions };
  });

  // task board: queued todos for agents, started now or auto-scheduled by
  // the renderer once an agent slot and usage headroom are both available
  const TASK_PATCH_KEYS = ['status', 'paneId', 'startedAt', 'completedAt', 'targetResetsAt', 'stopped', 'sessionLog', 'summary', 'priority', 'category'];

  ipcMain.handle('task:create', (e, { text, workspaceId, mode, startMode, model, effort, focus, closeOnComplete, priority, category, chain, repeat, nextRunAt, targetResetsAt, role }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === workspaceId);
    const clean = String(text || '').slice(0, 4000).trim();
    if (!ws) return { ok: false, reason: 'no-workspace' };
    if (!clean) return { ok: false, reason: 'empty-text' };
    const cleanMode = ['auto', 'next-session', 'manual'].includes(mode) ? mode : 'now';
    const task = {
      id: 'task_' + Math.random().toString(36).slice(2, 8),
      text: clean,
      workspaceId,
      mode: cleanMode,
      startMode: ['acceptEdits', 'plan', 'bypass'].includes(startMode) ? startMode : 'default',
      model: ['sonnet', 'opus', 'haiku', 'fable'].includes(model) ? model : 'default',
      // the role preset the task's agent launches with — same table and same
      // check session:create applies, since it ends up in the same flag
      role: Object.hasOwn(ROLES, String(role || '')) ? role : '',
      effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto'].includes(effort) ? effort : 'default',
      focus: !!focus,
      closeOnComplete: closeOnComplete !== false,
      priority: ['low', 'medium', 'high', 'critical'].includes(priority) ? priority : 'medium',
      category: String(category || '').trim().slice(0, 30),
      // follow-up prompts: each one is queued as a fresh task (carrying the
      // rest of the list) when this task completes. Same per-prompt cap as
      // text, and a length cap so one paste can't queue an endless pipeline.
      chain: (Array.isArray(chain) ? chain : [])
        .map((s) => String(s || '').slice(0, 4000).trim())
        .filter(Boolean)
        .slice(0, 10),
      // recurring tasks: when this one completes, a clone of it is queued
      // with nextRunAt one interval out, and the scheduler holds that clone
      // back until the wall clock passes it
      repeat: ['hourly', 'daily', 'weekly'].includes(repeat) ? repeat : 'none',
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : null,
      // manual-mode tasks start life in the Manual column, untouched by the
      // scheduler, until the user explicitly moves them to Scheduled
      status: cleanMode === 'manual' ? 'manual' : 'pending',
      paneId: null,
      // captured at creation for 'next-session' tasks: the 5-hour window's
      // resets_at at that moment, so the scheduler waits for that exact
      // boundary rather than polling for usage headroom like 'auto' does
      targetResetsAt: Number.isFinite(targetResetsAt) ? targetResetsAt : null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
    cfg.tasks = [...(cfg.tasks || []), task];
    config.save(cfg);
    return { ok: true, task, tasks: cfg.tasks };
  });

  ipcMain.handle('task:update', (e, { id, patch }) => {
    const cfg = config.load();
    const tasks = cfg.tasks || [];
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return { tasks };
    const safe = {};
    for (const k of TASK_PATCH_KEYS) if (patch && k in patch) safe[k] = patch[k];
    // scrollback is already capped per-pane (8000 lines), but keep only the
    // tail here too so one huge completed task can't bloat config.json
    if (typeof safe.sessionLog === 'string') safe.sessionLog = safe.sessionLog.slice(-300000);
    // the agent's closing message (main/hooks.js caps it too — this is the
    // second gate, since a renderer bug must not bloat every task record)
    if (typeof safe.summary === 'string') safe.summary = safe.summary.slice(0, 600);
    // same validation the create path applies — these two are user-editable
    // from the card badges, so they arrive here as well as at creation
    if ('priority' in safe && !['low', 'medium', 'high', 'critical'].includes(safe.priority)) delete safe.priority;
    if ('category' in safe) safe.category = String(safe.category || '').trim().slice(0, 30);
    cfg.tasks = tasks.map((t, i) => (i === idx ? { ...t, ...safe } : t));
    config.save(cfg);
    return { task: cfg.tasks[idx], tasks: cfg.tasks };
  });

  // removing a task from the board archives it (like workspace:remove above)
  // so it can still be reviewed or permanently purged from the Archive view
  ipcMain.handle('task:delete', (e, id) => {
    const cfg = config.load();
    const task = (cfg.tasks || []).find((t) => t.id === id);
    cfg.tasks = (cfg.tasks || []).filter((t) => t.id !== id);
    if (task) {
      cfg.archivedTasks = (cfg.archivedTasks || []).filter((t) => t.id !== task.id);
      cfg.archivedTasks.unshift(task);
      // each archived task can carry a ~300KB sessionLog — cap the archive so
      // config.json (rewritten on every save) can't grow without bound
      cfg.archivedTasks = cfg.archivedTasks.slice(0, 200);
    }
    config.save(cfg);
    return { tasks: cfg.tasks, archivedTasks: cfg.archivedTasks };
  });

  ipcMain.handle('task:purge', (e, id) => {
    const cfg = config.load();
    cfg.archivedTasks = (cfg.archivedTasks || []).filter((t) => t.id !== id);
    config.save(cfg);
    return { archivedTasks: cfg.archivedTasks };
  });

  ipcMain.handle('task:purge-all', () => {
    const cfg = config.load();
    cfg.archivedTasks = [];
    config.save(cfg);
    return { archivedTasks: cfg.archivedTasks };
  });

  // the coordinator: one multi-part request in, a reviewable list of subtasks
  // out. It creates nothing by itself — the renderer's modal is what turns the
  // approved rows into ordinary tasks through task:create above.
  ipcMain.handle('coordinator:split', async (e, { text, workspaceId }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    return coordinator.split(text, ws.name);
  });

  // called once by the renderer at boot: reattach surviving tmux sessions
  ipcMain.handle('session:list', async () => {
    await ptysReady;
    const sessions = await ptys.attachExisting();
    // whatever each agent had spent when the app closed rides back with it, so
    // the cost panel is filled in before its next turn — and totals belonging
    // to sessions that didn't survive are dropped here
    hooks.pruneUsage(sessions.map((s) => s.id));
    return {
      sessions: sessions.map((s) => ({ ...s, usage: hooks.snapshot(s.id) })),
      persistent: ptys.tmuxOk,
    };
  });

  // past conversations for one workspace, for the History screen
  ipcMain.handle('history:list', (e, workspaceId) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    return ws ? listHistory(ws) : null;
  });

  // one whole past conversation, for the History screen's transcript modal.
  // The id lands in a shell command line — re-validate it here, the same
  // shape session:create checks before passing one to `claude --resume`.
  ipcMain.handle('history:read', (e, { workspaceId, id }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws || !/^[A-Za-z0-9-]{8,64}$/.test(String(id || ''))) return null;
    return readHistory(ws, id);
  });

  /* the History screen's 🗑 Delete All: the conversations it listed, by id.
   * Any transcript a running agent is still writing is kept back — unlinking
   * one freezes that pane's cost panel, breaks its ☰ Transcript link, and
   * leaves a later restart-with-resume `--continue`ing somebody else's thread,
   * none of which the click asked for. The renderer is told how many it kept. */
  ipcMain.handle('history:delete', async (e, { workspaceId, ids }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws || !Array.isArray(ids)) return { ok: false, deleted: 0, kept: 0 };
    const live = new Set(hooks.transcriptIds(ptys.sessionIds()));
    const wanted = ids.filter((id) => typeof id === 'string');
    const doomed = wanted.filter((id) => !live.has(id));
    const deleted = await deleteHistory(ws, doomed);
    return { ok: deleted === doomed.length, deleted, kept: wanted.length - doomed.length };
  });

  // role presets for the + Coding Agent picker — main owns the prompts and the
  // model each role is worth (sessions.js ROLES); the renderer only draws the
  // labels, so the two can never disagree about what a role means
  ipcMain.handle('roles:list', () => Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, model: r.model })));

  ipcMain.handle('session:create', async (e, { workspaceId, cols, rows, model, resumeId, role }) => {
    await ptysReady;
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === workspaceId);
    if (!ws) { debugLog('[session:create] no-workspace ' + workspaceId); return { ok: false, reason: 'no-workspace' }; }
    try {
      // resumeId is re-validated again in claudeBase, since it lands in a
      // shell command line. role is only ever a key into main's own table,
      // never free text.
      const session = ptys.spawn(ws, cols || 80, rows || 24, {
        model,
        role: Object.hasOwn(ROLES, String(role || '')) ? role : undefined,
        resume: /^[A-Za-z0-9-]{8,64}$/.test(String(resumeId || '')) ? resumeId : undefined,
      });
      debugLog('[session:create] ok ' + session.id + ' "' + session.agentName + '" in ' + ws.path);
      return { ok: true, session };
    } catch (err) {
      debugLog('[session:create] FAIL ' + err.stack);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('session:restart', async (e, payload) => {
    await ptysReady;
    // resolve the folder server-side — the renderer only names a workspace
    const ws = config.load().workspaces.find((w) => w.id === payload.workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    try {
      const { session, resumed } = await ptys.restart({
        workspaceId: ws.id,
        workspaceName: ws.name,
        cwd: ws.path,
        agentName: String(payload.agentName || '').slice(0, 40).trim() || 'agent',
        cols: payload.cols,
        rows: payload.rows,
        resume: !!payload.resume,
        role: Object.hasOwn(ROLES, String(payload.role || '')) ? payload.role : undefined,
        // same whitelist task:create applies — it lands in the same launch flag
        model: ['sonnet', 'opus', 'haiku', 'fable'].includes(payload.model) ? payload.model : undefined,
      });
      debugLog('[session:restart] ok ' + session.id + ' "' + session.agentName + '" wanted-resume=' + !!payload.resume + ' resumed=' + resumed);
      return { ok: true, session, resumed };
    } catch (err) {
      debugLog('[session:restart] FAIL ' + err.stack);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('session:rename', (e, { id, name }) => {
    ptys.rename(id, name);
    return { ok: true };
  });

  ipcMain.handle('session:set-last-command', (e, { id, cmd }) => {
    ptys.setLastCommand(id, cmd);
    return { ok: true };
  });

  // re-open the attach client for a detached-but-alive tmux session
  ipcMain.handle('session:reattach', async (e, { id, cols, rows }) => {
    await ptysReady;
    try {
      const session = await ptys.reattach(id, cols, rows);
      debugLog('[session:reattach] ok ' + id);
      return { ok: true, session };
    } catch (err) {
      debugLog('[session:reattach] FAIL ' + id + ' ' + err.message);
      return { ok: false, reason: err.message };
    }
  });

  // save a pane's scrollback; the renderer sends the text, we pick the file
  ipcMain.handle('session:export', async (e, { name, text }) => {
    const safe = String(name || 'agent').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 40).trim() || 'agent';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const res = await dialog.showSaveDialog(win, {
      title: 'Save transcript',
      defaultPath: path.join(app.getPath('documents'), `${safe} ${stamp}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    try {
      await fs.promises.writeFile(res.filePath, String(text || ''), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.on('session:write', (e, { id, data }) => ptys.write(id, data));
  ipcMain.on('session:resize', (e, { id, cols, rows }) => ptys.resize(id, cols, rows));
  ipcMain.handle('session:kill', async (e, { id }) => {
    await ptys.kill(id);
    hooks.cleanup(id);
    return { ok: true };
  });

  /* Taskbar flash / dock bounce whenever the window isn't focused, plus — if
   * the renderer says the option is on — a real OS notification carrying which
   * agent it was and what happened. The bell is still the history; this is
   * what reaches you with SwarmEye minimized behind an editor.
   *
   * `silent`: the renderer already plays the notification sound the user
   * picked in Options, so letting the OS play its own would double it up. */
  ipcMain.on('notify', (e, payload = {}) => {
    if (!win || win.isDestroyed() || win.isFocused()) return;
    win.flashFrame(true);
    if (!payload || !payload.desktop || !Notification.isSupported()) return;
    const n = new Notification({
      title: String(payload.title || 'SwarmEye').slice(0, 120),
      body: String(payload.body || '').slice(0, 300),
      silent: true,
    });
    n.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    n.show();
  });

  ipcMain.on('open-external', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('usage:refresh', () => usage.refreshNow());

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('update:check', () => updates.tick());
  ipcMain.handle('update:download', () => updates.download());
  ipcMain.handle('update:install', () => updates.install());

  ipcMain.handle('skills:list', () => skills.list());
  ipcMain.handle('skills:install', async (e, repoUrl) => {
    try { return await skills.install(repoUrl); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('skills:remove', async (e, id) => {
    try { return await skills.remove(id); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('skills:remove-repo', async (e, repoId) => {
    try { return await skills.removeRepo(repoId); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('skills:set-enabled', async (e, { id, enabled }) => {
    try { return await skills.setEnabled(id, enabled); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('skills:set-active', async (e, { id, active }) => {
    try { return await skills.setActive(id, active); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('skills:update', async (e, id) => {
    try { return await skills.update(id); }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  // fire-and-forget: results stream back individually as each git fetch resolves
  ipcMain.handle('skills:check-updates', () => {
    skills.checkAllUpdates((id, updateAvailable) => sendToWin('skills:update-status', { id, updateAvailable }));
    return { ok: true };
  });
  ipcMain.handle('skills:terminal-command', (e, id) => skills.terminalCommand(id));

  ipcMain.on('clipboard:write', (e, text) => clipboard.writeText(String(text || '')));

  const speech = new SpeechBridge({ send: sendToWin, debugLog });
  ipcMain.handle('speech:installed', () => speech.available());
  ipcMain.handle('speech:install', () => speech.install());
  ipcMain.handle('speech:start', (e, id) => speech.start(id));
  ipcMain.on('speech:audio', (e, b64) => speech.feed(b64));
  ipcMain.on('speech:stop', () => speech.stop());
  ipcMain.handle('tts:installed', () => speech.ttsAvailable());
  ipcMain.handle('tts:install', () => speech.installTts());
  ipcMain.handle('tts:speak', (e, text) => speech.speak(text));
}

app.whenReady().then(() => {
  // a graceful quit flips cleanShutdown back to true (see before-quit); finding
  // it false at boot means the previous run was killed rather than exited —
  // e.g. hard-terminated externally, since a catchable JS crash or renderer/GPU
  // death is already logged separately by the handlers below. lastHeartbeat
  // (refreshed every 20s while running) says roughly how long it lasted.
  const prev = readRunstate() || config.load(); // fallback: pre-runstate versions kept these keys in config.json
  if (prev.cleanShutdown === false) {
    const since = prev.lastHeartbeat ? Math.round((Date.now() - prev.lastHeartbeat) / 1000) : null;
    appendLog('[boot] previous run did not exit cleanly' + (since != null ? ` — last heartbeat ${since}s before this start` : ''));
  }
  writeRunstate({ cleanShutdown: false, lastHeartbeat: Date.now() });
  heartbeatTimer = setInterval(() => writeRunstate({ cleanShutdown: false, lastHeartbeat: Date.now() }), 20000);

  // Windows: no menu at all, which frees Ctrl+0/+/- (font shortcuts) and
  // Ctrl+W from the default menu's hidden zoom/close accelerators.
  // macOS: a menu bar always exists, so keep the minimum that makes Cmd+Q
  // and Cmd+C/V/X work and drop the View/Window menus whose hidden zoom
  // (Cmd+±/0) and close accelerators would conflict the same way.
  // Windows sources a toast's app name and icon from the AppUserModelID, and
  // a portable build has none registered — without this every desktop
  // notification would show up as "electron.app.Electron"
  if (IS_WIN) app.setAppUserModelId('dev.swarmeye.app');

  Menu.setApplicationMenu(IS_WIN ? null : Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
  ]));
  createWindow();

  hooks = new HookMonitor({
    debugLog,
    // a Stop hook fires the instant the agent's turn ends, via fs.watch — that
    // can beat the ~16ms-batched final chunk of the turn's own pty output
    // across the wire, so the renderer's transcript capture would grab the
    // buffer a moment before it's complete. Flushing first preserves order.
    onEvent: (id, payload) => {
      flushPtyBuffers();
      sendToWin('session:state', { id, ...payload });
    },
  });
  hooks.init();

  ptys = new PtyManager({
    maxSessions: config.load().maxAgents || 10,
    debugLog,
    decorateCmd: (id, cmd) => hooks.claudeCmd(id, cmd),
    onData: queuePtyData,
    onExit: (id, exitCode, detached) => {
      flushPtyBuffers(); // the session's last output must not arrive after its exit event
      if (!detached) hooks.cleanup(id);
      sendToWin('session:exit', { id, exitCode, detached });
    },
  });
  ptysReady = ptys.init();

  git = new GitMonitor({ onUpdate: (info) => sendToWin('git:update', info) });
  git.start();

  // WSL reachability is a Windows-only failure mode — on macOS agents run
  // natively, so there is no boundary to lose
  if (IS_WIN) {
    health = new HealthMonitor({ debugLog, onUpdate: (h) => sendToWin('health:update', h) });
    health.start();
  }

  updates = new UpdateChecker({
    current: app.getVersion(),
    debugLog,
    onAvailable: (info) => sendToWin('update:available', info),
    onProgress: (percent) => sendToWin('update:progress', { percent }),
    onReady: () => sendToWin('update:ready'),
    onError: (error) => sendToWin('update:error', { error }),
  });
  updates.start();

  usage = new UsageMonitor({
    onUpdate: (snapshot) => {
      debugLog('[usage] ' + JSON.stringify(snapshot));
      sendToWin('usage:update', snapshot);
    },
  });
  usage.start();

  skills = new SkillsManager({ debugLog });
  skills.ensureSymlinks();

  registerIpc();

  // self-test: dump renderer state to the debug log (spawns nothing)
  if (process.env.SWARMEYE_TEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        debugLog('[test] boot: ' + (await win.webContents.executeJavaScript(`(() => JSON.stringify({
          total: state.panes.size,
          visible: grid.panes.length,
          selectedWs: state.selectedWorkspaceId,
          names: [...state.panes.values()].map((p) => p.session.agentName),
          status: [...state.panes.values()].map((p) => p.status),
        }))()`)));
      } catch (err) {
        debugLog('[test] THREW: ' + err.message);
      }
    });
  }
});

app.on('before-quit', (e) => {
  if (ptys && !ptys.tmuxOk && ptys.runningCount() > 0) {
    const n = ptys.runningCount();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Quit anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `${n} agent${n > 1 ? 's are' : ' is'} still running`,
      detail: IS_WIN
        ? 'tmux is not installed in WSL, so quitting kills them. Install tmux to make agents survive restarts.'
        : 'tmux is not installed, so quitting kills them. brew install tmux to make agents survive restarts.',
    });
    if (choice === 1) { e.preventDefault(); return; }
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  writeRunstate({ cleanShutdown: true, lastHeartbeat: Date.now() });
  if (usage) usage.stop();
  if (git) git.stop();
  if (health) health.stop();
  if (updates) updates.stop();
  if (hooks) hooks.stop();
  if (ptys) ptys.shutdown();
});

app.on('window-all-closed', () => {
  app.quit();
});
