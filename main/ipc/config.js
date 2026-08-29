/* IPC: the config projection the renderer boots from, the four options main
 * owns, and the CLAUDE.md template.
 *
 * `config:get` hands the renderer an explicit projection rather than the whole
 * config.json — see main/config.js for why that file must not widen back out. */

const { app, ipcMain } = require('electron');
const config = require('../config');
const template = require('../template');
const providers = require('../providers');

module.exports = function register(deps) {
  const { ptys, projectArchive } = deps;

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
      worktrees: cfg.worktrees,
      claudeTemplate: template.status(),
      // the OpenRouter catalog for the model pickers — the key itself never
      // crosses IPC (providers.js)
      openrouterModels: providers.catalog(),
      openrouterConfigured: providers.hasKey(),
    };
  });

  ipcMain.handle('config:set-max-agents', (e, n) => {
    const raw = Math.round(Number(n));
    const max = Number.isFinite(raw) ? Math.max(1, raw) : 10;
    config.patch({ maxAgents: max });
    ptys.maxSessions = max;
    return { maxAgents: max };
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
  /* "Native Apple style" — the renderer applies its own half instantly; this
   * copy exists for createWindow, which reads it at the next launch. */
  ipcMain.handle('config:set-native-style', (e, on) => {
    const nativeStyle = !!on;
    config.patch({ nativeStyle });
    return { nativeStyle };
  });

  /* the option's "Restart" button — quit (not exit), so before-quit's clean
   * shutdown and the window-bounds save both still run */
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('config:set-skip-permissions', (e, on) => {
    const skipPermissions = !!on;
    config.patch({ skipPermissions });
    return { skipPermissions };
  });

  /* "Isolate agents in git worktrees" (main/worktree.js). Read at spawn, so a
   * flip decides the agents launched from then on and leaves the running ones
   * in the tree they were started in — the same rule the permissions flag
   * follows, and for the same reason: the launch is where it is spent. */
  ipcMain.handle('config:set-worktrees', (e, on) => {
    const worktrees = !!on;
    config.patch({ worktrees });
    return { worktrees };
  });

  // the standard CLAUDE.md (main/template.js): the Options row names the file,
  // workspace:add copies it into each folder that has none of its own
  ipcMain.handle('template:pick', () => template.pick(deps.win));
  ipcMain.handle('template:clear', () => template.clear());

  ipcMain.handle('app:version', () => app.getVersion());
};
