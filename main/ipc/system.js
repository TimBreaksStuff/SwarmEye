/* IPC: everything that is neither an agent nor a workspace — usage polling,
 * the updater, speech in and out, the clipboard, OS notifications and opening
 * a link in the real browser. */

const { app, ipcMain, shell, Notification, clipboard } = require('electron');

module.exports = function register(deps) {
  const { usage, updates, speech } = deps;

  ipcMain.handle('usage:refresh', () => usage.refreshNow());

  ipcMain.handle('update:check', () => updates.tick());
  ipcMain.handle('update:download', () => updates.download());
  ipcMain.handle('update:install', () => updates.install());

  ipcMain.on('clipboard:write', (e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // speech is built in main.js, module-level, so before-quit can shut the
  // recogniser and any TTS child down
  ipcMain.handle('speech:installed', () => speech.available());
  ipcMain.handle('speech:install', () => speech.install());
  ipcMain.handle('speech:start', (e, id) => speech.start(id));
  ipcMain.on('speech:audio', (e, b64) => speech.feed(b64));
  ipcMain.on('speech:stop', () => speech.stop());
  ipcMain.handle('tts:installed', () => speech.ttsAvailable());
  ipcMain.handle('tts:install', () => speech.installTts());
  ipcMain.handle('tts:speak', (e, text) => speech.speak(text));
  /* Taskbar flash / dock bounce whenever the window isn't focused, plus — if
   * the renderer says the option is on — a real OS notification carrying which
   * agent it was and what happened. The bell is still the history; this is
   * what reaches you with SwarmEye minimized behind an editor.
   *
   * `silent`: the renderer already plays the notification sound the user
   * picked in Options, so letting the OS play its own would double it up. */
  ipcMain.on('notify', (e, payload = {}) => {
    // dock badge: unread count from the renderer's bell — a badge-only
    // payload never flashes or toasts. No-op on Windows (flashFrame covers it).
    if (payload && payload.badge !== undefined) {
      app.setBadgeCount(Math.max(0, payload.badge | 0));
      return;
    }
    if (!deps.win || deps.win.isDestroyed() || deps.win.isFocused()) return;
    deps.win.flashFrame(true);
    if (!payload || !payload.desktop || !Notification.isSupported()) return;
    const n = new Notification({
      title: String(payload.title || 'SwarmEye').slice(0, 120),
      body: String(payload.body || '').slice(0, 300),
      silent: true,
    });
    n.on('click', () => {
      if (!deps.win || deps.win.isDestroyed()) return;
      if (deps.win.isMinimized()) deps.win.restore();
      deps.win.show();
      deps.win.focus();
    });
    n.show();
  });

  ipcMain.on('open-external', (e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
};
