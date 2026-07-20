const path = require('path');
const fs = require('fs');
const { IS_WIN, exec, toShellPath } = require('./platform');

/* macOS: node-pty's darwin prebuild execs a separate `spawn-helper` binary
 * to set up the pty before exec'ing the real command. Some zip
 * extract/re-package paths (cloud sync, MDM/AV pipelines) drop the
 * executable bit off nested binaries, which turns every session launch into
 * an opaque "posix_spawnp failed" with no indication why. Re-assert it
 * before node-pty is even required, so a fresh install self-heals instead
 * of needing a manual chmod. */
if (!IS_WIN) {
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const helper = path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  } catch {
    // best-effort — a failure here just leaves node-pty's own error to surface
  }
}
const pty = require('node-pty');
const os = require('os');
const config = require('./config');
const { pickName } = require('./names');

/* Sessions run inside a dedicated tmux server (socket "swarmeye", own config
 * file, the user's ~/.tmux.conf is never loaded) so agents survive SwarmEye
 * restarts: the pty only hosts a `tmux attach` client. Killing the pty
 * detaches; the agent keeps running — inside WSL on Windows, natively on
 * macOS. If tmux is missing we fall back
 * to spawning claude directly (sessions then die with the app). */

/* macOS: $SHELL can be stale (GUI-launched apps inherit whatever login shell was
 * cached at last login, which may since have been uninstalled/changed) — a
 * nonexistent path here makes node-pty's posix_spawn fail immediately with
 * an opaque "posix_spawnp failed", so fall back to a shell that's actually
 * on disk rather than trusting the env var blindly. */
function resolveShell() {
  for (const candidate of [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}
const SHELL = resolveShell();
const TMUX_CONF = '~/.config/swarmeye/tmux.conf';
const TMUX = `tmux -f ${TMUX_CONF} -L swarmeye`;

const CONF_LINES = [
  'set -s default-terminal tmux-256color',
  'set -s escape-time 0',
  'set -g status off',
  // off: wheel-scroll and menu-option clicks are both handled client-side by
  // xterm (scrollback below, the link provider in pane.js) — raw mouse
  // reporting has no consumer here, it only bounces click bytes into the pty
  // and echoes back as noise that fools the busy-heuristic on hookless panes
  'set -g mouse off',
  'set -g history-limit 20000', // keep in step with xterm's own scrollback cap in pane.js
  'set -g bell-action any',
  'set -g visual-bell off',
];

/* IPC-supplied terminal dimensions end up inside a shell command line —
 * force them to sane integers no matter what the renderer sent. */
function toDim(v, fallback, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(2, n)) : fallback;
}

/* Claude Code stores conversations in ~/.claude/projects/<munged-path>/,
 * where the munge is the cwd as the shell sees it, with every
 * non-alphanumeric char as '-'. On Windows that means the WSL form:
 * C:\foo bar\baz -> /mnt/c/foo bar/baz -> -mnt-c-foo-bar-baz */
function claudeProjectDirName(cwd) {
  return (toShellPath(cwd) || cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/* --allow-dangerously-skip-permissions is opt-in (⌨ Options) — without it
 * claude won't offer bypass-permissions ("auto") mode in the Shift+Tab cycle
 * at all. Unlike --dangerously-skip-permissions, the --allow- variant only
 * adds bypass mode to the cycle; it does NOT activate it at launch, so
 * agents still start in normal permission mode until the user (or a task's
 * startMode) explicitly switches to "auto".
 *
 * model is passed as a launch flag rather than a typed `/model` command:
 * `/model <name>` inside a running session saves it as the user's default
 * for new sessions, which made a single task's model choice bleed into
 * every agent started afterward. `--model` only affects this one process.
 * Already whitelisted server-side (main.js task:create) — re-checked here
 * since it lands directly in a shell command line. */
function claudeBase({ model } = {}) {
  let cmd = config.load().skipPermissions ? 'claude --allow-dangerously-skip-permissions' : 'claude';
  if (model && /^[a-zA-Z0-9._-]+$/.test(model)) cmd += ' --model ' + model;
  return cmd;
}

class PtyManager {
  constructor({ maxSessions, onData, onExit, debugLog, decorateCmd }) {
    this.maxSessions = maxSessions;
    this.onData = onData;
    this.onExit = onExit;
    this.debugLog = debugLog;
    this.decorateCmd = decorateCmd; // wraps the claude command (hook env/flags)
    this.sessions = new Map(); // id -> { proc, session }
    this.counter = 0;
    this.tmuxOk = false;
    this.shuttingDown = false;
  }

  async init() {
    const found = await exec('command -v tmux');
    this.tmuxOk = !!(found && found.trim());
    if (this.tmuxOk) {
      const conf = CONF_LINES.map((l) => `'${l}'`).join(' ');
      await exec(`mkdir -p ~/.config/swarmeye && printf '%s\\n' ${conf} > ${TMUX_CONF}`);
    }
    this.debugLog('[ptys] tmux ' + (this.tmuxOk ? 'available' : 'MISSING — sessions will not survive restarts'));
    return this.tmuxOk;
  }

  /* Reattach to tmux sessions that survived the last app run. */
  async attachExisting() {
    const cfg = config.load();
    const known = cfg.sessions || {};
    if (!this.tmuxOk) {
      if (Object.keys(known).length) config.patch({ sessions: {} });
      return [];
    }
    const out = await exec(`${TMUX} list-sessions -F '#{session_name}' 2>/dev/null; true`);
    const alive = new Set((out || '').split('\n').map((s) => s.trim()).filter(Boolean));

    const restored = [];
    const dead = [];
    for (const meta of Object.values(known)) {
      if (alive.has(meta.tmuxName) && restored.length < this.maxSessions) {
        restored.push(this._launch(meta, 100, 30, null));
        this.counter = Math.max(this.counter, meta.num || 0);
      } else {
        dead.push(meta.id);
      }
    }
    // Drop only the dead ones from whatever config.sessions holds *now*,
    // rather than overwriting wholesale from the pre-await `known` snapshot —
    // a session created while the exec above was in flight would otherwise
    // get silently wiped out from under it.
    if (dead.length) {
      const cur = { ...(config.load().sessions || {}) };
      for (const id of dead) delete cur[id];
      config.patch({ sessions: cur });
    }
    this.debugLog(`[ptys] reattached ${restored.length} of ${Object.keys(known).length} known sessions`);
    return restored;
  }

  namesInUse() {
    const cfg = config.load();
    return Object.values(cfg.sessions || {}).map((m) => m.agentName)
      .concat([...this.sessions.values()].map((s) => s.session.agentName));
  }

  spawn(workspace, cols, rows, opts = {}) {
    if (this.sessions.size >= this.maxSessions) throw new Error('cap');
    // a moved/renamed/unmounted workspace folder makes posix_spawn fail on
    // chdir with the same opaque "posix_spawnp failed" — catch it here with
    // a message that actually says what's wrong
    if (!fs.existsSync(workspace.path)) throw new Error('workspace folder not found: ' + workspace.path);
    this.counter += 1;
    const id = 's_' + Math.random().toString(36).slice(2, 10);
    const meta = {
      id,
      num: this.counter,
      agentName: pickName(this.namesInUse()),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.path,
      tmuxName: 'swarmeye_' + id,
      createdAt: Date.now(),
    };
    return this._launch(meta, cols, rows, this.decorateCmd(id, claudeBase(opts)));
  }

  /* Does this folder have a previous Claude conversation to continue?
   * `claude --continue` without one prints an error and exits 0, which
   * would look like the agent instantly dying — so we check first. */
  async hasHistory(cwd) {
    const dir = '~/.claude/projects/' + claudeProjectDirName(cwd);
    const out = await exec(`ls ${dir}/*.jsonl >/dev/null 2>&1 && echo yes; true`);
    return !!(out && out.includes('yes'));
  }

  /* Respawn an exited agent in the same folder under the same name.
   * resume=true continues the last conversation in that directory —
   * silently downgraded to a fresh session when there is none. */
  async restart({ workspaceId, workspaceName, agentName, cwd, cols, rows, resume }) {
    if (!fs.existsSync(cwd)) throw new Error('workspace folder not found: ' + cwd);
    const resumed = resume ? await this.hasHistory(cwd) : false;
    // Checked here, right before the synchronous launch below, rather than
    // before the `await` above — two restarts racing the single remaining
    // slot would otherwise both pass the check while it awaited.
    if (this.sessions.size >= this.maxSessions) throw new Error('cap');
    this.counter += 1;
    const id = 's_' + Math.random().toString(36).slice(2, 10);
    const meta = {
      id,
      num: this.counter,
      agentName,
      workspaceId,
      workspaceName,
      cwd,
      tmuxName: 'swarmeye_' + id,
      createdAt: Date.now(),
    };
    const session = this._launch(meta, cols, rows, this.decorateCmd(id, resumed ? claudeBase() + ' --continue' : claudeBase()));
    return { session, resumed };
  }

  /* Re-open the attach client for a session whose pty died while the tmux
   * session (and agent) kept running — manual detach, tmux client crash, … */
  async reattach(id, cols, rows) {
    const existing = this.sessions.get(id);
    if (existing) return existing.session;
    const meta = (config.load().sessions || {})[id];
    if (!meta || !this.tmuxOk) throw new Error('unknown-session');
    const out = await exec(`${TMUX} has-session -t =${meta.tmuxName} 2>/dev/null && echo alive; true`);
    if (!out || !out.includes('alive')) {
      this._dropMeta(id);
      throw new Error('gone');
    }
    return this._launch(meta, cols, rows, null);
  }

  /* Spawn the pty in the workspace directory. new-session -A attaches when
   * the session already exists, so one script covers create and reattach. */
  _launch(meta, cols, rows, cmd) {
    cols = toDim(cols, 100, 500);
    rows = toDim(rows, 30, 300);
    const script = this.tmuxOk
      ? `exec ${TMUX} new-session -A -s ${meta.tmuxName} -x ${cols} -y ${rows} '${cmd || 'claude'}'`
      : `exec ${cmd || 'claude'}`;
    // Windows reaches the agent through WSL, which takes the working
    // directory as a flag rather than a spawn option; macOS spawns the login
    // shell directly. A login shell either way, so ~/.local/bin is on PATH
    // and the tmux server inherits that environment.
    const [file, args, extra] = IS_WIN
      ? ['wsl.exe', ['--cd', meta.cwd, '--', 'bash', '-lc', script], { useConpty: true }]
      : [SHELL, ['-lc', script], { cwd: meta.cwd, env: process.env }];

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      ...extra,
    });

    const session = { ...meta, persistent: this.tmuxOk };
    this.sessions.set(meta.id, { proc, session });
    this._saveMeta(meta);

    proc.onData((data) => this.onData(meta.id, data));
    proc.onExit(({ exitCode }) => this._handleExit(meta, exitCode));

    return session;
  }

  async _handleExit(meta, exitCode) {
    this.sessions.delete(meta.id);
    if (this.shuttingDown) return; // quitting: client detached, agent lives on
    let detached = false;
    if (this.tmuxOk) {
      // claude gone => tmux session gone => real exit. Session still alive
      // means the client merely detached; keep metadata so a reattach works.
      // An unanswered probe (shell hiccup) also keeps the metadata.
      const out = await exec(`echo probe; ${TMUX} has-session -t =${meta.tmuxName} 2>/dev/null && echo alive; true`);
      const probed = !!(out && out.includes('probe'));
      const alive = !!(out && out.includes('alive'));
      detached = !probed || alive;
      if (probed && !alive) this._dropMeta(meta.id);
      this.debugLog(`[ptys] exit ${meta.id} code=${exitCode} ${detached ? 'detached' : 'gone'}`);
    } else {
      this._dropMeta(meta.id);
    }
    this.onExit(meta.id, exitCode, detached);
  }

  _saveMeta(meta) {
    const cfg = config.load();
    config.patch({ sessions: { ...(cfg.sessions || {}), [meta.id]: meta } });
  }

  _dropMeta(id) {
    const cfg = config.load();
    const sessions = { ...(cfg.sessions || {}) };
    delete sessions[id];
    config.patch({ sessions });
  }

  rename(id, agentName) {
    agentName = String(agentName || '').slice(0, 40).trim() || 'agent';
    const s = this.sessions.get(id);
    if (s) s.session.agentName = agentName;
    const cfg = config.load();
    const meta = (cfg.sessions || {})[id];
    if (meta) this._saveMeta({ ...meta, agentName });
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.proc.resize(toDim(cols, 80, 500), toDim(rows, 24, 300));
    } catch {
      // ignore resize races around exit
    }
  }

  /* Kill for real: the agent process too, not just the attach client. */
  async kill(id) {
    const s = this.sessions.get(id);
    const cfg = config.load();
    const meta = s ? s.session : (cfg.sessions || {})[id];
    // Metadata is dropped only after the kill is actually issued — dropping
    // it first would let a crash/force-quit in between forget a tmux session
    // that's still alive, orphaning it with no reattach path.
    if (this.tmuxOk && meta && meta.tmuxName) {
      await exec(`${TMUX} kill-session -t =${meta.tmuxName} 2>/dev/null; true`);
    }
    if (s) {
      try { s.proc.kill(); } catch { /* already gone */ }
    }
    this._dropMeta(id);
  }

  /* App shutdown: detach only — tmux sessions (and their agents) survive. */
  shutdown() {
    this.shuttingDown = true;
    for (const [, s] of this.sessions) {
      try { s.proc.kill(); } catch { /* already gone */ }
    }
    this.sessions.clear();
  }

  runningCount() {
    return this.sessions.size;
  }
}

module.exports = { PtyManager };
