const path = require('path');
const fs = require('fs');
const { IS_WIN, SHELL, exec, spawnDetachedShell, toShellPath } = require('./platform');

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
const providers = require('./providers');
const { pickName } = require('./names');

/* Sessions run inside a dedicated tmux server (socket "swarmeye" — see
 * socketName — own config file, the user's ~/.tmux.conf is never loaded) so
 * agents survive SwarmEye
 * restarts: the pty only hosts a `tmux attach` client. Killing the pty
 * detaches; the agent keeps running — inside WSL on Windows, natively on
 * macOS. If tmux is missing we fall back
 * to spawning claude directly (sessions then die with the app). */

const TMUX_CONF = '~/.config/swarmeye/tmux.conf';

/* One tmux server per user-data-dir. Without `--user-data-dir` the socket is
 * "swarmeye", exactly as it has always been; a second instance launched on its
 * own one — which is how this app is tested, there being no test suite — gets a
 * socket of its own, so it can neither reattach to nor *reap* the agents of the
 * instance the user is actually running. The reap below decides "orphan" from
 * config.sessions, and a fresh user-data-dir knows no sessions at all: sharing
 * one server, a throwaway test instance would kill every live agent on boot. */
function socketName() {
  const i = process.argv.findIndex((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
  if (i < 0) return 'swarmeye';
  const dir = process.argv[i].includes('=')
    ? process.argv[i].slice(process.argv[i].indexOf('=') + 1)
    : (process.argv[i + 1] || '');
  return 'swarmeye-' + require('crypto').createHash('sha1').update(dir).digest('hex').slice(0, 8);
}
const TMUX = `tmux -f ${TMUX_CONF} -L ${socketName()}`;
/* tmux's exact-match target prefix (`-t =name`) must always be quoted: the
 * macOS shell is zsh, where a bare leading `=` is filename expansion — it
 * looks up `name` as a *command*, fails with "zsh:1: <name> not found" and
 * aborts the whole line before tmux ever runs. That silently broke attach,
 * kill and the has-session probes on macOS only. */

/* The Windows keeper's script (see PtyManager._ensureKeeper). It crosses to
 * WSL as a single argument through cmd.exe, which re-parses what it is handed,
 * so it must contain no double quote — everything below is single-quoted or
 * bare, and cmd sees the `|`, `&` and `>` inside the argument as literals.
 *
 * `flock -n` is what keeps one keeper per machine rather than one per app run:
 * a second one exec's into flock, fails to take the lock and exits. Should
 * flock be missing (it is util-linux, so on every WSL image worth running),
 * `command -v` short-circuits the exec and the loop runs unlocked — a spare
 * idle keeper is a far smaller problem than no keeper. */
const KEEPER_LOOP = `while sleep 30; do ${TMUX} list-sessions >/dev/null 2>&1 || break; done`;
const KEEPER_CMD = `: swarmeye-keeper; command -v flock >/dev/null`
  + ` && exec flock -n ~/.config/swarmeye/keeper.lock -c '${KEEPER_LOOP}'; ${KEEPER_LOOP}`;

/* Whitelists shared with main.js so a new tier/level/id-shape is one edit.
 * The *checks* stay at every shell boundary on purpose — only the values
 * live here. */
const MODELS = ['sonnet', 'opus', 'haiku', 'fable', 'opusplan', 'opus[1m]', 'sonnet[1m]'];
const EFFORT_FLAGS = ['low', 'medium', 'high', 'xhigh', 'max'];

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

/* Modified Enter (Shift+Enter for a newline, the usual "keep typing" key in
 * these TUIs) can only reach an agent as an extended key sequence, and tmux
 * refuses to forward those unless this is on — pi prints a warning about it in
 * every pane it starts in. `on` forwards them to agents that ask for them
 * rather than sending them unconditionally (`always`), so nothing changes for
 * an agent that never requests them. Gated like HYPERLINKS_LINE: the option
 * arrived in tmux 3.2, and an older server rejects an unknown option loudly,
 * inside the first pane. */
const EXTENDED_KEYS_LINE = 'set -g extended-keys on';

/* A server that outlives its last session, so that _launch can start one
 * *before* handing over an OpenRouter key: tmux daemonizes by keeping the argv
 * and environment of whichever client started the server, so the process that
 * starts it must never be the one carrying the key (see _launch). Costs an
 * idle tmux server between agents. Gated with EXTENDED_KEYS_LINE because the
 * `new-session -e` this exists to protect wants tmux >= 3.2 anyway — below
 * that an OpenRouter agent cannot launch at all, and everything else should
 * keep behaving exactly as it did. */
const EXIT_EMPTY_LINE = 'set -g exit-empty off';

/* IPC-supplied terminal dimensions end up inside a shell command line —
 * force them to sane integers no matter what the renderer sent. */
function toDim(v, fallback, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(2, n)) : fallback;
}

/* Claude Code stores conversations in ~/.claude/projects/<munged-path>/,
 * where the munge is the cwd as the shell sees it, with every
 * non-alphanumeric char as '-'. On Windows that means the WSL form:
 * C:\foo bar\baz -> /mnt/c/foo bar/baz -> -mnt-c-foo-bar-baz
 *
 * Claude munges its *own* `process.cwd()`, and getcwd() hands back the real
 * spelling on disk — symlinks resolved, and on macOS the true case. So a
 * workspace added as `01-swarmeye` when the folder is really `01-SwarmEye`
 * opens, chdirs and runs perfectly on that case-insensitive filesystem while
 * the two munges differ by one letter — and hooks.js, which checks the
 * transcript an agent reports against this name, dropped every event from
 * every agent in that workspace. Resolve first, and both sides build the same
 * string. */
function claudeProjectDirName(cwd) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* gone, or a share realpath cannot follow */ }
  return (toShellPath(real) || real).replace(/[^A-Za-z0-9]/g, '-');
}

/* Role presets live in main/roles.js — a fixed table this file looks one up
 * in rather than owning. The quoting rule still applies and is stated there:
 * no quotes, $, backticks or backslashes, because the prompt is interpolated
 * into the command line that _launch wraps in single quotes for tmux. */
const roles = require('./roles');
const scope = require('./scope');

/* The Edit deny rules that keep an agent inside one folder of its own working
 * directory (main/scope.js). A scope that cannot be turned into rules — the
 * folder is gone, or it is a Windows path with no WSL spelling — throws
 * rather than launching: both callers run inside a try that answers the
 * renderer, and an agent that believes it is scoped and is not is worse than
 * a launch that refuses. */
function scopeDeny(cwd, want) {
  if (!want) return undefined;
  // main hands over { label, paths }; 1.60.75's bare path string is still read
  // here because a session persisted under it can still be running
  const paths = typeof want === 'string' ? [want] : [].concat(want.paths || []);
  if (!paths.length) return undefined;
  const rules = scope.denyRules(cwd, paths);
  if (!rules) throw new Error('could not scope this agent to ' + paths.join(', '));
  return rules;
}

/* The one line a pane shows when a bare harness cannot be launched. A CLI the
 * agent's shell can't find is the common cause and used to be invisible — the
 * command died on "not found" before anything was drawn and tmux took the
 * message down with the session, leaving a bare [exited]. */
function cannotLaunch(harness) {
  const bin = providers.missingBin(harness);
  const why = bin
    ? `${bin} is not on PATH in the agent shell — install it, then restart SwarmEye`
    : 'OpenRouter key missing or app path not shell-safe';
  // `read` holds the pane on the message: a command that exits takes its tmux
  // session down before the client has drawn a frame, so anything it printed
  // is lost — which is what made this message invisible until now. Enter
  // dismisses it. The trailing `#` comments out the --settings flag
  // decorateCmd appends after the command it is given.
  return `echo ${harness} agent: ${why}; read -r _; #`;
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
function claudeBase({ model, role, effort, orSkills, continueFrom, resumeId } = {}) {
  let cmd = config.load().skipPermissions ? 'claude --allow-dangerously-skip-permissions' : 'claude';
  const preset = roles.get(role);
  // the role's model is a default, not an override — an explicit pick (the
  // task's own model select, or the Options default) still wins
  const effectiveModel = model || (preset && preset.model);
  // an 'oc:<slug>' value replaces claude entirely: the clean agent
  // (agent/clean.js, see clean-agent-plan.md) talks straight to OpenRouter.
  // The role prompt rides its --system flag; skipPermissions maps
  // to --yolo (there is no permission footer to steer; restart appends
  // --continue itself). A null command (key gone since the create-time
  // check, unsafe script path) becomes a visible one-line failure in the
  // pane rather than a silent fall-through to a Claude launch nobody picked.
  const cleanSlug = providers.cleanSlugOf(effectiveModel);
  if (cleanSlug) {
    return providers.cleanCmd(cleanSlug, { system: (preset && preset.prompt) || '', yolo: !!config.load().skipPermissions, skills: orSkills })
      || cannotLaunch('clean');
  }
  // 'opencode:' / 'pi:' replace claude with a third-party CLI carrying our own
  // adapter (agent/README.md). Same failure rule as the clean agent: a
  // null command is a visible one-line message in the pane, never a silent
  // fall-through to a Claude launch nobody picked. opencode has no
  // system-prompt flag, so a role preset only supplies its model there; pi
  // takes the role prompt, and gates nothing by design.
  // Both take the OR-startup skills, each by its own route (providers.js).
  // on a restart, continueFrom keeps the pane's own transcript (so the cost
  // tally carries on) and resumeId is the harness's own conversation id — both
  // ride the command these builders make, not a flag appended after it
  const opencodeSlug = providers.opencodeSlugOf(effectiveModel);
  if (opencodeSlug) {
    return providers.opencodeCmd(opencodeSlug, { yolo: !!config.load().skipPermissions, continueFrom, resumeId, skills: orSkills })
      || cannotLaunch('opencode');
  }
  const piSlug = providers.piSlugOf(effectiveModel);
  if (piSlug) {
    return providers.piCmd(piSlug, { system: (preset && preset.prompt) || '', continueFrom, resumeId, skills: orSkills })
      || cannotLaunch('pi');
  }
  // an 'or:<slug>' value launches through OpenRouter: the model rides an env
  // prefix (providers.js maps every tier alias to the one slug) rather than
  // --model, and --effort stays off — Anthropic's adaptive-thinking request
  // fields 400 on foreign upstreams. Every env token is regex-validated in
  // providers.js under the same no-quotes rule as the strings below.
  const orSlug = providers.slugOf(effectiveModel);
  if (orSlug) {
    const prefix = providers.envPrefix(orSlug);
    // a null prefix (key cleared since launch) must not fall through to a
    // plain claude launch billed to the Anthropic account nobody picked —
    // restarts skip the create-time key check, so this is their gate
    if (!prefix) return 'echo OpenRouter agent: key missing — cannot relaunch ' + orSlug;
    cmd = prefix + cmd;
  // brackets are in the set for the 1M-context aliases ('opus[1m]') — and they
  // are why the value is double-quoted: tmux runs this command through the
  // user's login shell, where a bare `sonnet[1m]` is a glob with no match, and
  // zsh refuses the whole line rather than passing it through the way sh does.
  // The agent then never starts and the pane reads [exited]. The quotes are
  // safe for the same reason --append-system-prompt's are: the value cannot
  // contain a quote, $, backtick or backslash.
  } else if (effectiveModel && /^[a-zA-Z0-9._[\]-]+$/.test(effectiveModel)) cmd += ` --model "${effectiveModel}"`;
  // effort is a launch flag for the same reason model is: a typed `/effort
  // <level>` saves as the user's default for new sessions (CLI 2.1.x), so one
  // low-effort task would bleed into every agent started afterward. The flag
  // only knows the five named levels — ultracode/auto still go in typed.
  if (!orSlug && effort && EFFORT_FLAGS.includes(effort)) cmd += ' --effort ' + effort;
  // roles are a launch flag rather than a typed first message: --append-system-prompt
  // costs no turn and cannot collide with the task board's own prompt injection.
  // The texts are ours and contain no shell metacharacters — that is what
  // makes them safe inside the single-quoted tmux command (see _launch).
  if (preset && preset.prompt) cmd += ` --append-system-prompt "${preset.prompt}"`;
  return cmd;
}

class PtyManager {
  constructor({ maxSessions, onData, onExit, debugLog, decorateCmd, turnsOf }) {
    this.maxSessions = maxSessions;
    this.onData = onData;
    this.onExit = onExit;
    this.debugLog = debugLog;
    this.decorateCmd = decorateCmd; // wraps the claude command (hook env/flags)
    this.turnsOf = typeof turnsOf === 'function' ? turnsOf : () => 0;
    this.sessions = new Map(); // id -> { proc, session }
    this.counter = 0;
    this.tmuxOk = false;
    this.shellOk = false; // did the init probe's shell answer at all?
    this.probeFailed = false; // last attachExisting couldn't reach tmux — its [] is not ground truth
    this.shuttingDown = false;
    this.replacing = new Set(); // ids killed by restart() — their exit must not orphan a task
    this.keeperUp = false; // Windows: is the WSL keeper client running (see _ensureKeeper)
  }

  /* Windows only. WSL powers the distro down once its last *client* exits —
   * `systemd-poweroff` shows up in the WSL journal seconds after SwarmEye
   * closes — and that takes the tmux server, and with it every agent, no
   * matter that the agents are still running inside. A process inside WSL
   * does not hold the distro open; only a Windows-side client does.
   *
   * So one client is left behind that outlives the app: it wakes every 30s,
   * and the first time tmux has no sessions left to keep alive, it exits and
   * lets WSL shut down as it always did. Nothing is kept alive for an agent
   * that isn't there.
   *
   * Started at most once per app run, and the lock in KEEPER_CMD makes the
   * keeper of a *previous* run the only one — cheaper and more reliable than
   * probing `ps` for one, which any agent whose own command line mentions the
   * keeper (an agent working on this file, say) would answer wrongly. */
  _ensureKeeper() {
    if (!IS_WIN || !this.tmuxOk || this.keeperUp) return;
    this.keeperUp = true;
    try {
      spawnDetachedShell(KEEPER_CMD);
      this.debugLog('[ptys] WSL keeper started');
    } catch (err) {
      this.keeperUp = false; // let the next launch try again
      this.debugLog(`[ptys] WSL keeper failed: ${err.message}`);
    }
  }

  /* Every exec here is a shell spawn — a `wsl.exe` one on Windows, which costs
   * a few hundred ms each — and this runs on the boot path before any agent
   * can be reattached, so both halves are one round trip rather than seven:
   * presence and version together, then the whole config in a single script. */
  async init() {
    // `echo probe` separates "shell unreachable" (exec null — cold WSL, timeout)
    // from "shell fine, tmux missing" (probe echoed, no version line): the two
    // must not be conflated, or a slow boot reads as a no-tmux install and every
    // consumer treats the surviving agents as gone.
    // the harness probe rides along rather than costing a second spawn (its
    // answers are digit-free, so the version match below still reads tmux's)
    const ver = await exec('echo probe; command -v tmux >/dev/null && tmux -V; true; ' + providers.TOOL_PROBE);
    this.shellOk = !!(ver && ver.includes('probe'));
    providers.setTools(this.shellOk ? ver : null);
    const m = /(\d+)\.(\d+)/.exec(ver || '');
    this.tmuxOk = !!m;
    if (this.tmuxOk) {
      const hyperlinksOk = !!m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 4));
      const extKeysOk = +m[1] > 3 || (+m[1] === 3 && +m[2] >= 2);
      const lines = CONF_LINES
        .concat(extKeysOk ? [EXTENDED_KEYS_LINE, EXIT_EMPTY_LINE] : [])
        .concat(hyperlinksOk ? HYPERLINKS_LINE : []);
      const conf = lines.map((l) => `'${l}'`).join(' ');
      // the conf only applies at server start, and the server outlives the
      // app (that's the point) — apply to an already-running one too, once.
      // The wheel lines are plain sets and binds, so re-applying is a no-op.
      const script = [
        `mkdir -p ~/.config/swarmeye && printf '%s\\n' ${conf} > ${TMUX_CONF}`,
        ...WHEEL_LINES.map((line) => `${TMUX} ${line} 2>/dev/null; true`),
      ];
      // same reason as the wheel lines above: the conf is only read when the
      // server starts, and the server outlives the app
      if (extKeysOk) script.push(`${TMUX} ${EXTENDED_KEYS_LINE} 2>/dev/null; true`);
      if (hyperlinksOk) {
        script.push(`${TMUX} show -s terminal-features 2>/dev/null | grep -q hyperlinks`
          + ` || ${TMUX} set -as terminal-features "*:hyperlinks" 2>/dev/null; true`);
      }
      await exec(script.join('; '));
    }
    this.debugLog('[ptys] tmux ' + (this.tmuxOk ? 'available'
      : this.shellOk ? 'MISSING — sessions will not survive restarts'
        : 'probe UNANSWERED — shell unreachable, keeping session metadata'));
    return this.tmuxOk;
  }

  /* Reattach to tmux sessions that survived the last app run. */
  async attachExisting() {
    const cfg = config.load();
    const known = cfg.sessions || {};
    // "tmux didn't answer" is not "the agents are gone": exec() resolves null
    // identically for a missing tmux, a timeout and an unreachable shell, and a
    // cold WSL boot hits the latter two. Keep the metadata — the dead[] pass
    // below prunes it once tmux actually answers. probeFailed tells session:list
    // that this [] is "couldn't tell", so usage pruning and the renderer's
    // orphan-task recovery don't treat it as ground truth.
    if (!this.tmuxOk) {
      this.probeFailed = !this.shellOk;
      return [];
    }
    // `; true` pins the exit code, so null here can only mean the shell itself
    // never answered — same class of failure as the init probe above.
    const out = await exec(`${TMUX} list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null; true`);
    if (out == null) {
      this.probeFailed = true;
      this.debugLog('[ptys] list-sessions unanswered — keeping session metadata');
      return [];
    }
    this.probeFailed = false;
    const alive = new Set();
    // A session someone is already attached to belongs to another live
    // SwarmEye (a dev instance on its own --user-data-dir, so its config knows
    // nothing of these agents). The orphan reap below must leave those alone.
    const attached = new Set();
    for (const line of out.split('\n')) {
      const [name, clients] = line.trim().split(' ');
      if (!name) continue;
      alive.add(name);
      if (clients && clients !== '0') attached.add(name);
    }
    const restored = [];
    const dead = [];
    const reap = []; // tmux sessions to kill: never-used agents, then orphans
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
        // An agent that never got a prompt has nothing to come back to, and a
        // restart used to refill the grid with those blank panes. Reap it
        // instead. Both signals are already persisted: lastCommand is written
        // when a prompt is sent, turns when one completes — either alone
        // misses an agent killed mid-first-turn.
        if (!meta.lastCommand && !this.turnsOf(meta.id)) {
          reap.push(meta.tmuxName);
          dead.push(meta.id);
          continue;
        }
        // pty.spawn throws synchronously (deleted workspace folder, say) — one
        // bad session must not brick the whole boot, and its tmux session is
        // still alive, so keep the metadata and just skip the pane
        try {
          restored.push(this._launch(meta, 100, 30, null));
          this.counter = Math.max(this.counter, meta.num || 0);
        } catch (err) {
          this.debugLog(`[ptys] reattach launch failed ${meta.id}: ${err.message}`);
        }
      } else {
        dead.push(meta.id);
      }
    }
    // A tmux session no metadata points at can never be shown again — it is a
    // leaked agent, holding a workspace and (on Windows) a WSL process for as
    // long as the machine is up. Reap those too. `known` is the pre-prune
    // snapshot on purpose: sessions dropped just now for exceeding the cap
    // keep running this round and are only reaped on a later boot.
    const knownNames = new Set(Object.values(known).map((m) => m.tmuxName));
    for (const name of alive) {
      if (name.startsWith('swarmeye_') && !knownNames.has(name) && !attached.has(name)) reap.push(name);
    }
    if (reap.length) {
      await exec(`${reap.map((n) => `${TMUX} kill-session -t '=${n}' 2>/dev/null`).join('; ')}; true`);
      this.debugLog(`[ptys] reaped ${reap.length} unused/orphaned tmux session(s)`);
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

  /* The name an agent is about to get. */
  pickAgentName() {
    return pickName(this.namesInUse());
  }

  /* opts.scope = a folder inside cwd this agent may edit and nothing else
   * (main/scope.js). opts.worktree = the tree main/worktree.js cut for this
   * agent, which is where it runs instead of the workspace itself — created by
   * the caller, since making one is a shell round trip and this is sync. */
  spawn(workspace, cols, rows, opts = {}) {
    if (this.sessions.size >= this.maxSessions) throw new Error('cap');
    const cwd = (opts.worktree && opts.worktree.path) || workspace.path;
    // a moved/renamed/unmounted workspace folder makes posix_spawn fail on
    // chdir with the same opaque "posix_spawnp failed" — catch it here with
    // a message that actually says what's wrong
    if (!fs.existsSync(cwd)) throw new Error('workspace folder not found: ' + cwd);
    this.counter += 1;
    const id = 's_' + Math.random().toString(36).slice(2, 10);
    const meta = {
      id,
      num: this.counter,
      agentName: opts.agentName || this.pickAgentName(),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd,
      tmuxName: 'swarmeye_' + id,
      createdAt: Date.now(),
    };
    // persisted so a pane rebuilt from tmux after a restart still shows its
    // role chip — the flag itself is long gone by then, it lives in the process
    if (roles.has(opts.role)) meta.role = opts.role;
    // the pane labels its own branch from this, and the registry in
    // config.json (not this copy) is what survives the agent to be landed
    if (opts.worktree) meta.worktree = opts.worktree;
    // persisted for the same reason as the role: the deny rules live in the
    // launch, so a restart has to rebuild them rather than inherit them
    const denyEdit = scopeDeny(cwd, opts.scope);
    if (opts.scope) meta.scope = opts.scope;
    // the model this agent was launched with — Claude tier or 'or:<slug>' —
    // so the pane can label it from its first frame instead of waiting for
    // the first turn's transcript read, and a restart comes back on it (an
    // OpenRouter pick also needs it to rebuild the env prefix). Same
    // resolution as claudeBase: an explicit pick, else the role's default.
    const launchModel = opts.model || (roles.get(opts.role) || {}).model;
    if (launchModel) meta.model = launchModel;
    return this._launch(meta, cols, rows,
      // a foreign harness (opencode/pi) keeps the hook env but not the
      // --settings flag it would refuse to start with. Resolved the way
      // claudeBase resolves it: an explicit pick, else the role's default.
      this.decorateCmd(id, claudeBase(opts),
      { settings: !providers.isForeign(opts.model || (roles.get(opts.role) || {}).model), denyEdit }));
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
  async restart({ workspaceId, workspaceName, agentName, cwd, cols, rows, resume, role, model, continueFrom, resumeId, orSkills, replaceId, scope: scopeRel, worktree }) {
    if (!fs.existsSync(cwd)) throw new Error('workspace folder not found: ' + cwd);
    // rebuilt against the tree as it is now, and before the kill below: a
    // scope whose folder went away must refuse the restart while the old
    // agent is still there to keep, not after it has been killed
    const denyEdit = scopeDeny(cwd, scopeRel);
    // a live ↻ must free the old tmux session (and its cap slot) before the
    // new id launches — otherwise the agent keeps running, maxSessions still
    // counts it, and the next boot remounts a duplicate. Exited-pane ↻ has
    // nothing in this.sessions. Detached-reattach never calls restart().
    if (replaceId && this.sessions.has(replaceId)) {
      this.replacing.add(replaceId);
      try {
        await this.kill(replaceId);
      } catch (err) {
        this.replacing.delete(replaceId);
        throw err;
      }
      this.sessions.delete(replaceId);
    }
    // a clean agent (oc:) resumes from its own persisted conversation, named
    // by the previous session's id — main.js only passes continueFrom when
    // that file really exists. hasHistory only knows claude's transcripts.
    const clean = !!providers.cleanSlugOf(model || (roles.get(role) || {}).model);
    // opencode and pi resume by their *own* conversation id, which their
    // adapter recorded — main.js passes it as resumeId, and only its presence
    // makes this a resume. They never take claude's `--continue`, a flag both
    // of them refuse to start with.
    const foreign = providers.isForeign(model || (roles.get(role) || {}).model);
    const resumed = resume
      ? (foreign ? !!resumeId : clean ? !!continueFrom : await this.hasHistory(cwd))
      : false;
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
    if (roles.has(role)) meta.role = role;
    // and inside the same folder it was scoped to
    if (scopeRel) meta.scope = scopeRel;
    // ↻ stays in the tree the conversation was held in: the transcript a
    // resume continues is keyed by cwd (claudeProjectDirName), and the work in
    // progress is in there
    if (worktree) meta.worktree = worktree;
    // `model` is how a restart moves the agent to another tier (the pane's
    // right-sizing offer); the pane hands back what it was launched with
    // otherwise. Left undefined it is the role's model, or the account
    // default — i.e. exactly what a plain restart did before.
    const launchModel = model || (roles.get(role) || {}).model;
    if (launchModel) meta.model = launchModel;
    // a foreign harness's resume is built into its command (env + its own
    // --session), not appended after it, so claudeBase takes the two ids
    const base = claudeBase({ role, model, orSkills,
      continueFrom: resumed && foreign ? continueFrom : undefined,
      resumeId: resumed && foreign ? resumeId : undefined });
    const cmd = this.decorateCmd(id, !resumed || foreign ? base
      : clean ? base + providers.cleanContinueArg(continueFrom)
        : base + ' --continue',
    { settings: !foreign, denyEdit });
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
    const out = await exec(`${TMUX} has-session -t '=${meta.tmuxName}' 2>/dev/null && echo alive; true`);
    // null = the shell never answered (WSL hiccup) — the agent may be fine, so
    // the metadata must survive for a retry; only a real "no such session"
    // answer drops it (the same distinction _handleExit makes).
    if (out == null) throw new Error('tmux unreachable — try again');
    if (!out.includes('alive')) {
      this._dropMeta(id);
      throw new Error('gone');
    }
    // the only launch path that had no cap check — a pane reattached by hand
    // counts against maxSessions exactly like a spawn() or a restart()
    if (this.sessions.size >= this.maxSessions) throw new Error('cap');
    return this._launch(meta, cols, rows, null);
  }

  /* Spawn the pty in the workspace directory. A null `cmd` means "reattach to a
   * session that is already running" — that attaches and nothing else, since
   * new-session -A would silently *create* a bare `claude` (no hook settings,
   * no --model, no role prompt) for a session that died since the probe. */
  _launch(meta, cols, rows, cmd) {
    cols = toDim(cols, 100, 500);
    rows = toDim(rows, 30, 300);
    // An OpenRouter agent needs its key in the environment, and the one place
    // it must never be is a command line: tmux republishes the launch command
    // verbatim as #{pane_start_command}, and `ps -eo args` shows every argv on
    // the box to every process running as this user — which is how an agent
    // running the `ps` check this repo's own CLAUDE.md asks for would print
    // the key into its pane, its scrollback and its transcript.
    //
    // So the value only ever travels as an environment variable — node-pty
    // hands it to this pty's shell below — and `new-session -e` (tmux >= 3.2)
    // puts it on the session over the socket. Three details, each checked by
    // launching a session and grepping `ps -eo args` for the key:
    //   - `$NAME` is expanded by that shell, so the script string, which bash
    //     and wsl.exe keep in argv for the life of the pane, names it only;
    //   - the session is created detached and attached as a second step: a
    //     client that stays attached keeps its expanded argv just as long;
    //   - the server is started first by a process the key is stripped from,
    //     since tmux daemonizes keeping the argv *and environment* of whoever
    //     started it — a keyed client would publish the key in `ps` for the
    //     server's whole life and hand it to every session created after,
    //     plain Claude ones included. exit-empty keeps that server up.
    // The quotes and `$` are the shell's and sit outside the single quotes
    // wrapping `cmd`, so the no-metacharacters rule inside those is untouched:
    // this is our own literal variable name, never data.
    //
    // On Windows the dollar is escaped: wsl.exe joins the argv it is given
    // into one string and runs it through `/bin/bash -c`, so that wrapper
    // expands `$NAME` *before* the login shell inside it starts — against an
    // environment the `env NAME=value` prefix has not reached yet. tmux then
    // got an empty key, and every bare-harness agent died on its own "key is
    // not set" line, in a session tmux tore down before the message could be
    // drawn. Escaping leaves the expansion to the shell that has the value.
    const keyVar = cmd ? providers.keyEnv(meta.model) : null;
    const keyRef = IS_WIN ? '\\$' : '$';
    // SwarmEye may itself have been launched from a Claude Code session, and
    // that parent stamps CLAUDE_CODE_CHILD_SESSION on everything below it. An
    // agent claude reading that marker calls itself a nested child and stops
    // writing its transcript — so the pane loses its history and every panel
    // that reads ~/.claude/projects goes blank. The marker is stripped from
    // the pty's environment below; tmux, which takes a new session's
    // environment from the server rather than from this client, gets the
    // documented override on the socket instead.
    const PERSIST = 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1';
    const attach = `exec ${TMUX} attach-session -t '=${meta.tmuxName}'`;
    const script = this.tmuxOk
      ? (cmd
        ? (keyVar
          ? `env -u ${keyVar.name} ${TMUX} start-server 2>/dev/null; `
            + `${TMUX} new-session -Ad -s ${meta.tmuxName} -x ${cols} -y ${rows}`
            + ` -e ${PERSIST} -e ${keyVar.name}="${keyRef}${keyVar.name}" '${cmd}'; ${attach}`
          : `exec ${TMUX} new-session -A -s ${meta.tmuxName} -x ${cols} -y ${rows} -e ${PERSIST} '${cmd}'`)
        : attach)
      : `exec ${cmd || 'claude'}`;
    // Windows reaches the agent through WSL, which takes the working
    // directory as a flag rather than a spawn option; macOS spawns the login
    // shell directly. A login shell either way, so ~/.local/bin is on PATH
    // and the tmux server inherits that environment.
    //
    // The key rides that shell's environment: a spawn option on macOS, and on
    // Windows an `env` prefix inside WSL, since nothing crosses the wsl.exe
    // boundary by inheritance. `env` execs bash in place, so the argv the
    // pane's own `ps` can see never holds the value either.
    const { CLAUDE_CODE_CHILD_SESSION: _inherited, ...parentEnv } = process.env;
    const env = { ...parentEnv, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };
    const [file, args, extra] = IS_WIN
      ? ['wsl.exe', ['--cd', meta.cwd, '--',
        'env', '-u', 'CLAUDE_CODE_CHILD_SESSION', PERSIST,
        ...(keyVar ? [`${keyVar.name}=${keyVar.value}`] : []),
        'bash', '-lc', script], { useConpty: true }]
      : [SHELL, ['-lc', script], {
        cwd: meta.cwd,
        env: keyVar ? { ...env, [keyVar.name]: keyVar.value } : env,
      }];

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      ...extra,
    });

    const session = { ...meta, persistent: this.tmuxOk };
    this.sessions.set(meta.id, { proc, session });
    this._saveMeta(meta);
    this._ensureKeeper(); // every launch path lands here, reattach included

    proc.onData((data) => this.onData(meta.id, data));
    proc.onExit(({ exitCode }) => this._handleExit(meta, exitCode));

    return session;
  }

  async _handleExit(meta, exitCode) {
    this.sessions.delete(meta.id);
    // the keeper ends itself once the last agent is gone, so the next launch
    // has to be allowed to start a new one
    if (!this.sessions.size) this.keeperUp = false;
    if (this.shuttingDown) return; // quitting: client detached, agent lives on
    // restart() already killed this id and is about to mint a replacement —
    // a real-exit event would mark the pane exited and orphan its task
    if (this.replacing.delete(meta.id)) return;
    let detached = false;
    if (this.tmuxOk) {
      // claude gone => tmux session gone => real exit. Session still alive
      // means the client merely detached; keep metadata so a reattach works.
      // An unanswered probe (shell hiccup) also keeps the metadata.
      const out = await exec(`echo probe; ${TMUX} has-session -t '=${meta.tmuxName}' 2>/dev/null && echo alive; true`);
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
    // capped like every other user string that lands in config.json — a pasted
    // wall of text would be re-serialised on every subsequent write
    cmd = String(cmd || '').slice(0, 200);
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
    // Metadata is dropped only after the kill is confirmed delivered — `echo
    // done` proves the shell ran; a null (WSL down, timeout) means the agent is
    // still alive in tmux, so keep the metadata and report failure rather than
    // orphaning a running agent with no reattach path.
    if (this.tmuxOk && meta && meta.tmuxName) {
      const out = await exec(`${TMUX} kill-session -t '=${meta.tmuxName}' 2>/dev/null; echo done; true`);
      if (out == null || !out.includes('done')) throw new Error('tmux unreachable — agent not killed');
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

module.exports = { PtyManager, claudeProjectDirName, TMUX, MODELS, EFFORT_FLAGS };
