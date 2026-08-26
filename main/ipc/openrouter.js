/* IPC: the OpenRouter key, its catalog and its spend.
 *
 * The key itself never crosses this boundary — `openrouter:status` reports
 * counts, and every slug is charset-checked in main/providers.js because it
 * lands in a single-quoted tmux command. */

const { ipcMain } = require('electron');
const providers = require('../providers');

module.exports = function register(deps) {
  ipcMain.handle('openrouter:status', () => providers.status());

  ipcMain.handle('openrouter:set-key', async (e, key) => {
    try {
      providers.setKey(String(key || '').trim());
      await providers.fetchCatalog();
    } catch (err) {
      return { ...providers.status(), error: String((err && err.message) || err) };
    }
    return providers.status();
  });

  // the extra models `/model` offers inside an OpenRouter agent — validated
  // against the catalog in providers.js, since they land in a shell command
  ipcMain.handle('openrouter:set-alts', (e, list) => {
    try {
      providers.setAlts(list);
    } catch (err) {
      return { ...providers.status(), error: String((err && err.message) || err) };
    }
    return providers.status();
  });

  ipcMain.handle('openrouter:clear-key', () => {
    providers.clearKey();
    return providers.status();
  });

  ipcMain.handle('openrouter:spend', async () => {
    try {
      return await providers.fetchSpend();
    } catch {
      return null; // the chip just stays as it was; the next poll retries
    }
  });

  ipcMain.handle('openrouter:refresh', async () => {
    try {
      await providers.fetchCatalog();
    } catch (err) {
      return { ...providers.status(), error: String((err && err.message) || err) };
    }
    return providers.status();
  });
};
