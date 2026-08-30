const { app, BrowserWindow, dialog, Menu, crashReporter, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { PtyManager } = require('./sessions');
const { UsageMonitor } = require('./usage');
const { HookMonitor } = require('./hooks');
const { GitMonitor } = require('./git');
const { HealthMonitor } = require('./health');
const { IS_WIN } = require('./platform');
const { UpdateChecker } = require('./update');
const { SpeechBridge } = require('./speech');
const { SkillsManager } = require('./skills');
const registerIpc = require('./ipc');

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

/* pty output on its way to the renderer — coalesced per session, on two
 * beats depending on whether anyone is looking at it. main/ptystream.js. */
const ptyStream = require('./ptystream')({ send: sendToWin });
const { flush: flushPtyBuffers, setVisibleSessions } = ptyStream;

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

  /* "Native Apple style" (Options → Appearance, macOS only). The frame can
   * only be chosen when the window is built, so the flip needs a relaunch —
   * the option's row offers one. hiddenInset puts the traffic lights inside
   * the top bar (which reserves room for them and becomes the drag region),
   * and the vibrancy is what the sidebar and top bar let through: both go
   * transparent in styles/native-mac.css, every content surface stays opaque.
   * The alpha background is what lets the material show at all. */
  const nativeMac = process.platform === 'darwin' && !!cfg.nativeStyle;
  /* "Reduce transparency" (Options → Appearance). The window material is the
   * expensive half of the glass: an alpha-backed window has the compositor
   * blending the whole frame against the desktop behind it every frame the
   * agent panes repaint. The frame itself is fixed at creation, so the option
   * is read here as well as applied live (setReduceTransparency below) —
   * a relaunch then comes up opaque rather than blending under the CSS that
   * has already stopped asking for the effect. */
  const glassMac = nativeMac && !cfg.reduceTransparency;

  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: glassMac ? '#00000000' : '#0a0b0d',
    ...(nativeMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 15 },
    } : {}),
    ...(glassMac ? {
      vibrancy: 'sidebar',
      visualEffectState: 'active',
    } : {}),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true, // Windows only; macOS has no in-window menu bar
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // the preview dock's <webview> (renderer/features/preview/preview.js) — locked down to
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
  // The preview partition is a separate Session, and a Session with no handler
  // grants every permission. The dock only shows a local dev server, so deny
  // the lot — both paths, since several permissions are read synchronously and
  // never reach the request handler.
  const previewSession = require('electron').session.fromPartition('persist:swarmeye-preview');
  previewSession.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  previewSession.setPermissionCheckHandler(() => false);

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

  // A packaged .app carries its icon in the bundle, but run from source the
  // Dock and Cmd-Tab show Electron's own — so point them at build/icon.png.
  if (process.platform === 'darwin' && !app.isPackaged) {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
  }

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
    decorateCmd: (id, cmd, opts) => hooks.claudeCmd(id, cmd, opts),
    turnsOf: (id) => hooks.turnsOf(id),
    onData: ptyStream.onData,
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

  // module-level so before-quit can shut the recogniser and any TTS child down
  speech = new SpeechBridge({ send: sendToWin, debugLog });

  /* every ipcMain handler, one file per domain (main/ipc/). `win` is a getter:
   * macOS rebuilds the window after the last one closes, and a captured
   * reference would keep pointing at the dead one. */
  registerIpc({
    get win() { return win; },
    ptys, usage, ptysReady, hooks, git, health, updates, skills, speech,
    sendToWin, debugLog, setVisibleSessions,
  });

  // self-test: dump renderer state to the debug log (spawns nothing)
  if (process.env.SWARMEYE_TEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        // app.js is a module, so its `state` and `grid` are not global — it
        // publishes this one accessor for us
        debugLog('[test] boot: ' + (await win.webContents.executeJavaScript('JSON.stringify(window.__swarmTestState())')));
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
