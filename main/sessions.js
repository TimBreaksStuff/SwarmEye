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

/* Wheel-scroll. Mouse reporting is on, but the only mouse tmux ever sees is
 * the wheel: pane.js still swallows xterm's own mouse-reporting requests, so
 * clicks stay client-side (selection, the menu-option link provider) and
 * never bounce click bytes into the pty, while wheel notches over a pane's
 * output are synthesized as SGR mouse bytes for tmux.
 *
 * Where the notch then goes depends on what the pane is running. Claude Code
 * paints on the alternate screen and turns SGR mouse reporting on, so tmux
 * keeps no history for that pane at all (`alternate_on 1`, `history_size 0`)
 * and copy mode would have nothing to scroll — the agent owns its transcript
 * and scrolls it itself, so the notch is forwarded to it. Only a pane that
 * never asked for the mouse (a plain shell) gets the copy-mode treatment,
 * where tmux's history is the scrollback. */
const WHEEL_LINES = [
  'set -g mouse on',
  // stock tmux burns the first notch entering copy mode; scroll on it too
  'bind -n WheelUpPane if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" "send -M" "copy-mode -e ; send -X -N 5 scroll-up"',
  // the root table has no WheelDownPane at all by default, so scrolling back
  // down did nothing: forward it, to the agent or to copy mode as above
  'bind -n WheelDownPane send -M',
  // typing must drop the pane back to the live view: the first write after a
  // wheel notch is prefixed with M-q (see PtyManager.write). An agent that
  // scrolled itself is told to jump to the bottom, a pane in copy mode has
  // that cancelled by the copy-mode bindings below, and anything else gets a
  // silent no-op so a stray M-q never reaches the agent.
  'bind -n M-q if -F "#{mouse_any_flag}" "send-keys C-End" "set -g @swarmeye-noop 1"',
  'bind -T copy-mode M-q send -X cancel',
  'bind -T copy-mode-vi M-q send -X cancel',
];

/* an SGR wheel report (button 64 up / 65 down) — the only mouse tmux sees */
const WHEEL_SGR_RE = /^\x1b\[<6[45];/;

const CONF_LINES = [
  'set -s default-terminal tmux-256color',
  'set -s escape-time 0',
  'set -g status off',
  ...WHEEL_LINES,
  'set -g history-limit 20000', // keep in step with xterm's own scrollback cap in pane.js
  'set -g bell-action any',
  'set -g visual-bell off',
];

/* tmux drops OSC 8 hyperlinks (an agent's login URL, say) unless the attached
 * client's terminal is listed as hyperlinks-capable — xterm.js is (pane.js's
 * linkHandler), tmux just can't know that. Only meaningful on tmux >= 3.4
 * (where hyperlink forwarding exists), and kept out of CONF_LINES because
 * tmux < 3.2 errors on the option, which at server start surfaces as a
 * config-error message inside the first pane. */
const HYPERLINKS_LINE = 'set -as terminal-features *:hyperlinks';

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

/* Role presets for + Coding Agent: a short system prompt appended at launch
 * and the model tier that job is worth. Deliberately quote-free and free of
 * $ ` and backslashes — the prompt is interpolated into the command line that
 * _launch wraps in single quotes for tmux, so a quote here would break the
 * whole launch. Main owns the table; the renderer only ever sees key + label. */
const ROLES = {
  builder: {
    label: 'Builder',
    model: 'sonnet',
    prompt: 'You are the builder in a swarm of agents. Implement exactly what you are asked and nothing more: the smallest working diff, the patterns already in this codebase, no speculative abstractions. When you are done, say in a few lines what you changed and what you left alone.',
  },
  reviewer: {
    label: 'Reviewer',
    model: 'opus',
    prompt: 'You are the reviewer in a swarm of agents. Read the code and report what is wrong with it: correctness first, then security, then clarity. Do not edit files unless you are explicitly asked to fix something. One line per finding, most severe first, and say plainly when you found nothing.',
  },
  scout: {
    label: 'Scout',
    model: 'haiku',
    prompt: 'You are the scout in a swarm of agents. Locate things and report where they are: file paths with line numbers, call sites, naming conventions. Read only. Do not edit files and do not propose designs. Keep the answer short.',
  },
  planner: {
    label: 'Planner',
    model: 'opus',
    prompt: 'You are the planner in a swarm of agents. Turn the request into a short ordered plan: which files it touches, the steps in order, and the risks. Read only. Do not edit files and do not write the code yourself.',
  },
};

/* A workspace can keep a `.swarmeye/notes.md` — what one agent learned about
 * this repo, so the next one starts with it instead of rediscovering it.
 *
 * It reaches the agent as a *pointer*, not as content. Inlining the file would
 * put every line of it in every agent's context and bill for it on every turn
 * whether the notes were relevant or not; a pointer costs ~20 tokens once and
 * lets the agent open the file when the work actually calls for it.
 *
 * Same quoting rules as the role prompts above: no quotes, $, backticks or
 * backslashes, since this lands in the same single-quoted tmux command. */
const NOTES_REL = path.join('.swarmeye', 'notes.md');
const NOTES_PROMPT = 'This workspace keeps shared notes at .swarmeye/notes.md. '
  + 'Read that file before making assumptions about this repo, and append anything '
  + 'a later agent working here would want to know.';

/* An empty notes file is not worth a pointer — the agent would open it, find
 * nothing, and the tokens would be spent for no reason. */
function hasNotes(cwd) {
  try {
    return fs.statSync(path.join(cwd, NOTES_REL)).size > 0;
  } catch {
    return false;
  }
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
function claudeBase({ model, resume, role, notes, effort } = {}) {
  let cmd = config.load().skipPermissions ? 'claude --allow-dangerously-skip-permissions' : 'claude';
  const preset = ROLES[role];
  // the role's model is a default, not an override — an explicit pick (the
  // task's own model select, or the Options default) still wins
  const effectiveModel = model || (preset && preset.model);
  if (effectiveModel && /^[a-zA-Z0-9._-]+$/.test(effectiveModel)) cmd += ' --model ' + effectiveModel;
  // effort is a launch flag for the same reason model is: a typed `/effort
  // <level>` saves as the user's default for new sessions (CLI 2.1.x), so one
  // low-effort task would bleed into every agent started afterward. The flag
  // only knows the five named levels — ultracode/auto still go in typed.
  if (effort && /^(low|medium|high|xhigh|max)$/.test(effort)) cmd += ' --effort ' + effort;
  // roles are a launch flag rather than a typed first message: --append-system-prompt
  // costs no turn and cannot collide with the task board's own prompt injection.
  // The texts below are ours and contain no shell metacharacters — that is what
  // makes them safe inside the single-quoted tmux command (see _launch).
  // one --append-system-prompt carrying both, not two flags: the role and the
  // notes pointer are the same kind of appended text, and claude takes the
  // last such flag rather than concatenating them
  const appended = [preset && preset.prompt, notes && NOTES_PROMPT].filter(Boolean).join(' ');
  if (appended) cmd += ` --append-system-prompt "${appended}"`;
  // a conversation id picked from the History screen. Claude Code names its
  // transcripts after the session uuid, so the id is what --resume takes;
  // re-validated here since it lands in a shell command line.
  if (resume && /^[A-Za-z0-9-]{8,64}$/.test(resume)) cmd += ' --resume ' + resume;
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

  /* Every exec here is a shell spawn — a `wsl.exe` one on Windows, which costs
   * a few hundred ms each — and this runs on the boot path before any agent
   * can be reattached, so both halves are one round trip rather than seven:
   * presence and version together, then the whole config in a single script. */
  async init() {
    const ver = await exec('command -v tmux >/dev/null && tmux -V');
    this.tmuxOk = !!(ver && ver.trim());
    if (this.tmuxOk) {
      const m = /(\d+)\.(\d+)/.exec(ver);
      const hyperlinksOk = !!m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 4));
      const lines = hyperlinksOk ? CONF_LINES.concat(HYPERLINKS_LINE) : CONF_LINES;
      const conf = lines.map((l) => `'${l}'`).join(' ');
      // the conf only applies at server start, and the server outlives the
      // app (that's the point) — apply to an already-running one too, once.
      // The wheel lines are plain sets and binds, so re-applying is a no-op.
      const script = [
        `mkdir -p ~/.config/swarmeye && printf '%s\\n' ${conf} > ${TMUX_CONF}`,
        ...WHEEL_LINES.map((line) => `${TMUX} ${line} 2>/dev/null; true`),
      ];
      if (hyperlinksOk) {
        script.push(`${TMUX} show -s terminal-features 2>/dev/null | grep -q hyperlinks`
          + ` || ${TMUX} set -as terminal-features "*:hyperlinks" 2>/dev/null; true`);
      }
      await exec(script.join('; '));
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
      // Already attached: hand back the live session rather than opening a
      // second client. `session:list` calls this every time, and a renderer
      // reload calls it again — a duplicate client would drag the tmux window
      // down to its own 100x30 and leave every pane redrawing at the wrong
      // width.
      const live = this.sessions.get(meta.id);
      if (live) {
        restored.push(live.session);
        this.counter = Math.max(this.counter, meta.num || 0);
      } else if (alive.has(meta.tmuxName) && restored.length < this.maxSessions) {
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
    // persisted so a pane rebuilt from tmux after a restart still shows its
    // role chip — the flag itself is long gone by then, it lives in the process
    if (ROLES[opts.role]) meta.role = opts.role;
    return this._launch(meta, cols, rows,
      this.decorateCmd(id, claudeBase({ ...opts, notes: hasNotes(workspace.path) })));
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
  async restart({ workspaceId, workspaceName, agentName, cwd, cols, rows, resume, role, model }) {
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
    // a restarted agent keeps the role it was launched with — the system
    // prompt has to be re-appended, it is not part of the resumed conversation
    if (ROLES[role]) meta.role = role;
    // `model` is how a restart moves the agent to another tier (the pane's
    // right-sizing offer). Left undefined it is the role's model, or the
    // account default — i.e. exactly what a plain restart did before.
    const notes = hasNotes(cwd);
    const cmd = this.decorateCmd(id, resumed
      ? claudeBase({ role, model, notes }) + ' --continue'
      : claudeBase({ role, model, notes }));
    const session = this._launch(meta, cols, rows, cmd);
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

  /* Persists the pane subheader's "last command" text so a restart (session
   * reattached from tmux, everything else in memory lost) can still show it —
   * see Pane.captureInitialCommand / syncInitialCommandHeader. */
  setLastCommand(id, cmd) {
    const s = this.sessions.get(id);
    if (s) s.session.lastCommand = cmd;
    const cfg = config.load();
    const meta = (cfg.sessions || {})[id];
    if (meta) this._saveMeta({ ...meta, lastCommand: cmd });
  }

  /* Wheel notches reach a session as SGR mouse bytes (pane.js synthesizes
   * them, see WHEEL_LINES) and can put tmux into copy mode, where anything
   * typed next would be swallowed — so the first write that is not a wheel
   * event leaves copy mode first. Every path that types at an agent goes
   * through here, dispatched tasks included. M-q cancels copy mode and is
   * bound to a no-op outside it, so the prefix is harmless when the pane
   * never entered copy mode (an agent scrolling its own transcript) or
   * already dropped out of it. Only with tmux, though: without it the prefix
   * would reach the agent as a literal Alt+Q. */
  write(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.tmuxOk && WHEEL_SGR_RE.test(data)) {
      s.scrolledBack = true;
    } else if (s.scrolledBack) {
      s.scrolledBack = false;
      data = '\x1bq' + data;
    }
    s.proc.write(data);
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

  // the agents alive right now, for callers that need to leave what they are
  // using alone (history:delete keeps their transcripts)
  sessionIds() {
    return [...this.sessions.keys()];
  }
}

module.exports = { PtyManager, claudeProjectDirName, ROLES, NOTES_REL };
