const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, crashReporter, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { PtyManager, NOTES_REL, MODELS, EFFORT_FLAGS, SESSION_ID_RE } = require('./sessions');
const roles = require('./roles');
const { UsageMonitor } = require('./usage');
const { HookMonitor } = require('./hooks');
const { GitMonitor, listBranches, checkoutBranch, diffStat } = require('./git');
const worktree = require('./worktree');
const attach = require('./attach');
const { HealthMonitor } = require('./health');
const { listSessions: listHistory, readSession: readHistory, deleteSessions: deleteHistory } = require('./history');
const { IS_WIN } = require('./platform');
const { UpdateChecker } = require('./update');
const { SpeechBridge } = require('./speech');
const { SkillsManager } = require('./skills');
const coordinator = require('./coordinator');
const preview = require('./preview');

let win = null;
let ptys = null;
let usage = null;
let ptysReady = null;
let hooks = null;
let git = null;
let health = null;
let updates = null;
let skills = null;
let speech = null;
let heartbeatTimer = null;

/* Two instances sharing one userData dir corrupt each other: config.json goes
 * last-write-wins between two module-level caches, both fs-watch (and one
 * boot-deletes) the same hook-state files, and both attach clients drag every
 * tmux pane to the smaller size. Trivially easy to hit with the portable exe —
 * refuse and focus the running window instead. */
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

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
/* With an id, drain only that session — hook events land several times a
 * second on a busy swarm, and a swarm-wide flush per event would chop every
 * other session's batch into per-event IPC messages, exactly the churn the
 * 16ms batch exists to prevent. The shared timer keeps running for the rest. */
function flushPtyBuffers(id) {
  if (id !== undefined) {
    const data = ptyBuffers.get(id);
    if (data !== undefined) {
      ptyBuffers.delete(id);
      sendToWin('session:data', { id, data });
    }
    return;
  }
  clearTimeout(ptyFlushTimer);
  ptyFlushTimer = null;
  for (const [sid, data] of ptyBuffers) sendToWin('session:data', { id: sid, data });
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
  // archived tasks always cross IPC without their transcripts (see config:get)
  const projectArchive = (list) => list.map(({ sessionLog, ...t }) => (
    sessionLog ? { ...t, hasSessionLog: true } : t
  ));

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
      selectedWorkspaceId: cfg.selectedWorkspaceId,
      maxAgents: cfg.maxAgents,
      tasks: cfg.tasks,
      /* Without its transcript: each archived task can carry a 300KB
       * sessionLog and the archive holds 200 of them, so shipping them whole
       * was a ~60MB structured clone on every boot for a popup almost nobody
       * opens. `hasSessionLog` is enough to draw the button; the transcript
       * itself comes from task:archived-log below when one is actually read. */
      archivedTasks: projectArchive(config.loadArchive()),
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

  // what the message box can attach to a prompt: a file from this workspace
  // (the @ picker) or an image from the clipboard. Both resolve to a path the
  // *agent* can open — see main/attach.js — and both take a workspace id
  // rather than a path, like every other handler here.
  ipcMain.handle('workspace:files', async (e, id) => {
    const ws = config.load().workspaces.find((w) => w.id === id);
    if (!ws) return [];
    try { return await attach.listFiles(ws); } catch { return []; }
  });

  ipcMain.handle('attach:image', (e, dataUrl) => attach.saveImage(dataUrl));

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
      // tmp+rename like every other persisted file — a crash mid-write must
      // not truncate the shared notebook agents are told to read
      fs.writeFileSync(file + '.tmp', String(text || '').slice(0, NOTES_MAX), 'utf8');
      fs.renameSync(file + '.tmp', file);
      return { ok: true };
    } catch (err) {
      debugLog('[notes:write] FAIL ' + err.message);
      return { ok: false, reason: err.message };
    }
  });

  // the preview dock asks where its dev server is; main probes, then starts one
  ipcMain.handle('preview:resolve', (e, { workspaceId, preferred }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    return preview.resolve(ws.path, workspaceId, preferred);
  });

  ipcMain.handle('preview:stop', (e, { workspaceId }) => preview.stop(workspaceId).then(() => ({ ok: true })));

  // removing a workspace archives it (the folder ref, not the agents) so that
  // re-adding the same folder via workspace:add brings the old workspace —
  // and everything filed under its id — back instead of minting a new one
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
      selectedWorkspaceId: cfg.selectedWorkspaceId,
    };
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

  /* ---- isolated agents: a worktree each, and the way back ---- */

  /* Every git call below addresses either a workspace or one agent's worktree,
   * and resolves it here from an id — like notes:read, the renderer never names
   * a path, so there is nothing to escape out of. The shape returned is the one
   * git.js and worktree.js take: { id, path }. */
  function repoTarget({ workspaceId, sessionId, worktreeName }) {
    const cfg = config.load();
    if (sessionId) {
      const meta = (cfg.sessions || {})[sessionId];
      return meta && meta.cwd ? { id: meta.id, path: meta.cwd } : null;
    }
    const ws = cfg.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    // a worktree whose agent is gone is still reviewable, and is named rather
    // than pointed at — the path is built here and only if it is really there
    if (worktreeName) {
      const wt = restartWorktree(ws, { name: worktreeName });
      return wt ? { id: ws.id + ':' + wt.name, path: wt.path } : null;
    }
    return ws;
  }

  /* The worktree a restarting agent goes back into, rebuilt from its name.
   * Anything that no longer exists on disk (removed from the review popover
   * while the pane sat exited) falls back to the workspace itself rather than
   * failing the restart. */
  function restartWorktree(ws, prev) {
    const name = String((prev && prev.name) || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
    const p = worktree.worktreePath(ws, name);
    if (!fs.existsSync(p)) return null;
    const branch = String((prev && prev.branch) || '');
    return { name, path: p, branch: /^[A-Za-z0-9][\w./-]*$/.test(branch) ? branch : 'swarmeye/' + name };
  }

  // whether agents started in this workspace get a worktree of their own.
  // A workspace setting rather than a per-launch one: it is a property of the
  // repo, and it reaches board tasks and + Agent without either of them asking
  ipcMain.handle('workspace:set-isolate', (e, { id, isolate }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (ws) ws.isolate = !!isolate;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('worktree:list', async (e, workspaceId) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const entries = await worktree.list(ws);
    if (!entries) return null;
    // which of them still have an agent in them — the rest are the leftovers
    // the popover offers to remove
    const live = new Set(Object.values(config.load().sessions || {})
      .filter((m) => m.worktree)
      .map((m) => m.worktree.name));
    return entries.map((w) => ({ ...w, live: live.has(w.name) }));
  });

  ipcMain.handle('worktree:remove', async (e, { workspaceId, name }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, error: 'unknown workspace' };
    const res = await worktree.remove(ws, String(name || ''));
    if (res.ok && git) git.tick();
    return res;
  });

  ipcMain.handle('git:patch', (e, target) => {
    const t = repoTarget(target || {});
    return t ? worktree.patch(t) : null;
  });

  ipcMain.handle('git:commit', async (e, { workspaceId, sessionId, message }) => {
    const t = repoTarget({ workspaceId, sessionId });
    if (!t) return { ok: false, error: 'unknown target' };
    const res = await worktree.commit(t, message);
    if (res.ok && git) git.tick();
    return res;
  });

  ipcMain.handle('git:merge', async (e, { workspaceId, branch }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, error: 'unknown workspace' };
    const res = await worktree.merge(ws, String(branch || ''));
    if (git) git.tick(); // the workspace chip moved either way (merged, or aborted back)
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
      model: MODELS.includes(model) ? model : 'default',
      // the role preset the task's agent launches with — same table and same
      // check session:create applies, since it ends up in the same flag
      role: roles.has(role) ? role : '',
      // the named flag levels plus the two that only exist as typed commands
      effort: [...EFFORT_FLAGS, 'ultracode', 'auto'].includes(effort) ? effort : 'default',
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
    config.save(cfg);
    let archived = config.loadArchive();
    if (task) {
      // capped so archive.json can't grow without bound
      archived = [task, ...archived.filter((t) => t.id !== task.id)].slice(0, 200);
      config.saveArchive(archived);
    }
    return { tasks: cfg.tasks, archivedTasks: projectArchive(archived) };
  });

  // one archived task's transcript, on demand — config:get ships the archive
  // without them (see the projection above)
  ipcMain.handle('task:archived-log', (e, id) => {
    const t = config.loadArchive().find((x) => x.id === id);
    return { sessionLog: (t && t.sessionLog) || '' };
  });

  ipcMain.handle('task:purge', (e, id) => {
    const archived = config.loadArchive().filter((t) => t.id !== id);
    config.saveArchive(archived);
    return { archivedTasks: projectArchive(archived) };
  });

  ipcMain.handle('task:purge-all', () => {
    config.saveArchive([]);
    return { archivedTasks: [] };
  });

  // the coordinator: one multi-part request in, a reviewable list of subtasks
  // out. It creates nothing by itself — the renderer's modal is what turns the
  // approved rows into ordinary tasks through task:create above.
  ipcMain.handle('coordinator:split', async (e, { text, workspaceId }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    // split() can genuinely throw (temp file unwritable) — a rejected invoke
    // would wedge the modal's button at "splitting…"
    try {
      return await coordinator.split(text, ws.name);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // called once by the renderer at boot: reattach surviving tmux sessions
  ipcMain.handle('session:list', async () => {
    await ptysReady;
    const sessions = await ptys.attachExisting();
    // whatever each agent had spent when the app closed rides back with it, so
    // the cost panel is filled in before its next turn — and totals belonging
    // to sessions that didn't survive are dropped here. Not when the probe
    // failed, though: that [] means "couldn't reach tmux", and pruning against
    // it would erase every surviving agent's spend history.
    if (!ptys.probeFailed) hooks.pruneUsage(sessions.map((s) => s.id));
    return {
      sessions: sessions.map((s) => ({ ...s, usage: hooks.snapshot(s.id) })),
      persistent: ptys.tmuxOk,
      // the renderer's orphan-task recovery must not respawn agents for tasks
      // whose panes are merely unreachable right now
      probeFailed: ptys.probeFailed,
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
    if (!ws || !SESSION_ID_RE.test(String(id || ''))) return null;
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

  // role presets for the + Agent picker and the coordinator. The prompt rides
  // along now that the roles are editable (main/roles.js) — the editor has to
  // show what it is editing — but the launch still reads main's own copy, so a
  // renderer that sent a doctored prompt back would only be editing the table.
  ipcMain.handle('roles:list', () => roles.list().map((r) => ({ ...r })));

  // the whole table, not a patch: a role missing from what the editor sends is
  // a role the user deleted. Everything is re-validated in roles.save — a role
  // prompt is the one field whose text reaches a shell command line.
  ipcMain.handle('roles:save', (e, list) => roles.save(list).map((r) => ({ ...r })));

  ipcMain.handle('session:create', async (e, { workspaceId, cols, rows, model, resumeId, role, effort }) => {
    await ptysReady;
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === workspaceId);
    if (!ws) { debugLog('[session:create] no-workspace ' + workspaceId); return { ok: false, reason: 'no-workspace' }; }
    /* An isolated workspace gives each agent its own worktree, which has to
     * exist before node-pty can chdir into it — so the name is picked here
     * rather than inside spawn, and the cap is checked before the directory is
     * made rather than leaving an orphan behind when spawn refuses. */
    let wt = null;
    if (ws.isolate) {
      if (ptys.runningCount() >= ptys.maxSessions) return { ok: false, reason: 'cap' };
      const agentName = ptys.pickAgentName();
      const made = await worktree.create(ws, agentName);
      if (!made.ok) {
        debugLog('[session:create] worktree FAIL ' + made.error);
        return { ok: false, reason: made.error };
      }
      wt = { ...made, agentName };
    }
    try {
      // resumeId is re-validated again in claudeBase, since it lands in a
      // shell command line. role is only ever a key into main's own table,
      // never free text.
      const session = ptys.spawn(ws, cols || 80, rows || 24, {
        model,
        role: roles.has(role) ? role : undefined,
        resume: SESSION_ID_RE.test(String(resumeId || '')) ? resumeId : undefined,
        effort: EFFORT_FLAGS.includes(String(effort || '')) ? effort : undefined,
        agentName: wt ? wt.agentName : undefined,
        worktree: wt || undefined,
      });
      if (wt && git) git.tick(); // the new pane's chip shows its own branch at once
      debugLog('[session:create] ok ' + session.id + ' "' + session.agentName + '" in ' + session.cwd);
      return { ok: true, session };
    } catch (err) {
      debugLog('[session:create] FAIL ' + err.stack);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('session:restart', async (e, payload) => {
    await ptysReady;
    // resolve the folder server-side — the renderer only names a workspace
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === payload.workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    /* An isolated agent comes back in the worktree it was working in. Its
     * metadata is already gone by the time ↻ is pressed (a real exit drops it),
     * so the pane hands back the worktree's *name* — an id, not a path: main
     * still builds the path itself, and only if that directory is really
     * there. */
    const wt = restartWorktree(ws, payload.worktree);
    try {
      const { session, resumed } = await ptys.restart({
        workspaceId: ws.id,
        workspaceName: ws.name,
        cwd: wt ? wt.path : ws.path,
        workspacePath: ws.path,
        worktree: wt ? { name: wt.name, branch: wt.branch } : undefined,
        agentName: String(payload.agentName || '').slice(0, 40).trim() || 'agent',
        cols: payload.cols,
        rows: payload.rows,
        resume: !!payload.resume,
        role: roles.has(payload.role) ? payload.role : undefined,
        // same whitelist task:create applies — it lands in the same launch flag
        model: MODELS.includes(payload.model) ? payload.model : undefined,
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
  // `ext` is html for the History screen's page export, txt for everything
  // else; the renderer builds the document either way, so this only picks the
  // dialog's filter and default name
  ipcMain.handle('session:export', async (e, { name, text, ext }) => {
    const safe = String(name || 'agent').replace(/[^A-Za-z0-9 _.-]/g, '_').slice(0, 40).trim() || 'agent';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const html = ext === 'html';
    const res = await dialog.showSaveDialog(win, {
      title: 'Save transcript',
      defaultPath: path.join(app.getPath('documents'), `${safe} ${stamp}.${html ? 'html' : 'txt'}`),
      filters: [html ? { name: 'HTML', extensions: ['html'] } : { name: 'Text', extensions: ['txt'] }],
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
    // kill() throws when the shell never answered — the agent is still alive
    // in tmux and its metadata kept, so it reattaches on the next launch.
    // Don't cleanup hooks state for an agent that's still running.
    try {
      await ptys.kill(id);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
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

  // module-level so before-quit can shut the recogniser and any TTS child down
  speech = new SpeechBridge({ send: sendToWin, debugLog });
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
  if (!gotInstanceLock) return; // quitting — must not touch the running instance's files
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
      flushPtyBuffers(id);
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
      flushPtyBuffers(id); // the session's last output must not arrive after its exit event
      if (!detached) hooks.cleanup(id);
      sendToWin('session:exit', { id, exitCode, detached });
    },
  });
  ptysReady = ptys.init();

  // the git and health pollers exist purely to paint chrome — no point
  // spawning shells for a window nobody can see; a focus/restore tick below
  // catches them up the moment it's visible again
  const winVisible = () => !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());

  git = new GitMonitor({ onUpdate: (info) => sendToWin('git:update', info), visible: winVisible });
  git.start();

  // WSL reachability is a Windows-only failure mode — on macOS agents run
  // natively, so there is no boundary to lose
  if (IS_WIN) {
    health = new HealthMonitor({ debugLog, onUpdate: (h) => sendToWin('health:update', h), visible: winVisible });
    health.start();
  }

  const wakePollers = () => { if (git) git.tick(); if (health) health.tick(); };
  win.on('focus', wakePollers);
  win.on('restore', wakePollers);

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
  if (!gotInstanceLock) return; // second instance: nothing initialized, nothing to write
  // an update install has already spawned the replacement exe by the time
  // quit is requested — cancelling here would leave both builds running
  if (ptys && !ptys.tmuxOk && ptys.runningCount() > 0 && !(updates && updates.installing)) {
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
  // quitting mid-dictation would otherwise orphan the recogniser (and any
  // still-speaking TTS child), which outlive the app they were spawned from
  speech?._kill?.();
  speech?._killTts?.();
  if (ptys) ptys.shutdown();
});

app.on('window-all-closed', () => {
  app.quit();
});

// macOS: cancelling the "agents still running" dialog leaves the window closed
// but the app alive (win.on('closed') already nulled it), with no way back in
// from the dock — rebuild it instead of leaving a zombie.
app.on('activate', () => {
  if (!win) createWindow();
});
