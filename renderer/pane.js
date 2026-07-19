/* Pane: one terminal card (DOM + xterm + addons). Exposes window.Pane. */

/* terminal palettes matching the app themes in tokens.css */
const XTERM_THEMES = {
  dark: {
    background: '#0c0e11',
    foreground: '#e8eaed',
    cursor: '#d6ff4b',
    cursorAccent: '#0a0b0d',
    selectionBackground: 'rgba(214, 255, 75, 0.25)',
    black: '#0a0b0d',
    red: '#ff5a5a',
    green: '#a3e635',
    yellow: '#f5b544',
    blue: '#58a6ff',
    magenta: '#a78bfa',
    cyan: '#6cd9d0',
    white: '#e8eaed',
    brightBlack: '#5b616b',
    brightRed: '#ff7a7a',
    brightGreen: '#d6ff4b',
    brightYellow: '#ffd27d',
    brightBlue: '#83bcff',
    brightMagenta: '#c4b0ff',
    brightCyan: '#93ece4',
    brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff',
    foreground: '#1b1e23',
    cursor: '#5c8a00',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(113, 168, 0, 0.25)',
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
  },
  orange: {
    background: '#0f0c09',
    foreground: '#ede9e3',
    cursor: '#ff9d2e',
    cursorAccent: '#0d0b08',
    selectionBackground: 'rgba(255, 157, 46, 0.25)',
    black: '#0d0b08',
    red: '#ff5a5a',
    green: '#a3e635',
    yellow: '#ffb04d',
    blue: '#58a6ff',
    magenta: '#a78bfa',
    cyan: '#6cd9d0',
    white: '#ede9e3',
    brightBlack: '#6a6157',
    brightRed: '#ff7a7a',
    brightGreen: '#c8f55e',
    brightYellow: '#ffc879',
    brightBlue: '#83bcff',
    brightMagenta: '#c4b0ff',
    brightCyan: '#93ece4',
    brightWhite: '#ffffff',
  },
  neo: {
    background: '#0a0814',
    foreground: '#eae7f7',
    cursor: '#9c8bea',
    cursorAccent: '#07060f',
    selectionBackground: 'rgba(156, 139, 234, 0.25)',
    black: '#07060f',
    red: '#ff3d6e',
    green: '#3dffa0',
    yellow: '#ffd166',
    blue: '#5aa2ff',
    magenta: '#ff4fd8',
    cyan: '#00e5ff',
    white: '#eae7f7',
    brightBlack: '#645e8b',
    brightRed: '#ff6b92',
    brightGreen: '#7affc0',
    brightYellow: '#ffe08a',
    brightBlue: '#86bcff',
    brightMagenta: '#ff86e4',
    brightCyan: '#4deeff',
    brightWhite: '#ffffff',
  },
  matrix: {
    background: '#050a05',
    foreground: '#c8eecb',
    cursor: '#00ff66',
    cursorAccent: '#040804',
    selectionBackground: 'rgba(0, 255, 102, 0.25)',
    black: '#040804',
    red: '#ff5a5a',
    green: '#00e05a',
    yellow: '#b8d977',
    blue: '#4dd0a0',
    magenta: '#34d399',
    cyan: '#6fe8b8',
    white: '#c8eecb',
    brightBlack: '#507c56',
    brightRed: '#ff7a7a',
    brightGreen: '#4dff8f',
    brightYellow: '#d6f0a0',
    brightBlue: '#7fe6c0',
    brightMagenta: '#6ee7b7',
    brightCyan: '#9df5cf',
    brightWhite: '#eafff0',
  },
  crimson: {
    background: '#100809',
    foreground: '#f2e6e7',
    cursor: '#ff3b5c',
    cursorAccent: '#0f0708',
    selectionBackground: 'rgba(255, 59, 92, 0.25)',
    black: '#0f0708',
    red: '#ff5a5a',
    green: '#a3e635',
    yellow: '#f5b544',
    blue: '#58a6ff',
    magenta: '#ff6b8a',
    cyan: '#6cd9d0',
    white: '#f2e6e7',
    brightBlack: '#785a5c',
    brightRed: '#ff7a7a',
    brightGreen: '#d6ff4b',
    brightYellow: '#ffd27d',
    brightBlue: '#83bcff',
    brightMagenta: '#ff8fa3',
    brightCyan: '#93ece4',
    brightWhite: '#ffffff',
  },
  ocean: {
    background: '#070b10',
    foreground: '#e3edf2',
    cursor: '#22c3ee',
    cursorAccent: '#06090d',
    selectionBackground: 'rgba(34, 195, 238, 0.25)',
    black: '#06090d',
    red: '#ff5a5a',
    green: '#a3e635',
    yellow: '#f5b544',
    blue: '#38bdf8',
    magenta: '#a78bfa',
    cyan: '#22c3ee',
    white: '#e3edf2',
    brightBlack: '#566d78',
    brightRed: '#ff7a7a',
    brightGreen: '#d6ff4b',
    brightYellow: '#ffd27d',
    brightBlue: '#7dd3fc',
    brightMagenta: '#c4b0ff',
    brightCyan: '#4fd4f5',
    brightWhite: '#ffffff',
  },
  mono: {
    background: '#0b0b0b',
    foreground: '#eaeaea',
    cursor: '#e5e5e5',
    cursorAccent: '#0a0a0a',
    selectionBackground: 'rgba(255, 255, 255, 0.2)',
    black: '#0a0a0a',
    red: '#ff5a5a',
    green: '#a3e635',
    yellow: '#f5b544',
    blue: '#58a6ff',
    magenta: '#a78bfa',
    cyan: '#6cd9d0',
    white: '#eaeaea',
    brightBlack: '#656565',
    brightRed: '#ff7a7a',
    brightGreen: '#c8f55e',
    brightYellow: '#ffd27d',
    brightBlue: '#83bcff',
    brightMagenta: '#c4b0ff',
    brightCyan: '#93ece4',
    brightWhite: '#ffffff',
  },
  sepia: {
    background: '#fbf6ea',
    foreground: '#2b2015',
    cursor: '#6e4211',
    cursorAccent: '#fbf6ea',
    selectionBackground: 'rgba(138, 84, 22, 0.25)',
    black: '#2b2015',
    red: '#a52f22',
    green: '#5c7a29',
    yellow: '#8a6508',
    blue: '#2f5f8f',
    magenta: '#6f4a8c',
    cyan: '#3d8a86',
    white: '#e8dcc4',
    brightBlack: '#7d6c50',
    brightRed: '#c34d40',
    brightGreen: '#7a9c3f',
    brightYellow: '#a88326',
    brightBlue: '#4d7dad',
    brightMagenta: '#8d68aa',
    brightCyan: '#57a8a3',
    brightWhite: '#fbf6ea',
  },
  system: {
    background: '#0c0e11',
    foreground: '#e8eaed',
    cursor: '#d6ff4b',
    cursorAccent: '#0a0b0d',
    selectionBackground: 'rgba(214, 255, 75, 0.25)',
    black: '#0a0b0d',
    red: '#ff5a5a',
    green: '#a3e635',
    yellow: '#f5b544',
    blue: '#58a6ff',
    magenta: '#a78bfa',
    cyan: '#6cd9d0',
    white: '#e8eaed',
    brightBlack: '#5b616b',
    brightRed: '#ff7a7a',
    brightGreen: '#d6ff4b',
    brightYellow: '#ffd27d',
    brightBlue: '#83bcff',
    brightMagenta: '#c4b0ff',
    brightCyan: '#93ece4',
    brightWhite: '#ffffff',
  },
  tokyonight: {
    background: '#13141c',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: 'rgba(122, 162, 247, 0.25)',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  everforest: {
    background: '#252c30',
    foreground: '#d3c6aa',
    cursor: '#a7c080',
    cursorAccent: '#2b3339',
    selectionBackground: 'rgba(167, 192, 128, 0.25)',
    black: '#414b50',
    red: '#e67e80',
    green: '#a7c080',
    yellow: '#dbbc7f',
    blue: '#7fbbb3',
    magenta: '#d699b6',
    cyan: '#83c092',
    white: '#d3c6aa',
    brightBlack: '#859289',
    brightRed: '#f85552',
    brightGreen: '#a7c080',
    brightYellow: '#dbbc7f',
    brightBlue: '#7fbbb3',
    brightMagenta: '#d699b6',
    brightCyan: '#83c092',
    brightWhite: '#fdf6e3',
  },
  ayu: {
    background: '#080b10',
    foreground: '#bfbdb6',
    cursor: '#ffb454',
    cursorAccent: '#0a0e14',
    selectionBackground: 'rgba(255, 180, 84, 0.25)',
    black: '#0a0e14',
    red: '#f28779',
    green: '#91b362',
    yellow: '#ffd580',
    blue: '#59c2ff',
    magenta: '#d2a6ff',
    cyan: '#39bae6',
    white: '#bfbdb6',
    brightBlack: '#565e66',
    brightRed: '#f28779',
    brightGreen: '#91b362',
    brightYellow: '#ffb454',
    brightBlue: '#59c2ff',
    brightMagenta: '#d2a6ff',
    brightCyan: '#95e6cb',
    brightWhite: '#e6e1cf',
  },
  catppuccin: {
    background: '#161622',
    foreground: '#cdd6f4',
    cursor: '#cba6f7',
    cursorAccent: '#1e1e2e',
    selectionBackground: 'rgba(203, 166, 247, 0.25)',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  'catppuccin-macchiato': {
    background: '#1c1e2e',
    foreground: '#cad3f5',
    cursor: '#c6a0f6',
    cursorAccent: '#24273a',
    selectionBackground: 'rgba(198, 160, 246, 0.25)',
    black: '#494d64',
    red: '#ed8796',
    green: '#a6da95',
    yellow: '#eed49f',
    blue: '#8aadf4',
    magenta: '#f5bde6',
    cyan: '#8bd5ca',
    white: '#b8c0e0',
    brightBlack: '#5b6078',
    brightRed: '#ed8796',
    brightGreen: '#a6da95',
    brightYellow: '#eed49f',
    brightBlue: '#8aadf4',
    brightMagenta: '#f5bde6',
    brightCyan: '#8bd5ca',
    brightWhite: '#a5adcb',
  },
  gruvbox: {
    background: '#1a1a1a',
    foreground: '#ebdbb2',
    cursor: '#fabd2f',
    cursorAccent: '#282828',
    selectionBackground: 'rgba(250, 189, 47, 0.25)',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  kanagawa: {
    background: '#181820',
    foreground: '#dcd7ba',
    cursor: '#7e9cd8',
    cursorAccent: '#1f1f28',
    selectionBackground: 'rgba(126, 156, 216, 0.25)',
    black: '#1f1f28',
    red: '#c34043',
    green: '#76946a',
    yellow: '#c0a36e',
    blue: '#7e9cd8',
    magenta: '#957fb8',
    cyan: '#6a9589',
    white: '#c8c093',
    brightBlack: '#727169',
    brightRed: '#e82424',
    brightGreen: '#98bb6c',
    brightYellow: '#e6c384',
    brightBlue: '#7fb4ca',
    brightMagenta: '#938aa9',
    brightCyan: '#7aa89f',
    brightWhite: '#dcd7ba',
  },
  nord: {
    background: '#242933',
    foreground: '#eceff4',
    cursor: '#88c0d0',
    cursorAccent: '#2e3440',
    selectionBackground: 'rgba(136, 192, 208, 0.25)',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  'one-dark': {
    background: '#1e2127',
    foreground: '#abb2bf',
    cursor: '#61afef',
    cursorAccent: '#282c34',
    selectionBackground: 'rgba(97, 175, 239, 0.25)',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
};
/* the canvas is transparent so the pane's glass (blur + tint, see .pane /
 * .pane-term in app.css) shows through behind the text — the per-theme
 * terminal tint comes from the CSS var(--term-bg) mix, not the palette */
function glassTheme(palette) {
  return { ...palette, background: 'rgba(0, 0, 0, 0)' };
}
let activeXtermTheme = glassTheme(XTERM_THEMES.dark);

const DEFAULT_FONT_SIZE = 13;
// last font size the user picked (MOD+/- or the pane buttons) — persists
// across restarts so reopened agent panes come back at the same text size
let activeFontSize = Number(localStorage.getItem('swarmeye.paneFontSize')) || DEFAULT_FONT_SIZE;

// "Show initial command in pane header" option in ⌨ Options — off by default;
// app.js owns persistence, this just gates whether syncInitialCommandHeader
// reveals the row it fills in on every pane
let showInitialCommand = false;

// "Auto-organize agent windows" option in ⌨ Options — on by default; when off,
// the → / ↓ split buttons are how the user places new agents themselves, so
// they only make sense to show while auto-organize is off
let autoOrganize = true;
const IDLE_AFTER_MS = 2500;
// output arriving this soon after a keystroke/mouse report is its echo, not
// the agent working — typing or clicking must not light the busy indicator
const INPUT_ECHO_MS = 400;

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
   * @param {object} session {id, num, agentName, workspaceName, cwd, persistent}
   * @param {object} handlers {onClose, onMaximize, onResize, onRename,
   *                           onRestart, onFocus, onStatusChange, onShortcut, onSplit}
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
    this.lastInputAt = 0; // last keystroke/mouse report — its echo must not read as agent activity
    this.idleTimer = null;
    this.closeArmTimer = null;
    this.bufferTextCache = null; // memoized getBufferText result

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

    this.llmEl = document.createElement('span');
    this.llmEl.className = 'pane-llm';
    this.llmEl.style.display = 'none';

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

    this.badge = document.createElement('span');
    this.badge.className = 'pane-badge';
    this.badge.style.display = 'none';

    this.btnRestart = document.createElement('button');
    this.btnRestart.className = 'pane-btn restart';
    this.btnRestart.dataset.tip = 'Restart & continue last conversation (shift-click: fresh session)';
    this.btnRestart.textContent = '↻';
    this.btnRestart.style.display = 'none';
    this.btnRestart.addEventListener('click', (e) => handlers.onRestart(this, { resume: !e.shiftKey }));

    const btnExport = document.createElement('button');
    btnExport.className = 'pane-btn export';
    btnExport.dataset.tip = 'Save transcript to a file';
    btnExport.textContent = '⤓';
    btnExport.addEventListener('click', () => handlers.onExport(this));

    const btnSearch = document.createElement('button');
    btnSearch.className = 'pane-btn search';
    btnSearch.dataset.tip = 'Search (Ctrl+Shift+F)';
    btnSearch.textContent = '⌕';
    btnSearch.addEventListener('click', () => this.toggleSearch());

    const btnMic = document.createElement('button');
    btnMic.className = 'pane-btn mic';
    btnMic.dataset.tip = 'Dictate (click to start/stop)';
    btnMic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>';
    if (!window.Speech || !window.Speech.supported) {
      btnMic.style.display = 'none';
    } else {
      let dictating = false;
      // closing the pane mid-dictation must release the mic (see dispose)
      this.stopDictation = () => { if (dictating) window.Speech.stop(); };
      btnMic.addEventListener('click', () => {
        if (dictating) { window.Speech.stop(); return; }
        dictating = true;
        btnMic.classList.add('listening');
        window.Speech.start({
          interim: false,
          onResult: (text) => { if (text) this.term.paste(text + ' '); },
          onEnd: () => { dictating = false; btnMic.classList.remove('listening'); },
          onError: (err) => {
            dictating = false;
            btnMic.classList.remove('listening');
            if (err === 'not-allowed' || err === 'service-not-allowed') toast('microphone permission denied');
            else if (err === 'not-installed') toast('dictation engine not installed — install it in ⌨ Options');
          },
        });
      });
    }

    const btnFontDown = document.createElement('button');
    btnFontDown.className = 'pane-btn font-down';
    btnFontDown.dataset.tip = 'Smaller text';
    btnFontDown.textContent = '−';
    btnFontDown.addEventListener('click', () => this.setFontSize(this.term.options.fontSize - 1));

    const btnFontUp = document.createElement('button');
    btnFontUp.className = 'pane-btn font-up';
    btnFontUp.dataset.tip = 'Larger text';
    btnFontUp.textContent = '+';
    btnFontUp.addEventListener('click', () => this.setFontSize(this.term.options.fontSize + 1));

    const btnMax = document.createElement('button');
    btnMax.className = 'pane-btn max';
    btnMax.dataset.tip = 'Maximize / restore (Ctrl+Shift+M)';
    btnMax.textContent = '⛶';
    btnMax.addEventListener('click', () => handlers.onMaximize(this));

    this.btnSplitRight = document.createElement('button');
    this.btnSplitRight.className = 'pane-btn split-right';
    this.btnSplitRight.dataset.tip = 'Open a new agent to the right';
    this.btnSplitRight.textContent = '→';
    this.btnSplitRight.addEventListener('click', () => handlers.onSplit(this, 'right'));

    this.btnSplitDown = document.createElement('button');
    this.btnSplitDown.className = 'pane-btn split-down';
    this.btnSplitDown.dataset.tip = 'Open a new agent below';
    this.btnSplitDown.textContent = '↓';
    this.btnSplitDown.addEventListener('click', () => handlers.onSplit(this, 'down'));
    this.syncSplitButtons();

    this.btnClose = document.createElement('button');
    this.btnClose.className = 'pane-btn close';
    this.btnClose.dataset.tip = 'Close session';
    this.btnClose.textContent = '✕';
    // mousedown, not click: a click needs down+up on the same element and
    // can get eaten by focus/layout churn in between — mousedown cannot
    this.btnClose.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // killing a pane shouldn't also focus it
      e.preventDefault();
      this.requestClose();
    });

    header.append(
      this.dot, this.taskEl, this.llmEl, this.gitEl, this.titleEl, this.statusEl, this.busyEl, this.modeSel, this.badge,
      this.btnRestart, btnExport, btnSearch, btnMic, btnFontDown, btnFontUp, btnMax, this.btnSplitRight, this.btnSplitDown, this.btnClose
    );

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

    // second header row, under the main one — the initial command a
    // task-started agent was given, or (for a manually-added one) the first
    // line the user types and submits; hidden unless both the option is on
    // and there is a command to show
    this.subheaderEl = document.createElement('div');
    this.subheaderEl.className = 'pane-subheader';
    this.subheaderEl.style.display = 'none';
    const subheaderBar = document.createElement('span');
    subheaderBar.className = 'pane-subheader-bar';
    this.subheaderTextEl = document.createElement('span');
    this.subheaderTextEl.className = 'pane-subheader-text';
    this.subheaderEl.append(subheaderBar, this.subheaderTextEl);
    this.initialCommandText = '';
    this.typedInitialCommand = null;
    this.typedLineBuffer = '';
    this.typedCaptureDone = false;

    this.termEl = document.createElement('div');
    this.termEl.className = 'pane-term';

    this.el.append(header, this.subheaderEl, this.searchEl, this.termEl);
    this.syncInitialCommandHeader();

    this.term = new Terminal({
      theme: activeXtermTheme,
      allowTransparency: true, // glass panes: the canvas bg is transparent, CSS tints it
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: activeFontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      // a completed task's transcript popup reads straight from this buffer
      // (see getBufferText below) — too small a cap silently evicts the
      // start of a long session before it ever gets captured
      scrollback: 20000,
      allowProposedApi: true,
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

    this.term.open(this.termEl);

    // GPU renderer; falls back to the DOM renderer on failure/context loss
    this.webgl = null;
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch { /* already gone */ }
        this.webgl = null;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch { /* DOM renderer it is */ }

    // attention: terminal bell, plus OSC 9 / OSC 777 desktop-notification sequences
    this.term.onBell(() => this.flagAttention());
    this.term.parser.registerOscHandler(9, () => { this.flagAttention(); return true; });
    this.term.parser.registerOscHandler(777, () => { this.flagAttention(); return true; });

    // shortcuts are executed by the document-level handler; returning false
    // here just keeps xterm from also acting on the keystroke
    this.term.attachCustomKeyEventHandler((e) => !handlers.onShortcut(e));

    this.term.onData((data) => {
      if (this.exited) return;
      this.lastInputAt = Date.now();
      this.clearAttention();
      this.captureInitialCommand(data);
      window.swarm.writeSession(session.id, data);
    });

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
  }

  flagAttention() {
    if (this.exited) return;
    // no attention for output the user is already looking at
    if (this.el.classList.contains('focused') && document.hasFocus()) return;
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
    this.statusEl.textContent = text || '';
    this.statusEl.style.display = text ? '' : 'none';
  }

  applyHookEvent({ event, tool, message, model }) {
    if (this.exited) return;
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
      this.setStatusText('');
    } else if (event === 'PreToolUse') {
      this.working = true;
      this.setStatusText(tool === 'Bash' ? 'vibing...' : (tool || ''));
    } else if (event === 'Notification') {
      // claude is blocked on the user (permission prompt / waiting for input)
      this.working = false;
      this.setStatusText(message || 'waiting for you');
      this.flagAttention();
    } else if (event === 'Stop') {
      this.working = false;
      this.setStatusText('done');
      this.flagAttention();
      // completion must reach app.js even when flagAttention suppresses its
      // event (pane focused and watched, or attention already flagged) — a
      // board task's completion handling hangs off this dedicated status
      this.handlers.onStatusChange(this, 'done');
    }
    this.syncStatus();
    if (wasWorking !== this.working) {
      this.handlers.onStatusChange(this, this.working ? 'working' : 'idle');
    }
  }

  /* ---- model chip ---- */

  setModel(label) {
    if (!label) return;
    this.llmEl.textContent = label;
    this.llmEl.dataset.tip = 'Claude model for this agent';
    this.llmEl.style.display = '';
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

  /* First-run "Do you trust the files in this folder?" dialog is a separate
   * trust boundary that --dangerously-skip-permissions does NOT suppress, so
   * with auto mode on it still stalls the session waiting for a human. Claude
   * pre-highlights "1. Yes, proceed", so accepting it is just pressing Enter —
   * same mechanism tryInjectPrompt (app.js) uses to submit the initial task. */
  async checkAutoTrust(lines = this.tailLines(30)) {
    return this._autoAccept(lines, /do you trust the files in this folder/i, 'trustDialogHandled');
  }

  /* Both dialogs pre-highlight the accepting option, so accepting is just
   * pressing Enter — the same mechanism tryInjectPrompt (app.js) uses to
   * submit an initial task. Each fires at most once per pane. */
  async _autoAccept(lines, re, flag) {
    if (this.exited || this[flag]) return;
    if (!re.test(lines.join('\n'))) return;
    this[flag] = true;
    const cfg = await window.swarm.getConfig();
    if (cfg.skipPermissions) window.swarm.writeSession(this.session.id, '\r');
  }

  /* Machine-local, one-time-ever "WARNING: Claude Code running in Bypass
   * Permissions mode" dialog (separate from the per-folder trust dialog
   * above) — claude shows this the first time a user ever enters bypass
   * mode on this machine, and remembers acceptance after that. Auto-accept
   * it ("Yes, I accept" is pre-highlighted, so Enter submits) the same way
   * checkAutoTrust does, so opting into auto mode never stalls an agent
   * waiting on a human the user explicitly asked to skip. */
  async checkBypassWarning(lines = this.tailLines(30)) {
    return this._autoAccept(lines, /running in Bypass Permissions mode/i, 'bypassDialogHandled');
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
      : `branch ${info.branch} — clean`) + ' · click to switch branch';
  }

  /* Click on the git chip: fetch the repo's branches (local + remote, see
   * main/git.js listBranches) and offer them in a small popover. Picking one
   * runs `git checkout` in the workspace; the chip updates via the git:update
   * push that follows. */
  async openBranchMenu() {
    if (this.branchMenuEl) { this.closeBranchMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'branch-menu';
    menu.textContent = 'fetching branches…';
    // fixed-position (the pane clips overflow), anchored under the chip
    const r = this.gitEl.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    document.body.appendChild(menu);
    this.branchMenuEl = menu;
    this._branchDismiss = (e) => {
      if (!menu.contains(e.target) && e.target !== this.gitEl) this.closeBranchMenu();
    };
    document.addEventListener('mousedown', this._branchDismiss, true);

    const branches = await window.swarm.listBranches(this.session.workspaceId);
    if (this.branchMenuEl !== menu) return; // dismissed while the fetch ran
    if (!branches || !branches.length) {
      menu.textContent = 'no branches found';
      return;
    }
    const current = this.gitInfo && this.gitInfo.branch;
    menu.textContent = '';
    for (const b of branches) {
      const row = document.createElement('button');
      row.className = 'branch-item' + (b === current ? ' current' : '');
      row.textContent = b;
      if (b !== current) row.addEventListener('click', () => this.pickBranch(b));
      menu.appendChild(row);
    }

    // "+ new branch…" swaps itself for an input; Enter runs checkout -b
    const divider = document.createElement('div');
    divider.className = 'branch-menu-divider';
    menu.appendChild(divider);
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
    menu.appendChild(add);
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
   * dialog is eating keys) walk on back to where we started. */
  async setMode(target) {
    if (this.exited || this.modeBusy) return;
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
        if (window.toast) {
          toast(target === 'bypass'
            ? 'auto mode is off in this agent — enable it in ⌨ Options, then restart the agent'
            : 'could not switch mode — is claude showing a dialog?');
        }
      }
      this.modeSel.value = mode;
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

  /* ---- initial-command header row ----
   * A task-started pane already has its prompt tracked in app.js (same
   * source as the tooltip above, getPaneInitialPrompt) — that always wins.
   * A manually-added pane has no such record, so its "initial command" is
   * reconstructed from the user's own first keystrokes instead: best-effort,
   * since raw terminal input includes backspaces, arrow keys and pastes, but
   * good enough for the common case of typing (or pasting) one message and
   * hitting Enter. */
  captureInitialCommand(data) {
    if (this.typedCaptureDone) return;
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
        this.typedCaptureDone = true;
        this.typedInitialCommand = line;
        this.syncInitialCommandHeader();
        return;
      }
      if (ch === '\x7f' || ch === '\b') { this.typedLineBuffer = this.typedLineBuffer.slice(0, -1); continue; }
      if (ch.charCodeAt(0) < 0x20) continue; // other control bytes
      this.typedLineBuffer += ch;
    }
  }

  /* Called explicitly by app.js whenever a task's prompt text becomes known
   * (task start) or the option is toggled — no point polling for a value
   * that only changes at those two moments; captureInitialCommand above
   * calls it directly the moment the user's own first line is captured. */
  syncInitialCommandHeader() {
    const prompt = this.handlers.getPaneInitialPrompt && this.handlers.getPaneInitialPrompt(this.session.id);
    this.initialCommandText = prompt || this.typedInitialCommand || '';
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
      this.checkAutoTrust(lines);
      this.checkBypassWarning(lines);
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
    if (this.stopDictation) this.stopDictation(); // agent gone — mic must not stay hot
    clearTimeout(this.idleTimer);
    clearTimeout(this.modeTimer);
    this.modeSel.disabled = true;
    this.setStatusText('');
    this.el.classList.add('exited');
    this.el.classList.toggle('detached', this.detached);
    this.badge.textContent = this.detached ? 'detached' : 'exited (' + exitCode + ')';
    this.badge.style.display = '';
    this.btnRestart.dataset.tip = this.detached
      ? 'Reconnect to the running agent'
      : 'Restart & continue last conversation (shift-click: fresh session)';
    this.btnRestart.style.display = '';
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
    this.btnRestart.style.display = 'none';
    this.btnRestart.dataset.tip = 'Restart & continue last conversation (shift-click: fresh session)';
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

  dispose() {
    this.closeBranchMenu();
    if (this.stopDictation) this.stopDictation();
    clearTimeout(this.idleTimer);
    clearTimeout(this.closeArmTimer);
    clearTimeout(this.modeTimer);
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
 * existing terminals are restyled by the caller with the returned palette */
Pane.setXtermTheme = (name) => {
  activeXtermTheme = glassTheme(XTERM_THEMES[name] || XTERM_THEMES.dark);
  return activeXtermTheme;
};

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

/* app.js's Options-panel "Show initial command in pane header" checkbox owns
 * persistence; this just flips the flag every pane's syncInitialCommandHeader
 * reads — the caller is responsible for re-syncing already-open panes */
Pane.setShowInitialCommand = (on) => { showInitialCommand = !!on; };

/* same pattern as setShowInitialCommand, for the → / ↓ split buttons */
Pane.setAutoOrganize = (on) => { autoOrganize = !!on; };

// exposed so the task board can build its starting-mode picker from the
// same single source of truth as the per-pane mode dropdown
Pane.MODES = MODES;
Pane.MODELS = MODELS;
Pane.EFFORTS = EFFORTS;

window.Pane = Pane;
