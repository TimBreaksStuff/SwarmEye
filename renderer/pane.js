/* Pane: one terminal card (DOM + xterm + addons). Exposes window.Pane. */

/* terminal palettes matching the app themes in tokens.css.
 *
 * The two dark themes (dark/orange) are one house ANSI ramp re-tinted: each
 * spreads ANSI_RAMP and then overrides only the hues that carry its identity.
 * Every field below a `...ANSI_RAMP` is therefore a deliberate difference from
 * the house ramp, not an incidental copy. The light themes share LIGHT_RAMP, a
 * complete ramp of their own, and differ only in cursor and selection. */
const ANSI_RAMP = {
  red: '#ff5a5a',
  green: '#a3e635',
  yellow: '#f5b544',
  blue: '#58a6ff',
  magenta: '#a78bfa',
  cyan: '#6cd9d0',
  brightRed: '#ff7a7a',
  brightGreen: '#d6ff4b',
  brightYellow: '#ffd27d',
  brightBlue: '#83bcff',
  brightMagenta: '#c4b0ff',
  brightCyan: '#93ece4',
};

/* the light page's complete ramp, shared by `light` and its accent variants */
const LIGHT_RAMP = {
  background: '#ffffff',
  foreground: '#1b1e23',
  cursor: '#3f6212',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(71, 109, 10, 0.25)',
  black: '#1b1e23',
  red: '#d92f2f',
  green: '#4d7c0f',
  yellow: '#c07c00',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  white: '#e5e7eb',
  brightBlack: '#70767f',
  brightRed: '#ef4444',
  brightGreen: '#65a30d',
  brightYellow: '#d97706',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#0891b2',
  brightWhite: '#f9fafb',
};

const XTERM_THEMES = {
  dark: {
    background: '#0c0e11',
    foreground: '#e8eaed',
    cursor: '#d6ff4b',
    cursorAccent: '#0a0b0d',
    selectionBackground: 'rgba(214, 255, 75, 0.25)',
    black: '#0a0b0d',
    white: '#e8eaed',
    brightBlack: '#5b616b',
    brightWhite: '#ffffff',
    ...ANSI_RAMP,
  },
  light: LIGHT_RAMP,
  /* the three accent variants of `light` — same page, same ramp, only the
   * cursor and selection follow the accent */
  blue: {
    ...LIGHT_RAMP,
    cursor: '#1e40af',
    selectionBackground: 'rgba(29, 78, 216, 0.25)',
  },
  neoblue: {
    ...LIGHT_RAMP,
    cursor: '#0043c7',
    selectionBackground: 'rgba(0, 87, 255, 0.25)',
  },
  purple: {
    ...LIGHT_RAMP,
    cursor: '#5b21b6',
    selectionBackground: 'rgba(109, 40, 217, 0.25)',
  },
  orange: {
    background: '#0f0c09',
    foreground: '#ede9e3',
    cursor: '#ff9d2e',
    cursorAccent: '#0d0b08',
    selectionBackground: 'rgba(255, 157, 46, 0.25)',
    black: '#0d0b08',
    white: '#ede9e3',
    brightBlack: '#6a6157',
    brightWhite: '#ffffff',
    ...ANSI_RAMP,
    yellow: '#ffb04d',
    brightGreen: '#c8f55e',
    brightYellow: '#ffc879',
  },
};
/* the canvas is transparent so the pane's glass (blur + tint, see .pane /
 * .pane-term in app.css) shows through behind the text — the per-theme
 * terminal tint comes from the CSS var(--term-bg) mix, not the palette.
 * The RGB channels still carry the backdrop the pane will actually show:
 * nothing is painted with them at zero alpha, but xterm measures their
 * luminance for the contrast pass below, and rgba(0,0,0,0) would have every
 * light theme's terminal believe it is drawing onto black. */
function glassTheme(palette, bgHex = palette.background) {
  const [r, g, b] = hexRgb(bgHex);
  return { ...palette, background: `rgba(${r}, ${g}, ${b}, 0)` };
}

/* ---- readability pass for the light-background themes ----
 *
 * Two problems the palettes above cannot fix on their own, both only hitting
 * the themes whose panes are near-white:
 *
 *  - agents assume a dark terminal. Claude Code's TUI paints its text in
 *    whites and pale greys, and sends most of them as *256-colour indices*
 *    (TERM=xterm-256color, so chalk drops to the fixed 16–255 table) — colours
 *    no palette entry covers, and invisible on a white pane.
 *  - with "Theme background overlay" off, app.css pins every pane dark, so
 *    those same themes would draw their near-black text on black.
 *
 * xterm's own `minimumContrastRatio` does exactly this job, and does it per
 * *cell*: it lightens or darkens the foreground until it reads against the
 * background that cell is really drawn on. Rewriting the palette instead
 * cannot, because the same entry serves as text one moment and as a filled
 * backdrop the next — darkening it for a white pane turned every grey/black
 * block the TUI paints (input box, selected row, diff gutter) into near-black
 * *with near-black text on it*. Hence the option, not a palette rewrite. */
/* must match the overlay-off selector list in app.css */
const LIGHT_THEMES = new Set(['light', 'blue', 'neoblue', 'purple']);
/* What .pane-term resolves to for it — term-bg at 45% over the pane's 55%
 * surface over --bg (see app.css). xterm needs the real backdrop to measure
 * against, not the palette's nominal `background`, which the CSS covers up. */
const LIGHT_PANE_BG = {
  light: '#f8f9fb',
  blue: '#f8f9fb',
  neoblue: '#f8f9fb',
  purple: '#f8f9fb',
};
/* and what app.css pins that same stack to while the overlay is off */
const FLAT_PANE_BG = '#0b0d10';

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// WCAG AA for text. Left at 1 (xterm's "off") for the dark themes, whose
// panes are the backdrop agents already assume.
const MIN_CONTRAST = 4.5;

let activeXtermTheme = glassTheme(XTERM_THEMES.dark);
let activeMinContrast = 1;

// ↻ says something different depending on whether the agent is still running:
// on a live one it throws away a session, so it asks for a second click first
const LIVE_RESTART_TIP = 'Restart this agent — click twice to confirm. Continues the last conversation (shift-click: fresh session)';
const DEAD_RESTART_TIP = 'Restart & continue last conversation (shift-click: fresh session)';

const DEFAULT_FONT_SIZE = 13;
// last font size the user picked (MOD+/- or the pane buttons) — persists
// across restarts so reopened agent panes come back at the same text size
let activeFontSize = Number(localStorage.getItem('swarmeye.paneFontSize')) || DEFAULT_FONT_SIZE;

// Windows starts a step heavier: DirectWrite rasterizes stems lighter than
// macOS's Skia/CoreText, so the same 400 that looks right on a Mac reads thin
// and washed out there. Still just a default — the Options knob overrides it.
const DEFAULT_FONT_WEIGHT = window.swarm.isMac ? 400 : 500;
// "Agent pane text weight" option in ⌨ Options — the light themes draw dark
// text on a near-white pane, which reads thinner than the dark themes'
// light-on-dark, so the weight is a knob rather than a constant. Capped at 600
// (JetBrains Mono is a 300–700 variable font) so bold, which tracks 300 above,
// stays heavier than body text at every step — 400 gives xterm's own 700.
let activeFontWeight = Number(localStorage.getItem('swarmeye.paneFontWeight')) || DEFAULT_FONT_WEIGHT;
const boldFor = (weight) => Math.min(700, weight + 300);

// "Show last command in pane header" option in ⌨ Options — off by default;
// app.js owns persistence, this just gates whether syncInitialCommandHeader
// reveals the row it fills in on every pane
let showInitialCommand = false;

// "Auto-organize agent windows" option in ⌨ Options — on by default; when off,
// the → / ↓ split buttons are how the user places new agents themselves, so
// they only make sense to show while auto-organize is off
let autoOrganize = true;

// "Default agent permissions: auto" option in ⌨ Options — mirrored here by
// app.js, which owns it, rather than read back over IPC: autoAcceptDialogs is
// the only consumer and it used to pull the whole config across the boundary
// to answer one boolean
let skipPermissions = false;

// "Fixed agent pane buttons" option in ⌨ Options — off by default, which folds
// the five rarely-used header buttons behind the ⋯ tray; on keeps every button
// inline the way it used to be
let fixedActions = false;

// every header glyph is drawn the same way — one stroke weight, one grid, so a
// pane header reads as one row of icons rather than mono arrows beside SVGs
const icon = (paths) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';

/* ---- cost & context panel ---- */

// "Show cost & context panel" option in ⌨ Options — off by default, since the
// panel costs every pane two rows of terminal height
let showUsagePanel = false;
// newest 5-hour usage window ({usedPct, resetsAt}), pushed by app.js — the
// denominator for each agent's share of the quota
let usageWindow = null;
// every pane currently alive, so one pane's share can be measured against
// what the whole swarm burned in the same window
const livePanes = new Set();

// Claude Code compacts against a 200k window; a session that ever reports a
// bigger prompt than that is plainly running on the 1M one, so the meter
// re-scales itself instead of guessing per model id.
const CONTEXT_WINDOW = 200000;
const CONTEXT_WINDOW_LARGE = 1000000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SPARK_CHARS = '▁▂▃▄▅▆▇█';
const TOOL_TRAIL_MAX = 3;

/* How long the "another agent is in this file" chip stays up after the last
 * shared write, re-armed by each new one. Shorter than the window main uses to
 * decide what counts as shared (hooks.js COLLISION_WINDOW_MS): that one has to
 * span an agent that reads for a while between edits, this one only has to
 * outlast the gap between two agents actively working the same file. */
const COLLISION_SHOW_MS = 10 * 60 * 1000;

/* ---- right-sizing the model ----
 *
 * Tools that only look. An agent that has made this many calls in a row
 * without touching a file is reading, and reading is work a cheaper tier does
 * about as well — the first rule in CLAUDE.md's cost list, which the app has
 * so far only documented. Bash is deliberately absent: it can do anything,
 * including write, so it ends a streak rather than extending it.
 *
 * The streak, not the turn count, is the signal: it resets the moment the
 * agent edits something, so an agent that reads for a while and then starts
 * building never gets the offer. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch']);
const RIGHTSIZE_MIN_CALLS = 12;

/* Roles that are Opus *because* they read and judge — a Reviewer or a Planner
 * doing nothing but reading is the job being done right, not a tier to save
 * on, so the streak says nothing about them. */
const RIGHTSIZE_SKIP_ROLES = new Set(['reviewer', 'planner']);

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

function fmtCost(n) {
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(n >= 100 ? 0 : 2);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

/* One block character per turn, scaled to the biggest turn in the window —
 * a burn chart that costs nothing to draw and rescales with the font. */
function sparkline(series) {
  if (!series || !series.length) return '';
  const peak = Math.max(...series.map((p) => p.tokens));
  if (!peak) return '';
  return series
    .slice(-24)
    .map((p) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.round((p.tokens / peak) * (SPARK_CHARS.length - 1)))])
    .join('');
}
const IDLE_AFTER_MS = 2500;
// output arriving this soon after a keystroke/mouse report is its echo, not
// the agent working — typing or clicking must not light the busy indicator
const INPUT_ECHO_MS = 400;

// Saying this at the end of a dictated phrase submits it: the phrase itself is
// stripped, dictation stops and Enter is pressed. Trailing punctuation is
// allowed because whisper ends most utterances with a full stop.
const DICTATE_SUBMIT = /[\s,]*\bsend it\b[\s.!?,]*$/i;
// gap before Enter so it lands as its own keystroke rather than part of the
// pasted chunk — the same reason tryInjectPrompt (app.js) splits its writes
const DICTATE_SUBMIT_DELAY_MS = 150;

/* Claude permission modes. There is no "set mode" API for a running claude —
 * the only control is Shift+Tab cycling — so we read the current mode from
 * the footer it draws above the input box and step the cycle until it shows
 * the one the user picked. */
const MODES = [
  ['default', 'manual'],
  ['acceptEdits', 'accept edits'],
  ['plan', 'plan'],
  ['bypass', 'auto'],
];
const MODE_MARKERS = [
  ['bypass', /bypass(?:ing)? permissions/i],
  ['plan', /plan mode on/i],
  ['acceptEdits', /accept edits on/i],
];

/* Dialogs that stall a session waiting for a human even with auto mode on, as
 * [one-shot pane flag, buffer marker] — see Pane.autoAcceptDialogs.
 *
 * trust: the first-run "Do you trust the files in this folder?" boundary,
 *   which --dangerously-skip-permissions does NOT suppress; claude
 *   pre-highlights "1. Yes, proceed".
 * bypass: the machine-local, one-time-ever "WARNING: Claude Code running in
 *   Bypass Permissions mode" notice, shown the first time a user ever enters
 *   bypass mode on this machine and remembered afterwards; "Yes, I accept" is
 *   pre-highlighted. Without this, opting into auto mode stalls the agent on
 *   exactly the human approval the user asked to skip. */
const AUTO_ACCEPT_DIALOGS = [
  ['trustDialogHandled', /do you trust the files in this folder/i],
  ['bypassDialogHandled', /running in Bypass Permissions mode/i],
];
/* Claude models selectable for a task — sent as a `/model <value>` command
 * once the agent starts, same mechanism a user typing it themselves uses. */
const MODELS = [
  ['default', 'default'],
  ['sonnet', 'Sonnet'],
  ['opus', 'Opus'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
];

/* Claude reasoning effort levels selectable for a task — sent as a
 * `/effort <value>` command once the agent starts, same mechanism as MODELS. */
const EFFORTS = [
  ['default', 'default'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
  ['ultracode', 'ultracode'],
  ['auto', 'auto'],
];
const SHIFT_TAB = '\x1b[Z';
const MODE_STEP_MS = 300; // redraw grace between Shift+Tab presses
const CLOSE_ARM_MS = 5000;
// rows of `git diff --stat` the git chip's popover shows before eliding the
// middle (git's own "N files changed" summary line is always kept)
const DIFF_STAT_MAX_LINES = 14;

// matches a menu line like "  1. Yes" or "❯ 2. No" — group 1 is the leading
// whitespace/cursor marker (excluded from the clickable range), group 2 the digit
const MENU_OPTION_RE = /^(\s*(?:[❯›>*]\s*)?)(\d{1,3})\.\s+\S.*$/;
// a work burst at least this long that then goes quiet = "agent finished"
const FINISHED_MIN_WORK_MS = 5000;

/* Dropped files arrive with host-OS paths. Agents run in WSL on Windows, so
 * drive letters and \\wsl$ UNCs are rewritten to their WSL form; POSIX paths
 * (macOS port) pass through untouched. */
function agentPath(p) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) return '/mnt/' + drive[1].toLowerCase() + '/' + drive[2].replace(/\\/g, '/');
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)$/.exec(p);
  if (unc) return unc[1].replace(/\\/g, '/');
  return p;
}

/* "claude-opus-4-8" -> "Opus 4.8", "claude-3-5-sonnet-20241022" -> "Sonnet
 * 3.5". Best-effort: drops the claude- prefix and any trailing date stamp,
 * then puts the family name first and joins version numbers with a dot —
 * covers both the new (name-first) and legacy (numbers-first) id shapes. */
function prettyModelName(id) {
  if (!id || typeof id !== 'string') return null;
  const tokens = id.replace(/^claude-/, '').split('-')
    .filter((t) => t && !/^\d{8}$/.test(t) && t !== 'latest');
  if (!tokens.length) return id;
  const words = tokens.filter((t) => /[a-z]/i.test(t));
  const nums = tokens.filter((t) => /^\d+$/.test(t));
  if (!words.length) return tokens.join(' ');
  const family = words[words.length - 1]; // legacy ids put numbers before the family name
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  return nums.length ? `${label} ${nums.join('.')}` : label;
}

class Pane {
  /**
   * @param {object} session {id, num, agentName, workspaceName, cwd, persistent, lastCommand}
   * @param {object} handlers {onClose, onMaximize, onResize, onRename,
   *                           onRestart, onFocus, onStatusChange,
   *                           onShortcut, onSplit, setLastCommand}
   * @param {object} [opts] {managed} — managed is true when a board task
   *                         started this agent; false for a manually-added one
   */
  constructor(session, handlers, opts = {}) {
    this.session = session;
    this.handlers = handlers;
    this.managed = !!opts.managed;
    this.exited = false;
    this.detached = false;
    this.exitCode = null;
    this.attention = false;
    this.working = false;
    this.trustDialogHandled = false; // one-shot: auto-accept the folder-trust dialog at most once per session
    this.bypassDialogHandled = false; // one-shot: auto-accept the bypass-permissions warning at most once per session
    this.hookAlive = false; // true once Claude Code hook events flow — they replace the output-timing heuristics
    this.awaitingPrompt = false; // true while the agent is blocked on the user (Notification hook, cleared on the next turn)
    this.promptAnswerable = false; // true while a numbered yes/no menu is actually on screen — with awaitingPrompt, gates the ✓/✕ quick-respond buttons
    this.statusText = ''; // what the hooks say the agent is doing right now (tool name / 'vibing...' / 'done'), mirrored for the swarm view
    this.lastInputAt = 0; // last keystroke/mouse report — its echo must not read as agent activity
    this.idleTimer = null;
    this.closeArmTimer = null;
    this.bufferTextCache = null; // memoized getBufferText result

    // cost & context panel state — usage arrives per turn from the hooks'
    // transcript read (UsageUpdate); the rest is derived from hook events.
    // A reattached session brings its totals back with it, so the panel is
    // populated before this agent's next turn ever runs.
    this.usage = session.usage || null;
    this.toolTrail = [];
    this.turnStartedAt = 0; // when the agent started working, 0 while it isn't
    this.waitingSince = 0; // when it started waiting on the user, 0 while it isn't
    this.usageTimer = null; // 1s tick, only while the panel is visible
    livePanes.add(this);

    this.el = document.createElement('section');
    this.el.className = 'pane';
    this.el.dataset.sessionId = session.id;

    const header = document.createElement('div');
    header.className = 'pane-header';

    this.dot = document.createElement('span');
    this.dot.className = 'pane-dot idle';

    this.taskEl = document.createElement('span');
    this.taskEl.className = 'pane-task';
    this.taskEl.textContent = 'task';
    this.taskEl.dataset.tip = 'Started by a board task';
    this.taskEl.style.display = this.managed ? '' : 'none';

    // role preset this agent was launched with (main/sessions.js ROLES) —
    // persisted on the session, so it survives a reattach after a restart
    this.roleEl = document.createElement('span');
    this.roleEl.className = 'pane-role';
    if (session.role) {
      this.roleEl.textContent = session.role;
      this.roleEl.dataset.tip = `Launched as a ${session.role} — its own system prompt and model`;
    } else {
      this.roleEl.style.display = 'none';
    }

    // model and effort are drawn in exactly one place at a time — see syncModelChip
    this.effortEl = document.createElement('span');
    this.effortEl.className = 'pane-effort';
    this.effortEl.style.display = 'none';
    this.effortLabel = '';
    this.effortTip = 'Claude reasoning effort for this agent';

    this.llmEl = document.createElement('span');
    this.llmEl.className = 'pane-llm';
    this.llmEl.style.display = 'none';
    this.modelLabel = '';
    this.modelTip = 'Claude model for this agent';
    this.transcriptId = null; // Claude conversation id, from the hook payload

    this.gitEl = document.createElement('span');
    this.gitEl.className = 'pane-git';
    this.gitEl.style.display = 'none';
    this.gitEl.addEventListener('click', () => this.openBranchMenu());
    this.gitInfo = null;
    this.branchMenuEl = null;

    this.titleEl = document.createElement('span');
    this.titleEl.className = 'pane-title';
    this.titleEl.textContent = session.agentName;
    this.titleEl.dataset.tip = 'Click to rename';
    this.titleEl.addEventListener('click', () => this.startRename());

    this.modeSel = document.createElement('select');
    this.modeSel.className = 'pane-mode';
    this.modeSel.dataset.tip = 'Claude mode — switches by cycling Shift+Tab in the agent';
    for (const [value, label] of MODES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.modeSel.appendChild(opt);
    }
    this.modeSel.addEventListener('keydown', (e) => e.stopPropagation());
    this.modeSel.addEventListener('change', () => this.setMode(this.modeSel.value));

    this.modeBusy = false;
    this.modeTimer = null;

    // live agent state from Claude Code hooks (tool name, waiting, done)
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'pane-status';
    this.statusEl.style.display = 'none';

    // equalizer-style busy indicator, shown only while the agent is working
    this.busyEl = document.createElement('span');
    this.busyEl.className = 'pane-busy';
    this.busyEl.style.display = 'none';
    for (let i = 0; i < 5; i++) {
      const bar = document.createElement('span');
      bar.className = 'pane-busy-bar';
      bar.style.animationDelay = `${i * 0.1}s`;
      this.busyEl.appendChild(bar);
    }

    // quick-respond to a live numbered permission prompt (Notification hook
    // event) without opening the pane — reuses the same menu-line parsing as
    // the clickable option links below (MENU_OPTION_RE)
    this.btnApprove = document.createElement('button');
    this.btnApprove.className = 'pane-btn approve';
    this.btnApprove.dataset.tip = 'Approve (shift-click: always allow)';
    this.btnApprove.innerHTML = icon('<path d="M5 12.5l5 5L19 7"/>');
    this.btnApprove.style.display = 'none';
    this.btnApprove.addEventListener('click', (e) => {
      if (!this.respondToPrompt('yes', e.shiftKey)) toast("couldn't read the prompt — open the pane");
    });

    this.btnDeny = document.createElement('button');
    this.btnDeny.className = 'pane-btn deny';
    this.btnDeny.dataset.tip = 'Deny';
    this.btnDeny.innerHTML = icon('<path d="M6 6l12 12M18 6L6 18"/>');
    this.btnDeny.style.display = 'none';
    this.btnDeny.addEventListener('click', () => {
      if (!this.respondToPrompt('no', false)) toast("couldn't read the prompt — open the pane");
    });

    this.badge = document.createElement('span');
    this.badge.className = 'pane-badge';
    this.badge.style.display = 'none';

    // "somebody else is in this file too" — its own chip rather than the badge
    // above, which is already spoken for by exited/detached and would have the
    // two states overwrite each other.
    this.collisionEl = document.createElement('span');
    this.collisionEl.className = 'pane-collision';
    this.collisionEl.style.display = 'none';

    // "this Opus agent has only been reading" — click twice to bring it back
    // on Haiku. A button, not a chip: it is the one thing in the header that
    // changes what the agent costs.
    this.readOnlyStreak = 0;
    this.rightsizeEl = document.createElement('button');
    this.rightsizeEl.className = 'pane-rightsize';
    this.rightsizeEl.textContent = '→ Haiku';
    this.rightsizeEl.style.display = 'none';
    this.rightsizeEl.addEventListener('click', () => {
      Confirm.armOrFire(this.rightsizeEl, 'rightsize:' + this.session.id, () => {
        this.readOnlyStreak = 0;
        this.syncRightsize(); // the offer goes away with the agent it was for
        this.handlers.onRestart(this, { resume: true, model: 'haiku' });
      });
    });

    this.btnRestart = document.createElement('button');
    this.btnRestart.className = 'pane-btn restart';
    this.btnRestart.dataset.tip = LIVE_RESTART_TIP;
    this.btnRestart.innerHTML = icon('<path d="M20.5 9.5A8.5 8.5 0 1 0 21 14"/><path d="M21 4v5.5h-5.5"/>');
    // A live agent's restart is destructive — it replaces a running session —
    // so it arms first. An exited or detached one has nothing to lose and
    // stays a single click, which is what ↻ has always meant there.
    this.btnRestart.addEventListener('click', (e) => {
      const fresh = e.shiftKey;
      if (this.exited) { handlers.onRestart(this, { resume: !fresh }); return; }
      Confirm.armOrFire(this.btnRestart, 'restart:' + this.session.id, () => {
        handlers.onRestart(this, { resume: !fresh });
      });
    });

    // /clear — only shown once the agent is idle (finished a turn); wipes its
    // conversation context without restarting the process.
    this.btnClear = document.createElement('button');
    this.btnClear.className = 'pane-btn clear';
    this.btnClear.dataset.tip = "Clear this agent's context (/clear)";
    this.btnClear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20H8.5L3.6 15a1.4 1.4 0 0 1 0-2L12.8 3.8a1.4 1.4 0 0 1 2 0l5.2 5.2a1.4 1.4 0 0 1 0 2L11.5 20"/><path d="M6.5 10.5l7 7"/></svg>';
    this.btnClear.style.display = 'none';
    this.btnClear.addEventListener('click', () => {
      if (this.exited) return;
      window.swarm.writeSession(this.session.id, '/clear\r');
    });

    const btnExport = document.createElement('button');
    btnExport.className = 'pane-btn export';
    btnExport.dataset.tip = 'Save transcript to a file';
    btnExport.innerHTML = icon('<path d="M12 3v11"/><path d="M7.5 10L12 14.5 16.5 10"/><path d="M4 20h16"/>');
    btnExport.addEventListener('click', () => handlers.onExport(this));

    const btnSearch = document.createElement('button');
    btnSearch.className = 'pane-btn search';
    btnSearch.dataset.tip = 'Search (Ctrl+Shift+F)';
    btnSearch.innerHTML = icon('<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5l-4.8-4.8"/>');
    btnSearch.addEventListener('click', () => this.toggleSearch());

    const btnMic = document.createElement('button');
    btnMic.className = 'pane-btn mic';
    btnMic.dataset.tip = 'Dictate (click to start/stop, Ctrl+R) — say "send it" to submit, double-click for hands-free';
    btnMic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>';
    // closing the pane mid-dictation must release the mic (see dispose).
    // Double-click arms hands-free: "send it" still submits, but the mic stays
    // open for the next prompt instead of closing, until a second double-click
    // (or anything else that stops dictation) ends it.
    let dictating = false;
    const mic = window.Speech.wire(btnMic, {
      onStart: () => { dictating = true; },
      onEnd: () => { dictating = false; this.setHandsFree(false); },
      onDouble: () => {
        if (this.handsFree) { this.stopDictation(); return; }
        this.setHandsFree(true);
        if (!dictating) mic.toggle();
      },
      onResult: (text) => {
        if (!text) return;
        const submit = DICTATE_SUBMIT.test(text);
        const body = submit ? text.replace(DICTATE_SUBMIT, '') : text;
        if (body) this.term.paste(submit ? body : body + ' ');
        if (!submit) return;
        if (!this.handsFree) this.stopDictation();
        setTimeout(() => {
          if (!this.exited) window.swarm.writeSession(this.session.id, '\r');
        }, DICTATE_SUBMIT_DELAY_MS);
      },
    });
    this.handsFree = false;
    this.setHandsFree = (on) => {
      this.handsFree = on;
      btnMic.classList.toggle('hands-free', on);
    };
    this.toggleDictation = mic.toggle;
    this.stopDictation = mic.stop;

    const btnFontDown = document.createElement('button');
    btnFontDown.className = 'pane-btn font-down';
    btnFontDown.dataset.tip = 'Smaller text';
    btnFontDown.innerHTML = icon('<path d="M5 12h14"/>');
    btnFontDown.addEventListener('click', () => this.setFontSize(this.term.options.fontSize - 1));

    const btnFontUp = document.createElement('button');
    btnFontUp.className = 'pane-btn font-up';
    btnFontUp.dataset.tip = 'Larger text';
    btnFontUp.innerHTML = icon('<path d="M12 5v14M5 12h14"/>');
    btnFontUp.addEventListener('click', () => this.setFontSize(this.term.options.fontSize + 1));

    const btnMax = document.createElement('button');
    btnMax.className = 'pane-btn max';
    btnMax.dataset.tip = 'Maximize / restore (Ctrl+Shift+M)';
    btnMax.innerHTML = icon('<path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M4 15v5h5"/>');
    btnMax.addEventListener('click', () => handlers.onMaximize(this));

    this.btnSplitRight = document.createElement('button');
    this.btnSplitRight.className = 'pane-btn split-right';
    this.btnSplitRight.dataset.tip = 'Open a new agent to the right';
    this.btnSplitRight.innerHTML = icon('<path d="M4 12h15"/><path d="M13.5 6.5L19 12l-5.5 5.5"/>');
    this.btnSplitRight.addEventListener('click', () => handlers.onSplit(this, 'right'));

    this.btnSplitDown = document.createElement('button');
    this.btnSplitDown.className = 'pane-btn split-down';
    this.btnSplitDown.dataset.tip = 'Open a new agent below';
    this.btnSplitDown.innerHTML = icon('<path d="M12 4v15"/><path d="M6.5 13.5L12 19l5.5-5.5"/>');
    this.btnSplitDown.addEventListener('click', () => handlers.onSplit(this, 'down'));
    this.syncSplitButtons();

    this.btnClose = document.createElement('button');
    this.btnClose.className = 'pane-btn close';
    this.btnClose.dataset.tip = 'Close session';
    this.btnClose.innerHTML = icon('<path d="M6 6l12 12M18 6L6 18"/>');
    // mousedown, not click: a click needs down+up on the same element and
    // can get eaten by focus/layout churn in between — mousedown cannot
    this.btnClose.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // killing a pane shouldn't also focus it
      e.preventDefault();
      this.requestClose();
    });

    // the four buttons nobody reaches for mid-turn — inline when "Fixed agent
    // pane buttons" is on, folded under the ⋯ otherwise. Search and text size
    // have keyboard shortcuts, and text size is an Options row as well, so a
    // pane header that shows all nine at once is nine equal-weight glyphs per
    // pane and none of them louder than the agent's own name. The mic stays
    // out: dictation is reached mid-turn, so it sits in the cluster itself.
    this.overflowEl = document.createElement('span');
    this.overflowEl.className = 'pane-overflow';
    this.overflowEl.append(btnExport, btnSearch, btnFontDown, btnFontUp);
    this.overflowEl.addEventListener('click', () => this.closeActionTray());

    this.btnMore = document.createElement('button');
    this.btnMore.className = 'pane-btn more';
    this.btnMore.dataset.tip = 'Export, search, text size';
    this.btnMore.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
    this.btnMore.addEventListener('click', () => this.toggleActionTray());

    // one bordered cluster, the way the top bar groups its secondary actions
    const actions = document.createElement('span');
    actions.className = 'pane-actions';
    actions.append(
      this.btnRestart, this.btnClear, btnMic, this.overflowEl, this.btnMore,
      btnMax, this.btnSplitRight, this.btnSplitDown, this.btnClose
    );

    header.append(
      this.dot, this.taskEl, this.roleEl, this.effortEl, this.llmEl, this.gitEl, this.titleEl, this.statusEl, this.busyEl, this.btnApprove, this.btnDeny, this.modeSel, this.rightsizeEl, this.collisionEl, this.badge, actions
    );
    this.syncActionsMode();

    // search row (hidden until toggled)
    this.searchEl = document.createElement('div');
    this.searchEl.className = 'pane-search';
    this.searchEl.style.display = 'none';
    this.searchInput = document.createElement('input');
    this.searchInput.placeholder = 'search';
    this.searchInput.spellcheck = false;
    const sPrev = document.createElement('button');
    sPrev.textContent = '↑';
    sPrev.dataset.tip = 'Previous match';
    const sNext = document.createElement('button');
    sNext.textContent = '↓';
    sNext.dataset.tip = 'Next match';
    const sClose = document.createElement('button');
    sClose.textContent = '✕';
    sClose.dataset.tip = 'Close search (Esc)';
    this.searchEl.append(this.searchInput, sPrev, sNext, sClose);

    // second header row, under the main one — the most recent command
    // entered in this pane (the task prompt it was launched with, until the
    // user types a new line, which then takes over); hidden unless both the
    // option is on and there is a command to show
    this.subheaderEl = document.createElement('div');
    this.subheaderEl.className = 'pane-subheader';
    this.subheaderEl.style.display = 'none';
    const subheaderBar = document.createElement('span');
    subheaderBar.className = 'pane-subheader-bar';
    this.subheaderTextEl = document.createElement('span');
    this.subheaderTextEl.className = 'pane-subheader-text';
    this.subheaderEl.append(subheaderBar, this.subheaderTextEl);
    this.initialCommandText = '';
    // survives a reattach after the app was closed and reopened — tmux keeps
    // the agent alive but remembers nothing of what was typed into it, so the
    // subheader would otherwise go blank on every restart
    this.typedInitialCommand = session.lastCommand || null;
    this.typedLineBuffer = '';

    this.termEl = document.createElement('div');
    this.termEl.className = 'pane-term';

    // bottom panel: what this agent has spent and how full its context is.
    // Two rows — the meter, and the slower-moving detail under it — hidden
    // entirely unless the option is on.
    this.usageEl = document.createElement('div');
    this.usageEl.className = 'pane-usage';
    this.usageEl.style.display = 'none';
    this.usageBarEl = document.createElement('span');
    this.usageBarEl.className = 'pane-usage-bar';
    this.usageBarFillEl = document.createElement('i');
    this.usageBarEl.appendChild(this.usageBarFillEl);
    this.usageCtxEl = document.createElement('span');
    this.usageCtxEl.className = 'pane-usage-ctx';
    this.usageCostEl = document.createElement('span');
    this.usageCostEl.className = 'pane-usage-cost';
    this.usageCacheEl = document.createElement('span');
    this.usageCacheEl.className = 'pane-usage-cache';
    this.usageEffortEl = document.createElement('span');
    this.usageEffortEl.className = 'pane-usage-effort';
    this.usageModelEl = document.createElement('span');
    this.usageModelEl.className = 'pane-usage-model';
    // effort sits left of the model, and the pair rides to the right edge
    // together — one wrapper instead of an auto margin that would move
    // whenever the effort label is hidden
    const usageRight = document.createElement('span');
    usageRight.className = 'pane-usage-right';
    usageRight.append(this.usageEffortEl, this.usageModelEl);
    const usageTop = document.createElement('div');
    usageTop.className = 'pane-usage-row';
    usageTop.append(this.usageBarEl, this.usageCtxEl, this.usageCostEl, this.usageCacheEl, usageRight);

    this.usageSparkEl = document.createElement('span');
    this.usageSparkEl.className = 'pane-usage-spark';
    this.usageTurnsEl = document.createElement('span');
    this.usageTimeEl = document.createElement('span');
    this.usageShareEl = document.createElement('span');
    this.usageToolsEl = document.createElement('span');
    this.usageToolsEl.className = 'pane-usage-tools';
    const usageSub = document.createElement('div');
    usageSub.className = 'pane-usage-row pane-usage-sub';
    usageSub.append(this.usageSparkEl, this.usageTurnsEl, this.usageTimeEl, this.usageShareEl, this.usageToolsEl);
    this.usageEl.append(usageTop, usageSub);

    this.el.append(header, this.subheaderEl, this.searchEl, this.termEl, this.usageEl);
    this.syncInitialCommandHeader();
    this.syncUsagePanel();

    this.term = new Terminal({
      theme: activeXtermTheme,
      // per-cell readability on the light themes — see the pass above
      minimumContrastRatio: activeMinContrast,
      allowTransparency: true, // glass panes: the canvas bg is transparent, CSS tints it
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: activeFontSize,
      fontWeight: activeFontWeight,
      fontWeightBold: boldFor(activeFontWeight),
      lineHeight: 1.15,
      cursorBlink: true,
      // a completed task's transcript popup reads straight from this buffer
      // (see getBufferText below) — too small a cap silently evicts the
      // start of a long session before it ever gets captured
      scrollback: 20000,
      allowProposedApi: true,
      // native OSC 8 hyperlinks (an agent can re-open a full link span on
      // every row a long URL wraps across) — without this, xterm's built-in
      // fallback is a confirm() dialog plus window.open, which does nothing
      // useful in Electron. WebLinksAddon below covers plain-text URLs; this
      // covers OSC 8 ones the same way.
      linkHandler: {
        activate: (_event, uri) => window.swarm.openExternal(uri),
      },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.swarm.openExternal(uri)));

    // clicking a numbered menu line (e.g. Claude's "1. Yes  2. No" prompts)
    // sends that option's digit key to the pty, same as typing it
    this.term.registerLinkProvider({
      provideLinks: (lineNum, callback) => {
        const line = this.term.buffer.active.getLine(lineNum - 1);
        const text = line && line.translateToString(true);
        const m = text && MENU_OPTION_RE.exec(text);
        if (!m) return callback(undefined);
        callback([{
          range: { start: { x: m[1].length + 1, y: lineNum }, end: { x: text.length + 1, y: lineNum } },
          text: m[2],
          activate: () => {
            if (this.exited) return;
            window.swarm.writeSession(session.id, m[2]);
          },
        }]);
      },
    });

    // a TUI can switch on terminal mouse reporting (DECSET 1000/1002/1006…),
    // which would make xterm hand every click to the app — breaking text
    // selection, copy, and both link providers above. Nothing here wants raw
    // mouse reporting — clicks are handled client-side, and the one event tmux
    // does act on (the wheel) is synthesized by the wheel listener below — so
    // swallow the requests and keep the mouse local.
    const MOUSE_DECSET = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
    for (const final of ['h', 'l']) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) =>
        params.every((p) => MOUSE_DECSET.has(p)));
    }

    this.term.open(this.termEl);

    // GPU renderer; falls back to the DOM renderer on failure/context loss
    this.webgl = null;
    this.rendererDropped = false; // true while a hidden pane's context is released (see dropRenderer)
    this.attachWebgl();

    // attention: terminal bell, plus OSC 9 / OSC 777 desktop-notification sequences
    this.term.onBell(() => this.flagAttention());
    this.term.parser.registerOscHandler(9, () => { this.flagAttention(); return true; });
    this.term.parser.registerOscHandler(777, () => { this.flagAttention(); return true; });

    // shortcuts are executed by the document-level handler; returning false
    // here just keeps xterm from also acting on the keystroke
    this.term.attachCustomKeyEventHandler((e) => {
      // Ctrl+C with an active selection copies it (Windows Terminal
      // convention) instead of interrupting the agent — xterm itself has no
      // copy path for Ctrl+C: it would send ^C to the pty and clear the
      // selection, making copying from a pane impossible. Interrupt still
      // works with nothing selected (or after a click to deselect).
      if (e.type === 'keydown' && e.code === 'KeyC' && e.ctrlKey
          && !e.shiftKey && !e.altKey && !e.metaKey && this.term.hasSelection()) {
        window.swarm.copyText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      return !handlers.onShortcut(e);
    });

    this.term.onData((data) => {
      if (this.exited) return;
      this.lastInputAt = Date.now();
      this.clearAttention();
      this.captureInitialCommand(data);
      window.swarm.writeSession(session.id, data);
    });

    // Wheel over the output scrolls the agent's history; over the input box
    // at the bottom it stays Up/Down, which is what cycles previous prompts.
    //
    // xterm's own scrollback is empty here — the tmux attach client paints on
    // the alternate buffer — and its alternate-scroll fallback turns every
    // notch anywhere into an Up/Down keypress, which is why scrolling used to
    // walk the prompt history instead of the transcript. tmux holds the real
    // scrollback, so forward the notch to it as an SGR mouse event (see
    // WHEEL_LINES in sessions.js). Without tmux there is no alternate buffer
    // and xterm's native scrollback works — leave that case alone.
    this.termEl.addEventListener('wheel', (e) => {
      if (this.exited || this.term.buffer.active.type !== 'alternate') return;
      e.preventDefault();
      e.stopPropagation(); // capture phase: keep xterm from also alt-scrolling
      this.lastInputAt = Date.now(); // tmux repaints on scroll — not agent activity
      const up = e.deltaY < 0;
      const row = this.rowAtY(e.clientY);
      if (row >= this.inputBoxTop()) {
        window.swarm.writeSession(session.id, up ? '\x1b[A' : '\x1b[B');
        return;
      }
      window.swarm.writeSession(session.id, `\x1b[<${up ? 64 : 65};1;${row + 1}M`);
    }, { capture: true, passive: false });

    const sGo = (forward) => {
      const q = this.searchInput.value;
      if (!q) return;
      if (forward) this.search.findNext(q); else this.search.findPrevious(q);
    };
    this.searchInput.addEventListener('input', () => {
      const q = this.searchInput.value;
      if (q) this.search.findNext(q, { incremental: true });
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { sGo(!e.shiftKey); e.preventDefault(); }
      if (e.key === 'Escape') { this.toggleSearch(false); e.preventDefault(); }
      e.stopPropagation();
    });
    sPrev.addEventListener('click', () => sGo(false));
    sNext.addEventListener('click', () => sGo(true));
    sClose.addEventListener('click', () => this.toggleSearch(false));

    this.el.addEventListener('mousedown', () => {
      document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
      this.el.classList.add('focused');
      this.clearAttention();
      handlers.onFocus(this);
    });

    // dropping files/images onto the terminal pastes their paths for the agent
    this.termEl.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = this.exited ? 'none' : 'copy';
      this.el.classList.toggle('file-drop', !this.exited);
    });
    this.termEl.addEventListener('dragleave', () => this.el.classList.remove('file-drop'));
    this.termEl.addEventListener('drop', (e) => {
      this.el.classList.remove('file-drop');
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      if (this.exited) return;
      const paths = [...e.dataTransfer.files]
        .map((f) => window.swarm.pathForFile(f))
        .filter(Boolean)
        .map(agentPath)
        .map((p) => (/\s/.test(p) ? `"${p}"` : p));
      if (!paths.length) return;
      // paste, not raw write: respects bracketed-paste mode in the TUI
      this.term.paste(paths.join(' ') + ' ');
      this.focus();
    });

    let fitTimer = null;
    this.observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => this.refit(), 50);
    });
    this.observer.observe(this.termEl);
  }

  /* Take xterm's GPU renderer, or leave the DOM one in place if the context
   * can't be had. A lost context detaches it exactly the way dropRenderer
   * does, so restoreRenderer can come back for it later. */
  attachWebgl() {
    if (this.webgl) return;
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch { /* already gone */ }
        this.webgl = null;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch { /* DOM renderer it is */ }
  }

  /* ---- wheel scrolling (see the wheel listener above) ---- */

  /* 0-based terminal row under a viewport y coordinate */
  rowAtY(y) {
    const screen = this.termEl.querySelector('.xterm-screen');
    if (!screen) return 0;
    const r = screen.getBoundingClientRect();
    const row = Math.floor((y - r.top) / (r.height / this.term.rows));
    return Math.min(this.term.rows - 1, Math.max(0, row));
  }

  /* First row of Claude's input box. The prompt marker is the only reliable
   * sign of it from the outside: the box is drawn as two plain `─` rules,
   * indistinguishable from a separator in the transcript, but `❯` sits on the
   * box's first text row and the input box is always the last thing on the
   * screen — so the lowest `❯` is the live prompt (the ones above it are
   * echoed messages), and the rule above it is where the box starts. No
   * prompt (a plain shell, an overlay like `/help`, a permission dialog)
   * means no input area, so the whole pane scrolls. */
  inputBoxTop() {
    const buf = this.term.buffer.active;
    for (let i = this.term.rows - 1; i >= 0; i--) {
      const line = buf.getLine(buf.viewportY + i);
      const text = line && line.translateToString(true).trim();
      if (text && text.startsWith('❯')) return Math.max(0, i - 1);
    }
    return this.term.rows;
  }

  /* ---- status: exited > attention > working/idle ---- */

  get status() {
    if (this.exited) return 'exited';
    if (this.attention) return 'attention';
    return this.working ? 'working' : 'idle';
  }

  syncStatus() {
    const status = this.status;
    this.dot.classList.toggle('idle', status === 'idle');
    this.dot.classList.toggle('attn', status === 'attention');
    this.el.classList.toggle('attn', status === 'attention');
    this.busyEl.style.display = status === 'working' ? '' : 'none';
    // /clear appears once the agent is done working and free (not mid-turn, not
    // blocked on a permission prompt, not exited)
    const canClear = !this.exited && !this.working && !this.awaitingPrompt;
    this.btnClear.style.display = canClear ? '' : 'none';
  }

  flagAttention() {
    if (this.exited) return;
    // no attention for output the user is already looking at — which requires
    // the pane to actually be on screen (isConnected), not focused-but-hidden
    // in a non-selected workspace
    if (this.el.isConnected && this.el.classList.contains('focused') && document.hasFocus()) return;
    const was = this.attention;
    this.attention = true;
    this.syncStatus();
    if (!was) this.handlers.onStatusChange(this, 'attention');
  }

  clearAttention() {
    if (!this.attention) return;
    this.attention = false;
    this.syncStatus();
    this.handlers.onStatusChange(this, 'cleared');
  }

  noteActivity() {
    // once hook events flow they own the working/idle state — output timing
    // would only second-guess them (long thinking looks idle, redraws look busy)
    if (this.exited || this.hookAlive) return;
    if (Date.now() - this.lastInputAt < INPUT_ECHO_MS) return;
    if (!this.working) {
      this.workStart = Date.now();
      this.working = true;
      this.syncStatus();
      this.handlers.onStatusChange(this, 'working');
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.working = false;
      this.syncStatus();
      this.handlers.onStatusChange(this, 'idle');
      // sustained output that stops = the agent finished its turn or is
      // waiting on a prompt — surface it like a bell
      if (Date.now() - this.workStart >= FINISHED_MIN_WORK_MS + IDLE_AFTER_MS) {
        this.flagAttention();
      }
    }, IDLE_AFTER_MS);
  }

  /* ---- precise state from Claude Code hooks ---- */

  setStatusText(text) {
    this.statusText = text || '';
    this.statusEl.textContent = text || '';
    this.statusEl.style.display = text ? '' : 'none';
  }

  syncPromptButtons() {
    const show = this.awaitingPrompt && this.promptAnswerable && !this.exited;
    this.btnApprove.style.display = show ? '' : 'none';
    this.btnDeny.style.display = show ? '' : 'none';
  }

  /* Quick-respond to a live numbered permission prompt from the pane header
   * or the notification bell, without opening the pane. Reuses the same
   * menu-line shape the clickable option links already parse
   * (MENU_OPTION_RE): scan the tail of the buffer for "N. <text>" lines and
   * send just the matching option's digit — no Enter, same as those links.
   *
   * kind: 'yes' picks the first option whose text starts with "yes";
   * 'no' the first starting with "no". always=true (shift-click ✓) prefers
   * a "yes" option that also mentions "don't ask"/"always" (Claude's
   * remember-this-choice variant) over a plain one, falling back to plain
   * yes if no such option exists. No matching option = nothing sent; caller
   * shows a toast instead of guessing. */
  promptOptions(lines = this.tailLines(30)) {
    const options = [];
    for (const line of lines) {
      const m = MENU_OPTION_RE.exec(line);
      // the label only — the "1." itself has to come off, or every option
      // starts with a digit and nothing ever matches ^yes / ^no
      if (m) options.push({ digit: m[2], text: line.slice(m[1].length + m[2].length + 1).trim() });
    }
    return options;
  }

  pickPromptOption(kind, always, options = this.promptOptions()) {
    const wantAlways = kind === 'yes' && always;
    let pick = null;
    for (const o of options) {
      if (!new RegExp('^' + kind, 'i').test(o.text)) continue;
      // "…and don't ask again", "…allow all edits during this session" — the
      // remember-this-choice variant, whichever wording this prompt uses
      const mentionsAlways = /don'?t ask|always|allow all/i.test(o.text);
      if (wantAlways ? mentionsAlways : !mentionsAlways) return o;
      if (!pick) pick = o; // fallback candidate of the right yes/no family
    }
    return pick;
  }

  /* Whether the ✓/✕ pair has anything to click — a numbered menu with both a
   * yes and a no option on screen right now. The Notification hook fires for
   * *any* block on the user, and its commonest form is the idle "Claude is
   * waiting for your input" nudge, which has no menu behind it (in bypass
   * permissions mode it is the only notification there is). Gating on
   * awaitingPrompt alone therefore offered buttons that could only ever
   * answer "couldn't read the prompt". Re-run whenever output settles, since
   * the hook can land a beat before the TUI paints the menu. */
  refreshPromptOptions(lines = this.tailLines(30)) {
    const options = this.exited ? [] : this.promptOptions(lines);
    const answerable = !!(this.pickPromptOption('yes', false, options)
      && this.pickPromptOption('no', false, options));
    if (answerable === this.promptAnswerable) return;
    this.promptAnswerable = answerable;
    this.syncPromptButtons();
    // the bell and the swarm view carry their own copy of these buttons
    this.handlers.onStatusChange(this, 'prompt');
  }

  respondToPrompt(kind, always) {
    if (this.exited) return false;
    const pick = this.pickPromptOption(kind, always);
    if (!pick) {
      this.refreshPromptOptions(); // the menu moved on — stop offering the buttons
      return false;
    }
    this.awaitingPrompt = false;
    this.syncPromptButtons();
    this.clearAttention();
    window.swarm.writeSession(this.session.id, pick.digit);
    return true;
  }

  applyHookEvent({ event, tool, message, model, usage, transcript, collision }) {
    if (this.exited) return;
    // /clear and --resume both move the agent onto another transcript file,
    // so the newest one the hooks reported wins
    if (transcript) this.transcriptId = transcript;
    // per-turn totals from the transcript — a bookkeeping event, not a state
    // change, so it returns before any of the working/waiting handling below
    if (event === 'UsageUpdate') {
      // a null payload is the reset /clear sends: the tally starts over
      this.usage = usage || null;
      this.renderUsagePanel();
      return;
    }
    // another agent is writing a file this one is writing — like UsageUpdate,
    // a bookkeeping event that says nothing about this agent's own state, so
    // it returns before the working/waiting handling below
    if (event === 'Collision') {
      if (collision) this.setCollision(collision);
      return;
    }
    const wasWorking = this.working;
    if (!this.hookAlive) {
      this.hookAlive = true;
      clearTimeout(this.idleTimer); // heuristics are off duty now
      // and whatever they last decided is stale: boot output marks the pane
      // working, and if the first hook event is one that doesn't set
      // `working` itself (SessionStart, ModelUpdate), that true would be
      // frozen forever — idle timer cancelled, nothing left to clear it
      this.working = false;
    }
    // model only updates on these two event types: SessionStart (in case a
    // future Claude Code version populates it) and ModelUpdate (the main
    // process's own follow-up after tailing the transcript on Stop, since
    // the model isn't in the common hook payload — see hooks.js). Every
    // other event type ignores it, so a stale cached value never stomps a
    // fresher one from the /model-confirmation buffer scan below.
    if ((event === 'SessionStart' || event === 'ModelUpdate') && model) this.setModel(prettyModelName(model));
    if (event === 'UserPromptSubmit') {
      this.working = true;
      this.awaitingPrompt = false;
      this.noteTurnStart();
      this.setStatusText('');
    } else if (event === 'PreToolUse') {
      this.working = true;
      this.awaitingPrompt = false;
      this.noteTurnStart();
      if (tool) {
        this.toolTrail.push(tool);
        if (this.toolTrail.length > TOOL_TRAIL_MAX) this.toolTrail.shift();
        if (READ_ONLY_TOOLS.has(tool)) this.readOnlyStreak++;
        else this.readOnlyStreak = 0;
        this.syncRightsize();
      }
      this.setStatusText(tool === 'Bash' ? 'vibing...' : (tool || ''));
    } else if (event === 'Notification') {
      // claude is blocked on the user (permission prompt / waiting for input)
      this.working = false;
      this.awaitingPrompt = true;
      this.turnStartedAt = 0;
      this.waitingSince = this.waitingSince || Date.now();
      this.setStatusText(message || 'waiting for you');
      // a permission prompt is usually already painted by the time its hook
      // lands; a plain "waiting for your input" nudge never has a menu at all
      this.refreshPromptOptions();
      this.flagAttention();
    } else if (event === 'Stop') {
      this.working = false;
      this.awaitingPrompt = false;
      this.turnStartedAt = 0;
      this.waitingSince = 0;
      this.setStatusText('done');
      this.flagAttention();
      // completion must reach app.js even when flagAttention suppresses its
      // event (pane focused and watched, or attention already flagged) — a
      // board task's completion handling hangs off this dedicated status
      this.handlers.onStatusChange(this, 'done');
    }
    this.syncPromptButtons();
    this.syncStatus();
    if (wasWorking !== this.working) {
      this.handlers.onStatusChange(this, this.working ? 'working' : 'idle');
    }
  }

  /* Name whoever else has written this file recently. The ids come from main,
   * which has no idea what an agent is called — the names are resolved here,
   * against the panes actually on screen, so a session that has since been
   * closed simply drops out of the list instead of showing as a raw id. */
  setCollision({ file, others }) {
    const names = [];
    for (const id of others || []) {
      for (const pane of livePanes) if (pane.session.id === id) names.push(pane.session.agentName);
    }
    if (!names.length) return;
    this.collisionEl.textContent = '⚠ ' + file.split(/[\\/]/).pop();
    this.collisionEl.dataset.tip =
      `${names.join(', ')} ${names.length > 1 ? 'have' : 'has'} also edited ${file} recently`;
    this.collisionEl.style.display = '';
    clearTimeout(this.collisionTimer);
    this.collisionTimer = setTimeout(() => {
      this.collisionEl.style.display = 'none';
    }, COLLISION_SHOW_MS);
  }

  /* Offer a cheaper tier to an Opus agent that has done nothing but read.
   * The offer states what it will do before it does it and takes two clicks —
   * a model swap that happened silently mid-task would be the worst possible
   * version of this. Hidden again the moment the agent edits something. */
  syncRightsize() {
    const n = this.readOnlyStreak;
    const eligible = n >= RIGHTSIZE_MIN_CALLS
      && !this.exited
      && /^opus\b/i.test(this.modelLabel || '')
      && !RIGHTSIZE_SKIP_ROLES.has(this.session.role);
    this.rightsizeEl.style.display = eligible ? '' : 'none';
    if (!eligible) return;
    this.rightsizeEl.dataset.tip =
      `${this.session.agentName} has run ${n} read-only tool calls in a row on `
      + `${this.modelLabel}. Click twice to restart it on Haiku — the conversation `
      + 'is kept (--continue), so it picks up where it left off. The thread so far '
      + 'is re-sent once at the cheaper rate.';
  }

  /* ---- cost & context panel ---- */

  noteTurnStart() {
    this.waitingSince = 0;
    if (!this.turnStartedAt) this.turnStartedAt = Date.now();
  }

  /* Show or hide the panel, and keep the terminal's row count honest — two
   * rows of panel are two rows the terminal no longer has. */
  syncUsagePanel() {
    const was = this.usageEl.style.display !== 'none';
    this.usageEl.style.display = showUsagePanel ? '' : 'none';
    clearInterval(this.usageTimer);
    this.usageTimer = null;
    if (showUsagePanel) {
      this.renderUsagePanel();
      // the turn timer and the 5h share both move on their own
      this.usageTimer = setInterval(() => this.renderUsagePanel(), 1000);
    }
    this.syncModelChip(); // the panel takes the model over from the header

    if (showUsagePanel !== was && this.fit) this.refit();
  }

  /* Tokens this agent burned inside the current 5-hour usage window. Also the
   * numerator and (summed across panes) the denominator of its quota share. */
  windowTokens() {
    if (!this.usage || !this.usage.series) return 0;
    const start = (usageWindow && usageWindow.resetsAt ? usageWindow.resetsAt : Date.now() + FIVE_HOURS_MS) - FIVE_HOURS_MS;
    let total = 0;
    for (const point of this.usage.series) if (point.t >= start) total += point.tokens;
    return total;
  }

  renderUsagePanel() {
    if (this.usageEl.style.display === 'none') return;
    const u = this.usage;
    if (!u) {
      // no turn counted yet — either a brand-new agent or one just /clear'ed,
      // in which case last conversation's figures must not linger
      this.usageCtxEl.textContent = 'waiting for the first turn…';
      this.usageBarFillEl.style.width = '0%';
      this.usageEl.classList.remove('warn', 'hot');
      this.usageCostEl.textContent = '';
      this.usageCacheEl.textContent = '';
      this.usageSparkEl.textContent = '';
      this.usageTurnsEl.textContent = '';
      this.usageShareEl.style.display = 'none';
      return;
    }

    const limit = u.context > CONTEXT_WINDOW ? CONTEXT_WINDOW_LARGE : CONTEXT_WINDOW;
    const filled = Math.min(100, Math.round((u.context / limit) * 100));
    this.usageBarFillEl.style.width = filled + '%';
    this.usageEl.classList.toggle('warn', filled >= 70 && filled < 90);
    this.usageEl.classList.toggle('hot', filled >= 90);
    this.usageBarEl.dataset.tip = `Context in use: ${u.context.toLocaleString()} of ${fmtTokens(limit)} tokens — Claude Code compacts the conversation as this fills`;
    this.usageCtxEl.textContent = `${fmtTokens(u.context)} / ${fmtTokens(limit)}`;

    this.usageCostEl.textContent = (u.partial ? '≈' : '') + fmtCost(u.cost);
    this.usageCostEl.dataset.tip = 'Estimated spend for this agent at list prices — in '
      + fmtTokens(u.input) + ' · out ' + fmtTokens(u.output)
      + ' · cache read ' + fmtTokens(u.cacheRead) + ' · cache write ' + fmtTokens(u.cacheWrite)
      + (u.partial ? ' (session was already long when SwarmEye started counting, so this is a floor)' : '');

    const cached = u.cacheRead + u.cacheWrite + u.input;
    const hit = cached ? Math.round((u.cacheRead / cached) * 100) : 0;
    this.usageCacheEl.textContent = hit + '% cached';
    this.usageCacheEl.dataset.tip = 'Share of input served from the prompt cache at a tenth of the price — higher is cheaper';
    // the transcript's model is the same one ModelUpdate carries, but it can
    // arrive first on a reattach — take it when the chip is still blank
    if (!this.modelLabel && u.model) this.setModel(prettyModelName(u.model));

    // the sparkline and the tool trail are the only two values in the row that
    // don't say what they are — everything else carries its own unit
    const spark = sparkline(u.series);
    this.usageSparkEl.textContent = spark ? 'per turn ' + spark : '';
    this.usageSparkEl.dataset.tip = 'Tokens per turn, most recent on the right';
    this.usageTurnsEl.textContent = u.turns + (u.turns === 1 ? ' turn' : ' turns');

    const now = Date.now();
    if (this.turnStartedAt) this.usageTimeEl.textContent = 'working ' + fmtDuration(now - this.turnStartedAt);
    else if (this.waitingSince) this.usageTimeEl.textContent = 'waiting ' + fmtDuration(now - this.waitingSince);
    else this.usageTimeEl.textContent = 'idle';

    // this agent's slice of the 5-hour quota: its share of everything the
    // swarm burned this window, applied to the window's own percentage. The
    // API reports a percentage rather than tokens, so this is an estimate —
    // hence the ≈.
    const mine = this.windowTokens();
    let swarm = 0;
    for (const pane of livePanes) swarm += pane.windowTokens();
    const used = usageWindow && typeof usageWindow.usedPct === 'number' ? usageWindow.usedPct : null;
    if (used != null && swarm > 0) {
      const share = (mine / swarm) * used;
      this.usageShareEl.textContent = '≈' + (share < 1 ? share.toFixed(1) : Math.round(share)) + '% of 5h';
      this.usageShareEl.dataset.tip = `This agent burned ${fmtTokens(mine)} of the swarm's ${fmtTokens(swarm)} tokens this session window, which is ${used}% used overall`;
      this.usageShareEl.style.display = '';
    } else {
      this.usageShareEl.style.display = 'none';
    }

    this.usageToolsEl.textContent = this.toolTrail.length ? 'tools ' + this.toolTrail.join(' → ') : '';
    this.usageToolsEl.dataset.tip = 'Most recent tools this agent ran';
  }

  /* ---- model chip ---- */

  setModel(label) {
    if (!label) return;
    this.modelLabel = label;
    this.syncModelChip();
    // the tier usually lands after the first tool calls, so the streak can
    // already be long by the time we learn it is Opus
    this.syncRightsize();
  }

  setEffort(label) {
    if (!label) return;
    this.effortLabel = label;
    this.syncModelChip();
  }

  /* One model, one place: the cost & context panel owns it whenever that
   * panel is on, and the header chip only fills in when it is off. The
   * effort label rides along in both spots, left of the model. */
  syncModelChip() {
    const inPanel = this.usageEl.style.display !== 'none';
    this.llmEl.textContent = this.modelLabel;
    this.llmEl.dataset.tip = this.modelTip;
    this.llmEl.style.display = this.modelLabel && !inPanel ? '' : 'none';
    this.usageModelEl.textContent = this.modelLabel;
    this.usageModelEl.style.display = this.modelLabel ? '' : 'none';
    this.effortEl.textContent = this.effortLabel;
    this.effortEl.dataset.tip = this.effortTip;
    this.effortEl.style.display = this.effortLabel && !inPanel ? '' : 'none';
    this.usageEffortEl.textContent = this.effortLabel;
    this.usageEffortEl.dataset.tip = this.effortTip;
    this.usageEffortEl.style.display = this.effortLabel ? '' : 'none';
  }

  /* Last `n` buffer lines as plain text. Shared by every settle-time scan
   * (mode, model, trust/bypass dialogs) so a single pass over the buffer —
   * translateToString is the expensive part — serves all of them. */
  tailLines(n) {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows;
    const start = Math.max(0, end - n);
    const lines = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /* Live /model switches print "Set model to X and saved as your default…" —
   * caught straight from the rendered buffer, same technique as permission
   * mode, so a mid-session switch updates the chip with no extra plumbing. */
  syncModelFromBuffer(lines = this.tailLines(30)) {
    if (this.exited) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /Set model to\s+([^\n]+?)(?:\s+and saved\b.*)?$/i.exec(lines[i]);
      if (m) { this.setModel(m[1].trim()); return; }
    }
  }

  /* `/effort <level>` prints "Set effort level to high (this session only): …"
   * ("Effort level set to auto …" when cleared, "Current effort level: high"
   * from a bare `/effort current`) — read off the buffer exactly like the
   * model, so a manual switch updates the chip with no extra plumbing. */
  syncEffortFromBuffer(lines = this.tailLines(30)) {
    if (this.exited) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      // the level itself is spelled out, so the failure lines ("Failed to set
      // effort level: …") can't be mistaken for a level
      const m = /(?:Set effort level to|Effort level(?: set to)?:?)\s+(low|medium|high|xhigh|max|ultracode|auto)\b/i.exec(lines[i]);
      if (m) { this.setEffort(m[1].toLowerCase()); return; }
    }
  }

  /* Accept the blocking dialogs auto mode can't get past on its own (see
   * AUTO_ACCEPT_DIALOGS): each pre-highlights its accepting option, so
   * accepting is just pressing Enter — the same mechanism tryInjectPrompt
   * (app.js) uses to submit an initial task. Each fires at most once per
   * pane, and only when the user actually opted into auto mode. */
  autoAcceptDialogs(lines = this.tailLines(30)) {
    const text = lines.join('\n');
    for (const [flag, re] of AUTO_ACCEPT_DIALOGS) {
      if (this.exited || this[flag] || !re.test(text)) continue;
      this[flag] = true;
      if (skipPermissions) window.swarm.writeSession(this.session.id, '\r');
    }
  }

  /* ---- git context chip ---- */

  setGit(info) {
    this.gitInfo = info || null;
    if (!info || !info.branch) {
      this.gitEl.style.display = 'none';
      this.gitEl.textContent = '';
      return;
    }
    this.gitEl.style.display = '';
    this.gitEl.textContent = '⎇ ' + info.branch;
    this.gitEl.classList.toggle('dirty', !!info.dirty);
    this.gitEl.dataset.tip = (info.dirty
      ? `branch ${info.branch} — uncommitted changes`
      : `branch ${info.branch} — clean`) + ' · click for the diff and to switch branch';
  }

  /* Fill the popover's top section with what the workspace has changed since
   * HEAD. Long stats are elided in the middle — the summary line (git's own
   * "N files changed…") is the one that must survive, so it's kept explicitly
   * rather than trusting a plain head(). */
  renderDiffSummary(el, d) {
    el.textContent = '';
    if (!d) { el.textContent = 'could not read changes'; return; }
    const lines = d.stat ? d.stat.split('\n') : [];
    if (!lines.length && !d.untracked) { el.textContent = 'no changes since HEAD'; return; }
    const shown = lines.length > DIFF_STAT_MAX_LINES
      ? [...lines.slice(0, DIFF_STAT_MAX_LINES - 2), '…', lines[lines.length - 1]]
      : lines;
    for (const line of shown) {
      const row = document.createElement('div');
      row.className = 'branch-diff-line';
      row.textContent = line;
      el.appendChild(row);
    }
    if (d.untracked) {
      const row = document.createElement('div');
      row.className = 'branch-diff-line branch-diff-untracked';
      row.textContent = `${d.untracked} untracked file${d.untracked === 1 ? '' : 's'}`;
      el.appendChild(row);
    }
  }

  /* Click on the git chip: a summary of the working tree's changes on top,
   * then the repo's branches (local + remote, see main/git.js listBranches).
   * Picking one runs `git checkout` in the workspace; the chip updates via
   * the git:update push that follows.
   *
   * The two reads run concurrently rather than in sequence: listing branches
   * does a network fetch first and is much the slower of the two, so awaiting
   * it before asking for the diff would leave the popover blank the whole time. */
  async openBranchMenu() {
    if (this.branchMenuEl) { this.closeBranchMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'branch-menu';
    const diffEl = document.createElement('div');
    diffEl.className = 'branch-diff';
    diffEl.textContent = 'checking changes…';
    const listEl = document.createElement('div');
    listEl.className = 'branch-list';
    listEl.textContent = 'fetching branches…';
    menu.append(diffEl, listEl);
    // fixed-position (the pane clips overflow), anchored under the chip
    const r = this.gitEl.getBoundingClientRect();
    menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 470))}px`;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    document.body.appendChild(menu);
    this.branchMenuEl = menu;
    // now that it has been measured: a pane low in the grid would push a
    // popover this tall (diff summary plus the branch list) off the bottom,
    // so flip it above the chip instead
    if (r.bottom + 6 + menu.offsetHeight > window.innerHeight - 8) {
      menu.style.top = `${Math.round(Math.max(8, r.top - 6 - menu.offsetHeight))}px`;
    }
    this._branchDismiss = (e) => {
      if (!menu.contains(e.target) && e.target !== this.gitEl) this.closeBranchMenu();
    };
    document.addEventListener('mousedown', this._branchDismiss, true);

    window.swarm.gitDiff(this.session.workspaceId).then((d) => {
      if (this.branchMenuEl !== menu) return; // dismissed while the read ran
      this.renderDiffSummary(diffEl, d);
    });

    const branches = await window.swarm.listBranches(this.session.workspaceId);
    if (this.branchMenuEl !== menu) return; // dismissed while the fetch ran
    if (!branches || !branches.length) {
      listEl.textContent = 'no branches found';
      return;
    }
    const current = this.gitInfo && this.gitInfo.branch;
    listEl.textContent = '';
    for (const b of branches) {
      const row = document.createElement('button');
      row.className = 'branch-item' + (b === current ? ' current' : '');
      row.textContent = b;
      if (b !== current) row.addEventListener('click', () => this.pickBranch(b));
      listEl.appendChild(row);
    }

    // "+ new branch…" swaps itself for an input; Enter runs checkout -b
    const divider = document.createElement('div');
    divider.className = 'branch-menu-divider';
    listEl.appendChild(divider);
    const add = document.createElement('button');
    add.className = 'branch-item new';
    add.textContent = '+ new branch…';
    add.addEventListener('click', () => {
      const input = document.createElement('input');
      input.className = 'branch-new-input';
      input.placeholder = 'new branch name';
      input.spellcheck = false;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing must not trigger app shortcuts
        if (e.key === 'Enter') {
          const name = input.value.trim();
          if (name) this.pickBranch(name, { create: true });
        } else if (e.key === 'Escape') {
          this.closeBranchMenu();
        }
      });
      add.replaceWith(input);
      input.focus();
    });
    listEl.appendChild(add);
  }

  closeBranchMenu() {
    if (!this.branchMenuEl) return;
    this.branchMenuEl.remove();
    this.branchMenuEl = null;
    document.removeEventListener('mousedown', this._branchDismiss, true);
  }

  async pickBranch(branch, { create = false } = {}) {
    this.closeBranchMenu();
    const res = await window.swarm.checkoutBranch(this.session.workspaceId, branch, create);
    if (res && res.ok) toast(create ? `created ${branch}` : `switched to ${branch}`);
    else toast(res && res.error ? res.error : 'checkout failed');
  }

  /* ---- claude permission mode ---- */

  /* Read the mode from claude's footer ("⏸ plan mode on", "⏵⏵ accept edits
   * on", "⏵⏵ bypass permissions on") in the last rows of the buffer. No
   * marker = default mode (or the footer is hidden — same answer either way). */
  detectMode(lines = this.tailLines(12)) {
    const text = lines.slice(-12).join('\n');
    for (const [mode, re] of MODE_MARKERS) {
      if (re.test(text)) return mode;
    }
    return 'default';
  }

  /* Step Shift+Tab until the footer shows the target. One full lap is at
   * most 4 presses; if the target never appears (bypass not enabled, or a
   * dialog is eating keys) walk on back to where we started. Returns whether
   * the target was reached, so a caller applying a saved default can lap
   * again; `quiet` suppresses the toast on those non-final attempts. */
  async setMode(target, { quiet = false } = {}) {
    if (this.exited || this.modeBusy) return false;
    this.modeBusy = true;
    // only refocus the terminal if this pane had focus to begin with (the
    // user-picked dropdown case) — a scheduler-started task's setMode must
    // not steal the keyboard from whatever pane the user is typing in
    const hadFocus = this.el.contains(document.activeElement);
    try {
      const start = this.detectMode();
      let mode = start;
      for (let i = 0; i < 4 && mode !== target; i++) {
        window.swarm.writeSession(this.session.id, SHIFT_TAB);
        await new Promise((r) => setTimeout(r, MODE_STEP_MS));
        mode = this.detectMode();
      }
      if (mode !== target) {
        for (let i = 0; i < 4 && mode !== start; i++) {
          window.swarm.writeSession(this.session.id, SHIFT_TAB);
          await new Promise((r) => setTimeout(r, MODE_STEP_MS));
          mode = this.detectMode();
        }
        if (!quiet && window.toast) {
          toast(target === 'bypass'
            ? 'auto mode is off in this agent — enable it in ⌨ Options, then restart the agent'
            : 'could not switch mode — is claude showing a dialog?');
        }
      }
      this.modeSel.value = mode;
      return mode === target;
    } finally {
      this.modeBusy = false;
      if (hadFocus) this.term.focus();
    }
  }

  syncMode(lines) {
    if (this.exited || this.modeBusy) return;
    this.modeSel.value = this.detectMode(lines);
  }

  /* ---- focus view ---- */

  /* `/focus` toggles claude's "Focus view" — it is NOT off by default, so
   * blindly sending it (as a task's focus checkbox used to) can just as
   * easily turn it off as on. The footer shows a right-aligned "focus" pill
   * on the very last row while it's active; only the last row is checked
   * since "focus" alone is too common a word to safely match higher up in
   * the scrollback. */
  detectFocus(lines = this.tailLines(1)) {
    return /\bfocus\b/i.test(lines[lines.length - 1] || '');
  }

  /* ---- last-command header row ----
   * Shows the most recently submitted command in this pane's terminal,
   * reconstructed from the user's own keystrokes: best-effort, since raw
   * terminal input includes backspaces, arrow keys and pastes, but good
   * enough for the common case of typing (or pasting) a message and hitting
   * Enter. A task-started pane starts out showing its launch prompt (from
   * app.js's getPaneInitialPrompt) until the user types a new line, which
   * then takes over — see syncInitialCommandHeader. */
  captureInitialCommand(data) {
    // a full bracketed-paste chunk: unwrap it and treat embedded newlines as
    // literal content, not as Enter submitting the line
    const pasteMatch = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
    if (pasteMatch) {
      this.typedLineBuffer += pasteMatch[1].replace(/[\r\n]+/g, ' ');
      return;
    }
    if (data.charCodeAt(0) === 0x1b) return; // other escape sequences (arrow keys, etc.) — ignore whole chunk
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = this.typedLineBuffer.trim();
        this.typedLineBuffer = '';
        if (!line) continue; // blank Enter (e.g. dismissing a splash screen) — keep waiting
        this.typedInitialCommand = line;
        this.syncInitialCommandHeader();
        this.handlers.setLastCommand(this, line);
        return;
      }
      if (ch === '\x7f' || ch === '\b') { this.typedLineBuffer = this.typedLineBuffer.slice(0, -1); continue; }
      if (ch.charCodeAt(0) < 0x20) continue; // other control bytes
      this.typedLineBuffer += ch;
    }
  }

  /* Called explicitly by app.js whenever a task's prompt text becomes known
   * (task start) or the option is toggled, and by captureInitialCommand
   * above every time the user submits a new line. Once the user has typed
   * anything, that takes precedence over the task's original launch prompt
   * — the header tracks the latest command, not just the first one. */
  syncInitialCommandHeader() {
    const prompt = this.handlers.getPaneInitialPrompt && this.handlers.getPaneInitialPrompt(this.session.id);
    this.initialCommandText = this.typedInitialCommand || prompt || '';
    // the title/dot hover shows a task's prompt (not a manually typed first
    // line) — same data-tip system as every other hint in the app, so
    // tooltip.js owns the delay, placement and dismissal
    this.titleEl.dataset.tip = prompt || 'Click to rename';
    if (prompt) this.dot.dataset.tip = prompt; else delete this.dot.dataset.tip;
    this.subheaderTextEl.textContent = this.initialCommandText;
    this.subheaderEl.style.display = (showInitialCommand && this.initialCommandText) ? '' : 'none';
  }

  /* Called at construction and whenever the "Auto-organize agent windows"
   * option is toggled — the split buttons are how you place agents by hand,
   * so they're only useful while auto-organize is off. */
  syncSplitButtons() {
    this.btnSplitRight.style.display = autoOrganize ? 'none' : '';
    this.btnSplitDown.style.display = autoOrganize ? 'none' : '';
  }

  /* ⋯ tray — the folded buttons drop under the header. Dismissed the way the
   * branch menu is: a capture-phase mousedown anywhere outside it. */
  toggleActionTray() {
    if (this.overflowEl.classList.contains('open')) { this.closeActionTray(); return; }
    this.overflowEl.classList.add('open');
    // the mousedown fires before the ⋯ button's own click, so a click on the
    // button itself must not count as "outside" — it would close and reopen
    this._trayDismiss = (e) => {
      if (!this.overflowEl.contains(e.target) && !this.btnMore.contains(e.target)) this.closeActionTray();
    };
    document.addEventListener('mousedown', this._trayDismiss, true);
  }

  closeActionTray() {
    if (!this.overflowEl.classList.contains('open')) return;
    this.overflowEl.classList.remove('open');
    document.removeEventListener('mousedown', this._trayDismiss, true);
  }

  syncActionsMode() {
    this.el.classList.toggle('fixed-actions', fixedActions);
    if (fixedActions) this.closeActionTray();
  }

  /* ---- rename ---- */

  startRename() {
    if (this.titleEl.isContentEditable) return;
    const orig = this.session.agentName;
    this.titleEl.contentEditable = 'plaintext-only';
    this.titleEl.focus();
    document.getSelection().selectAllChildren(this.titleEl);

    const commit = (keep) => {
      // remove, don't set 'false': [contenteditable] CSS matches any value,
      // so a leftover attribute keeps the edit outline on forever
      this.titleEl.removeAttribute('contenteditable');
      const name = (keep ? this.titleEl.textContent : orig).trim().slice(0, 40) || orig;
      this.titleEl.textContent = name;
      document.getSelection().removeAllRanges();
      if (name !== orig) {
        this.session.agentName = name;
        this.handlers.onRename(this, name);
      }
      this.term.focus();
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.titleEl.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); this.titleEl.textContent = orig; this.titleEl.blur(); }
    };
    // pressing on non-focusable chrome never blurs the title by itself —
    // force the edit to end on any mousedown outside it
    const onDocDown = (e) => {
      if (!this.titleEl.isConnected) {
        document.removeEventListener('mousedown', onDocDown, true);
        return;
      }
      if (e.target !== this.titleEl) this.titleEl.blur();
    };
    document.addEventListener('mousedown', onDocDown, true);
    this.titleEl.addEventListener('keydown', onKey);
    this.titleEl.addEventListener('blur', () => {
      document.removeEventListener('mousedown', onDocDown, true);
      this.titleEl.removeEventListener('keydown', onKey);
      commit(true);
    }, { once: true });
  }

  /* ---- search ---- */

  toggleSearch(show = this.searchEl.style.display === 'none') {
    this.searchEl.style.display = show ? '' : 'none';
    if (show) {
      this.searchInput.focus();
      this.searchInput.select();
    } else {
      this.search.clearDecorations();
      this.term.focus();
    }
    requestAnimationFrame(() => this.refit());
  }

  /* ---- close with confirm ---- */

  requestClose() {
    if (this.exited || this.btnClose.classList.contains('armed')) {
      clearTimeout(this.closeArmTimer);
      this.handlers.onClose(this);
      return;
    }
    this.btnClose.classList.add('armed');
    this.btnClose.dataset.tip = 'Click again to kill this agent';
    if (window.toast) toast(`click ✕ again to kill ${this.session.agentName}`);
    this.closeArmTimer = setTimeout(() => this.disarmClose(), CLOSE_ARM_MS);
  }

  disarmClose() {
    clearTimeout(this.closeArmTimer);
    this.btnClose.classList.remove('armed');
    this.btnClose.dataset.tip = 'Close session';
  }

  /* ---- misc ---- */

  setFontSize(px) {
    const size = Math.max(8, Math.min(24, px));
    if (size === this.term.options.fontSize) return;
    this.term.options.fontSize = size;
    activeFontSize = size;
    localStorage.setItem('swarmeye.paneFontSize', String(size));
    this.refit();
  }

  setFontWeight(weight) {
    if (weight === this.term.options.fontWeight) return;
    this.term.options.fontWeight = weight;
    this.term.options.fontWeightBold = boldFor(weight);
    this.refit(); // a heavier face can measure a hair wider
  }

  refit() {
    if (!this.el.isConnected) return;
    this.bufferTextCache = null; // a resize reflows/rewraps the buffer
    try {
      this.fit.fit();
      if (!this.exited) {
        this.handlers.onResize(this, this.term.cols, this.term.rows);
      }
    } catch { /* pane momentarily hidden */ }
  }

  write(data) {
    this.bufferTextCache = null; // new output invalidates getBufferText's memo
    this.term.write(data);
    this.noteActivity();
    // keep the mode dropdown (and model chip) honest once output settles —
    // one shared buffer read feeds all four scans
    clearTimeout(this.modeTimer);
    this.modeTimer = setTimeout(() => {
      const lines = this.tailLines(30);
      this.syncMode(lines);
      this.syncModelFromBuffer(lines);
      this.syncEffortFromBuffer(lines);
      this.autoAcceptDialogs(lines);
      this.refreshPromptOptions(lines);
    }, 500);
  }

  /* detached = the attach client died but the agent lives on in tmux
   * (WSL hiccup, manual detach) — ↻ then reconnects instead of restarting */
  markExited(exitCode, detached) {
    this.exited = true;
    this.detached = !!detached;
    this.exitCode = exitCode;
    this.attention = false;
    this.working = false;
    this.awaitingPrompt = false;
    this.promptAnswerable = false;
    this.syncPromptButtons();
    if (this.stopDictation) this.stopDictation(); // agent gone — mic must not stay hot
    clearTimeout(this.idleTimer);
    clearTimeout(this.modeTimer);
    this.modeSel.disabled = true;
    this.setStatusText('');
    this.el.classList.add('exited');
    this.el.classList.toggle('detached', this.detached);
    this.badge.textContent = this.detached ? 'detached' : 'exited (' + exitCode + ')';
    this.badge.style.display = '';
    this.btnRestart.dataset.tip = this.detached ? 'Reconnect to the running agent' : DEAD_RESTART_TIP;
    this.disarmClose();
    this.syncStatus();
  }

  /* the attach client is back on the same session id — un-exit the pane */
  markReattached() {
    this.exited = false;
    this.detached = false;
    this.exitCode = null;
    this.modeSel.disabled = false;
    this.el.classList.remove('exited', 'detached');
    this.badge.style.display = 'none';
    this.btnRestart.dataset.tip = LIVE_RESTART_TIP;
    this.syncStatus();
    requestAnimationFrame(() => this.refit());
  }

  /* plain-text scrollback (for transcript export and cross-pane search).
   * Memoized: translating up to 20k scrollback lines is expensive, and the
   * global search calls this for every pane per keystroke — the cache makes
   * repeat reads free until new output (write) or a reflow (refit) lands. */
  getBufferText() {
    if (this.bufferTextCache != null) return this.bufferTextCache;
    const buf = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : '');
    }
    while (out.length && !out[out.length - 1]) out.pop();
    this.bufferTextCache = out.join('\n');
    return this.bufferTextCache;
  }

  focus() {
    document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
    this.el.classList.add('focused');
    this.clearAttention();
    this.term.focus();
    this.handlers.onFocus(this);
  }

  /* Give up this pane's GPU renderer while nobody is looking at it (app.js
   * arms this for panes in a workspace that has been off screen a while).
   * Chromium caps a page at ~16 live WebGL contexts, and every pane in every
   * workspace holds one — past that the oldest start getting killed under the
   * running app. xterm falls straight back to its DOM renderer, so the buffer,
   * the scrollback and the pty are all untouched; the only thing lost is the
   * GPU acceleration of a terminal that isn't on screen. */
  dropRenderer() {
    if (!this.webgl) return;
    try { this.webgl.dispose(); } catch { /* crashy addon */ }
    this.webgl = null;
    this.rendererDropped = true;
  }

  /* ... and take it back when the pane is on screen again. */
  restoreRenderer() {
    if (!this.rendererDropped) return;
    this.rendererDropped = false;
    if (this.exited) return;
    this.attachWebgl();
  }

  dispose() {
    this.closeBranchMenu();
    this.closeActionTray();
    if (this.stopDictation) this.stopDictation();
    clearTimeout(this.idleTimer);
    clearTimeout(this.closeArmTimer);
    clearTimeout(this.modeTimer);
    clearTimeout(this.collisionTimer);
    clearInterval(this.usageTimer);
    livePanes.delete(this);
    this.observer.disconnect();
    // the webgl addon's dispose can throw (upstream bug) — detach it first
    // and never let any teardown error keep the pane element on screen
    try { if (this.webgl) this.webgl.dispose(); } catch { /* crashy addon */ }
    this.webgl = null;
    try { this.term.dispose(); } catch { /* must not block removal */ }
    this.el.remove();
  }
}

/* app.js calls this on theme switch; new panes pick it up via the constructor,
 * existing terminals are restyled by the caller with the returned palette.
 * `overlayOn` is the "Theme background overlay" option — with it off the panes
 * are dark whatever the theme, which flips the backdrop the light themes'
 * palettes have to read against (see the readability pass above). */
Pane.setXtermTheme = (name, overlayOn = true) => {
  const base = XTERM_THEMES[name] || XTERM_THEMES.dark;
  if (!LIGHT_THEMES.has(name)) {
    activeXtermTheme = glassTheme(base);
    activeMinContrast = 1;
    return activeXtermTheme;
  }
  activeXtermTheme = glassTheme(base, overlayOn ? LIGHT_PANE_BG[name] : FLAT_PANE_BG);
  activeMinContrast = MIN_CONTRAST;
  return activeXtermTheme;
};
/* the caller pushes this to already-open panes alongside the palette */
Pane.getMinContrast = () => activeMinContrast;

/* app.js's Options-panel "Agent pane text size" control reads/writes the same
 * default new panes start at (and that MOD+/- / the pane buttons update);
 * the caller is responsible for pushing the result to already-open panes */
Pane.DEFAULT_FONT_SIZE = DEFAULT_FONT_SIZE;
Pane.getDefaultFontSize = () => activeFontSize;
Pane.setDefaultFontSize = (px) => {
  const size = Math.max(8, Math.min(24, Math.round(px)));
  activeFontSize = size;
  localStorage.setItem('swarmeye.paneFontSize', String(size));
  return size;
};

/* and the same for "Agent pane text weight" — no keyboard path, so the option
 * is the only writer; the caller pushes the result to already-open panes */
Pane.DEFAULT_FONT_WEIGHT = DEFAULT_FONT_WEIGHT;
Pane.getDefaultFontWeight = () => activeFontWeight;
Pane.setDefaultFontWeight = (weight) => {
  const w = Math.max(300, Math.min(600, Math.round(weight / 100) * 100));
  activeFontWeight = w;
  localStorage.setItem('swarmeye.paneFontWeight', String(w));
  return w;
};

/* app.js's Options-panel "Show last command in pane header" checkbox owns
 * persistence; this just flips the flag every pane's syncInitialCommandHeader
 * reads — the caller is responsible for re-syncing already-open panes */
Pane.setShowInitialCommand = (on) => { showInitialCommand = !!on; };

/* same pattern as setShowInitialCommand, for the → / ↓ split buttons */
Pane.setAutoOrganize = (on) => { autoOrganize = !!on; };

/* and for "Fixed agent pane buttons" — on unfolds the ⋯ tray back into the
 * header cluster; the caller re-syncs already-open panes */
Pane.setFixedActions = (on) => { fixedActions = !!on; };

/* and again for "Default agent permissions: auto" — the only thing that reads
 * it here is autoAcceptDialogs, which must not stall on an IPC round trip in
 * the middle of a buffer scan */
Pane.setSkipPermissions = (on) => { skipPermissions = !!on; };

/* same pattern again, for the bottom cost & context panel — the caller
 * re-syncs already-open panes (which also refits their terminals) */
Pane.setShowUsagePanel = (on) => { showUsagePanel = !!on; };

/* app.js hands over each usage poll: the 5-hour window is what every pane's
 * "≈x% of 5h" share is measured against */
Pane.setUsageWindow = (win) => {
  usageWindow = win || null;
};

// exposed so the task board can build its starting-mode picker from the
// same single source of truth as the per-pane mode dropdown
Pane.MODES = MODES;
Pane.MODELS = MODELS;
Pane.EFFORTS = EFFORTS;

window.Pane = Pane;
