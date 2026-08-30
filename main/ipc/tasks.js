/* IPC: the task board's store, plus the two things that write into it — the
 * coordinator (one request in, a list of subtasks out) and the orchestrator's
 * plan file.
 *
 * Main only stores tasks; which one starts, and when, is the renderer's
 * scheduler (renderer/features/scheduler/scheduler.js). */

const { ipcMain } = require('electron');
const config = require('../config');
const roles = require('../roles');
const providers = require('../providers');
const coordinator = require('../coordinator');
const orchestrator = require('../orchestrator');
const worktree = require('../worktree');
const tasklogs = require('../tasklogs');
const path = require('path');
const { MODEL_FLAGS, EFFORT_VALUES } = require('../models');

module.exports = function register(deps) {
  const { sendToWin, projectArchive } = deps;

  // transcripts an older version stored on the task records themselves
  tasklogs.migrate();

  // task board: queued todos for agents, started now or auto-scheduled by
  // the renderer once an agent slot and usage headroom are both available
  // sessionLog is accepted but never stored on the record — see task:update
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
      // Claude tiers or an OpenRouter value (providers.js) — including the
      // foreign harnesses, which session:create has always accepted and this
      // silently rewrote to 'default', so a board task could never run one
      model: (MODEL_FLAGS.includes(model) || providers.slugOf(model)
        || providers.cleanSlugOf(model) || providers.isForeign(model)) ? model : 'default',
      // the role preset the task's agent launches with — same table and same
      // check session:create applies, since it ends up in the same flag
      role: roles.has(role) ? role : '',
      // every level the table names: the flag ones, plus 'ultracode' and
      // 'auto', which exist only as commands typed into a running agent
      effort: EFFORT_VALUES.includes(effort) ? effort : 'default',
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
    /* The transcript goes to its own file (main/tasklogs.js) and never onto
     * the task record: it is up to 300KB, and config.json is rewritten
     * synchronously by every unrelated mutation. The record keeps the flag the
     * board draws its "view transcript" button from. Still tail-capped — the
     * pane's scrollback is 20k lines, which is more than a popup can use. */
    if (typeof safe.sessionLog === 'string') {
      const log = safe.sessionLog.slice(-300000);
      delete safe.sessionLog;
      if (tasklogs.write(id, log)) safe.hasSessionLog = true;
    }
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
  // so it can still be reviewed or permanently purged from the Archive view.
  // Its transcript stays where it is — an archived task reads the same file a
  // live one does, so archiving moves a record, not megabytes.
  ipcMain.handle('task:delete', (e, id) => {
    const cfg = config.load();
    const task = (cfg.tasks || []).find((t) => t.id === id);
    cfg.tasks = (cfg.tasks || []).filter((t) => t.id !== id);
    config.save(cfg);
    let archived = config.loadArchive();
    if (task) {
      // capped so archive.json can't grow without bound — an entry pushed off
      // the end takes its transcript file with it
      const kept = [task, ...archived.filter((t) => t.id !== task.id)];
      for (const gone of kept.slice(200)) tasklogs.drop(gone.id);
      archived = kept.slice(0, 200);
      config.saveArchive(archived);
    }
    return { tasks: cfg.tasks, archivedTasks: projectArchive(archived) };
  });

  /* One task's transcript, on demand — neither the board payload nor the
   * archive one carries them (see the projection in ipc/index.js). Live and
   * archived tasks read the same store; the archive entry itself is the
   * fallback for transcripts a pre-2.7.0 version wrote into archive.json. */
  ipcMain.handle('task:log', (e, id) => {
    const log = tasklogs.read(id);
    if (log) return { sessionLog: log };
    const t = config.loadArchive().find((x) => x.id === id);
    return { sessionLog: (t && t.sessionLog) || '' };
  });

  ipcMain.handle('task:purge', (e, id) => {
    const archived = config.loadArchive().filter((t) => t.id !== id);
    config.saveArchive(archived);
    tasklogs.drop(id);
    return { archivedTasks: projectArchive(archived) };
  });

  ipcMain.handle('task:purge-all', () => {
    for (const t of config.loadArchive()) tasklogs.drop(t.id);
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

  /* The lead agent's plan file (main/orchestrator.js). A lead is an ordinary
   * agent in a pane, so it hands work back the only way an agent always can:
   * by writing a file. Watching starts when the renderer launches one and
   * stops when its pane goes, and each wave is consumed off disk as it is
   * read — so a second wave means the lead wrote the file a second time.
   * Same rule as the notebook above: the path is resolved here from the
   * workspace id, so the renderer never names a file. */
  ipcMain.handle('orchestrator:watch', (e, { sessionId, workspaceId }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    const id = String(sessionId || '');
    if (!id) return { ok: false, reason: 'no-session' };
    /* The lead writes `.swarmeye/plan.json` in the folder it is running in,
     * which with worktrees on is its own tree and not the workspace — watch
     * the wrong one and every wave is missed in silence. */
    const wt = worktree.get(id);
    const ok = orchestrator.watch(id, (wt && wt.path) || ws.path, (wave) => sendToWin('orchestrator:plan', { sessionId: id, ...wave }));
    return ok ? { ok: true } : { ok: false, reason: 'cannot-watch' };
  });

  ipcMain.handle('orchestrator:unwatch', (e, { sessionId }) => {
    orchestrator.unwatch(String(sessionId || ''));
    return { ok: true };
  });
};
