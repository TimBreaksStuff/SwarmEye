/* IPC: the skills screen — install from GitHub, enable/activate, update, remove.
 *
 * Active skills are injected into every new agent on every turn, so the
 * enabled/active split matters: see main/skills.js. */

const { ipcMain } = require('electron');

module.exports = function register(deps) {
  const { skills, sendToWin } = deps;

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
  ipcMain.handle('skills:set-or-startup', async (e, { id, on }) => {
    try { return await skills.setOrStartup(id, on); }
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
};
