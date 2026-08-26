/* IPC: the agent sessions themselves — list, create, restart, reattach,
 * rename, export, kill, and the two fire-and-forget streams (write, resize).
 *
 * Anything reaching the shell command line is re-validated here even when the
 * renderer already checked it: model names, effort flags, scopes, dimensions. */

const { app, ipcMain, dialog } = require('electron');
const config = require('../config');
const roles = require('../roles');
const providers = require('../providers');
const agentScope = require('../scope');
const path = require('path');
const fs = require('fs');
const { MODELS, EFFORT_FLAGS } = require('../sessions');

module.exports = function register(deps) {
  const { ptys, usage, ptysReady, hooks, skills, debugLog } = deps;

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

  // role presets for the + Agent picker, the coordinator and the orchestrator.
  // The prompt itself stays in main: it is only ever appended at launch, and
  // the renderer has nothing to do with it.
  ipcMain.handle('roles:list', () => roles.list().map(({ key, label, model }) => ({ key, label, model })));
  /* A scope is a permission boundary, so everything about it fails loudly: a
   * path that is no longer there, or a harness with no permission layer to
   * deny with (clean/opencode/pi answer to no settings file), refuses the
   * launch rather than quietly starting an agent that can edit anything.
   *
   * `want` is { label, paths } — one folder, or an area's several. 1.60.75
   * sent a bare path string and sessions persisted under it may still be
   * running, so that shape is still read. Returns what main will act on. */
  const MAX_SCOPE_PATHS = 40;

  function checkScope(want, root, model) {
    if (!want) return {};
    const asked = typeof want === 'string' ? { label: want, paths: [want] } : want;
    const list = [].concat(asked.paths || []);
    if (!list.length) return {};
    if (list.length > MAX_SCOPE_PATHS) return { error: 'that scope names too many paths' };
    if (providers.cleanSlugOf(model) || providers.isForeign(model)) {
      return { error: 'a folder scope needs a Claude agent' };
    }
    const paths = [];
    for (const p of list) {
      const at = agentScope.resolve(root, p);
      if (!at) return { error: 'that folder is not in the workspace any more' };
      if (!paths.includes(at.rel)) paths.push(at.rel);
    }
    // display only — it reaches the pane chip, never a command line
    const label = String(asked.label || paths[0]).replace(/\s+/g, ' ').trim().slice(0, 60) || paths[0];
    return { scope: { label, paths } };
  }

  ipcMain.handle('session:create', async (e, { workspaceId, cols, rows, model, role, effort, scope }) => {
    await ptysReady;
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === workspaceId);
    if (!ws) { debugLog('[session:create] no-workspace ' + workspaceId); return { ok: false, reason: 'no-workspace' }; }
    // an OpenRouter model can't launch without the key — fail loudly rather
    // than silently falling back to a Claude launch the user didn't pick
    if ((providers.slugOf(model) || providers.cleanSlugOf(model) || providers.isForeign(model)) && !providers.hasKey()) return { ok: false, reason: 'openrouter-key' };
    // checked against the workspace before anything is spawned, so a bad
    // scope costs nothing to refuse
    const scoped = checkScope(scope, ws.path, model);
    if (scoped.error) return { ok: false, reason: scoped.error };
    try {
      // resumeId is re-validated again in claudeBase, since it lands in a
      // shell command line. role is only ever a key into main's own table,
      // never free text.
      const session = ptys.spawn(ws, cols || 80, rows || 24, {
        model,
        role: roles.has(role) ? role : undefined,
        effort: EFFORT_FLAGS.includes(String(effort || '')) ? effort : undefined,
        scope: scoped.scope,
        // the skill folders flagged "In OpenRouter agents" — resolved here
        // because the skills manager lives in main, not in the pty layer. All
        // three bare harnesses take them; each builder has its own way in.
        orSkills: providers.cleanSlugOf(model) || providers.isForeign(model) ? skills.orSkillDirs(ws.id) : undefined,
      });
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
    // ↻ keeps the folder the agent was scoped to — the pane hands it back the
    // way it hands back the role, since the deny rules live in the launch and
    // not in the conversation being resumed
    const scoped = checkScope(payload.scope, ws.path, payload.model);
    if (scoped.error) return { ok: false, reason: scoped.error };
    // a clean agent's conversation lives in its own messages file, keyed by
    // the pane's previous session id — resume is only offered when it exists
    let continueFrom;
    if (payload.resume && providers.cleanSlugOf(payload.model) && /^[A-Za-z0-9_-]{1,64}$/.test(String(payload.oldId || ''))) {
      try {
        const dir = path.join(hooks.stateDir, '..', 'clean-transcripts');
        if (fs.readdirSync(dir).some((f) => f.startsWith(payload.oldId) && f.endsWith('.messages.json'))) continueFrom = payload.oldId;
      } catch { /* nothing to continue */ }
    }
    // opencode and pi own their conversations; their adapter parked the id
    // beside the transcript of the pane being restarted. No file means the
    // pane never got that far — launch fresh rather than fail.
    let resumeId;
    if (payload.resume && providers.isForeign(payload.model)) {
      resumeId = providers.foreignResumeId(hooks.stateDir, providers.foreignHarness(payload.model), String(payload.oldId || '')) || undefined;
      if (resumeId) continueFrom = payload.oldId; // keep appending the old transcript, so the cost tally carries on
    }
    try {
      const { session, resumed } = await ptys.restart({
        workspaceId: ws.id,
        workspaceName: ws.name,
        cwd: ws.path,
        agentName: String(payload.agentName || '').slice(0, 40).trim() || 'agent',
        cols: payload.cols,
        rows: payload.rows,
        resume: !!payload.resume,
        role: roles.has(payload.role) ? payload.role : undefined,
        // same whitelist task:create applies — it lands in the same launch
        // flag — plus the third-party harnesses, which the board does not
        // offer but a pane restart must not silently drop: an unlisted value
        // comes back as a plain Claude agent nobody asked for
        model: (MODELS.includes(payload.model) || providers.slugOf(payload.model)
          || providers.cleanSlugOf(payload.model) || providers.isForeign(payload.model)) ? payload.model : undefined,
        continueFrom,
        resumeId,
        orSkills: providers.cleanSlugOf(payload.model) || providers.isForeign(payload.model)
          ? skills.orSkillDirs(ws.id) : undefined,
        replaceId: /^s_[A-Za-z0-9]+$/.test(String(payload.oldId || '')) ? payload.oldId : undefined,
        scope: scoped.scope,
      });
      if (payload.oldId && session.id !== payload.oldId) {
        const tasks = config.load().tasks || [];
        const next = tasks.map((t) => t.paneId === payload.oldId ? { ...t, paneId: session.id } : t);
        if (next.some((t, i) => t !== tasks[i])) config.patch({ tasks: next });
      }
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
    // plain text, always: what the renderer sends is a pane's scrollback
    // (getBufferText), and the HTML half of this used to branch on an `ext`
    // that was never declared — every export died on a ReferenceError
    const res = await dialog.showSaveDialog(deps.win, {
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
};
