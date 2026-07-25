/* Pane: one terminal card (DOM + xterm + addons). Exposes window.Pane. */

/* terminal palettes matching the app themes in tokens.css.
 *
 * The five SwarmEye-native dark themes (dark/orange/crimson/ocean/mono) are
 * one house ANSI ramp re-tinted: each spreads ANSI_RAMP and then overrides
 * only the hues that carry its identity — ocean pulls blue/cyan toward its
 * accent, crimson does the same for magenta, and so on. Every field below a
 * `...ANSI_RAMP` is therefore a deliberate difference from the house ramp,
 * not an incidental copy. The ported third-party themes (tokyonight, nord,
 * gruvbox, …) and the light ones each ship a complete ramp of their own and
 * stay spelled out in full. */
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

/* the same idea for the light-backdrop themes added after light/sepia: one
 * ramp darkened for a white page, which each theme re-tints only where its
 * accent hue lives. The readability pass below still runs on top. */
const LIGHT_RAMP = {
  red: '#d92f2f',
  green: '#4d7c0f',
  yellow: '#c07c00',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  brightRed: '#ef4444',
  brightGreen: '#65a30d',
  brightYellow: '#d97706',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#0891b2',
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
    white: '#ede9e3',
    brightBlack: '#6a6157',
    brightWhite: '#ffffff',
    ...ANSI_RAMP,
    yellow: '#ffb04d',
    brightGreen: '#c8f55e',
    brightYellow: '#ffc879',
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
    white: '#f2e6e7',
    brightBlack: '#785a5c',
    brightWhite: '#ffffff',
    ...ANSI_RAMP,
    magenta: '#ff6b8a',
    brightMagenta: '#ff8fa3',
  },
  ocean: {
    background: '#070b10',
    foreground: '#e3edf2',
    cursor: '#22c3ee',
    cursorAccent: '#06090d',
    selectionBackground: 'rgba(34, 195, 238, 0.25)',
    black: '#06090d',
    white: '#e3edf2',
    brightBlack: '#566d78',
    brightWhite: '#ffffff',
    ...ANSI_RAMP,
    blue: '#38bdf8',
    cyan: '#22c3ee',
    brightBlue: '#7dd3fc',
    brightCyan: '#4fd4f5',
  },
  mono: {
    background: '#0b0b0b',
    foreground: '#eaeaea',
    cursor: '#e5e5e5',
    cursorAccent: '#0a0a0a',
    selectionBackground: 'rgba(255, 255, 255, 0.2)',
    black: '#0a0a0a',
    white: '#eaeaea',
    brightBlack: '#656565',
    brightWhite: '#ffffff',
    ...ANSI_RAMP,
    brightGreen: '#c8f55e',
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
    white: '#2b2015',
    brightBlack: '#7d6c50',
    brightRed: '#c34d40',
    brightGreen: '#7a9c3f',
    brightYellow: '#a88326',
    brightBlue: '#4d7dad',
    brightMagenta: '#8d68aa',
    brightCyan: '#57a8a3',
    brightWhite: '#1a1208',
  },
  // 'system' deliberately has no entry: its palette was a byte-for-byte copy
  // of dark, and setXtermTheme's `XTERM_THEMES[name] || XTERM_THEMES.dark`
  // fallback already resolves it to exactly that.
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
  paper: {
    background: '#ffffff',
    foreground: '#17181a',
    cursor: '#111827',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(31, 41, 55, 0.2)',
    black: '#17181a',
    white: '#e5e7eb',
    brightBlack: '#6a6d72',
    brightWhite: '#f9fafb',
    ...LIGHT_RAMP,
  },
  frost: {
    background: '#ffffff',
    foreground: '#10262c',
    cursor: '#0a6577',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(13, 127, 149, 0.22)',
    black: '#10262c',
    white: '#e2ebee',
    brightBlack: '#5e7880',
    brightWhite: '#f6fafb',
    ...LIGHT_RAMP,
    blue: '#0369a1',
    cyan: '#0d7f95',
    brightBlue: '#0284c7',
    brightCyan: '#0f97b0',
  },
  blossom: {
    background: '#fffdfd',
    foreground: '#241619',
    cursor: '#9d1543',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(190, 29, 81, 0.2)',
    black: '#241619',
    white: '#eee1e4',
    brightBlack: '#766068',
    brightWhite: '#fbf5f6',
    ...LIGHT_RAMP,
    magenta: '#be1d51',
    brightMagenta: '#d94070',
  },
  ash: {
    background: '#f2f2f4',
    foreground: '#1c1c1f',
    cursor: '#86490a',
    cursorAccent: '#e8e8ea',
    selectionBackground: 'rgba(163, 90, 9, 0.22)',
    black: '#1c1c1f',
    white: '#dcdcde',
    brightBlack: '#63636b',
    brightWhite: '#f6f6f8',
    ...LIGHT_RAMP,
    yellow: '#a35a09',
    brightYellow: '#c06e0d',
  },
  slate: {
    background: '#f0f3f7',
    foreground: '#171c23',
    cursor: '#1739a8',
    cursorAccent: '#e3e7ec',
    selectionBackground: 'rgba(29, 78, 216, 0.2)',
    black: '#171c23',
    white: '#d5dae1',
    brightBlack: '#5d6675',
    brightWhite: '#f5f7fa',
    ...LIGHT_RAMP,
    blue: '#1d4ed8',
    brightBlue: '#3b6ae8',
  },
  fog: {
    background: '#f2f6f3',
    foreground: '#16201a',
    cursor: '#116430',
    cursorAccent: '#e6ebe7',
    selectionBackground: 'rgba(21, 128, 61, 0.2)',
    black: '#16201a',
    white: '#d9dedb',
    brightBlack: '#5c6a61',
    brightWhite: '#f6faf7',
    ...LIGHT_RAMP,
    green: '#15803d',
    brightGreen: '#1f9c4d',
  },
  zinc: {
    background: '#f3f1f5',
    foreground: '#1c1a20',
    cursor: '#5a1eb5',
    cursorAccent: '#e8e6ea',
    selectionBackground: 'rgba(109, 40, 217, 0.2)',
    black: '#1c1a20',
    white: '#dbd9dd',
    brightBlack: '#64606d',
    brightWhite: '#f7f5f9',
    ...LIGHT_RAMP,
    magenta: '#6d28d9',
  },
};
/* the canvas is transparent so the pane's glass (blur + tint, see .pane /
 * .pane-term in app.css) shows through behind the text — the per-theme
 * terminal tint comes from the CSS var(--term-bg) mix, not the palette */
function glassTheme(palette) {
  return { ...palette, background: 'rgba(0, 0, 0, 0)' };
}

/* ---- readability pass for the light-background themes ----
 *
 * Two problems the palettes above cannot fix on their own, both only hitting
 * the themes whose panes are near-white:
 *
 *  - agents assume a dark terminal. Claude Code's TUI paints its text in
 *    whites and pale greys, and sends most of them as *256-colour indices*
 *    (TERM=xterm-256color, so chalk drops to the fixed 16–255 table) — colours
 *    no palette entry covers, and invisible on a white pane. This is the
 *    "text sometimes unreadable in Light" report.
 *  - with "Theme background overlay" off, app.css pins every pane dark, so
 *    those same themes would draw their near-black text on black.
 *
 * Both are one job: push a colour away from the backdrop it will actually be
 * drawn on until it clears a readable contrast ratio, and leave everything
 * that already clears it untouched. Blending keeps the hue, so a red stays
 * red — it just stops being pale.
 */
/* must match the overlay-off selector list in app.css */
const LIGHT_THEMES = new Set([
  'light', 'sepia', 'paper', 'frost', 'blossom', 'ash', 'slate', 'fog', 'zinc',
]);
/* What .pane-term resolves to for each of them — term-bg at 45% over the pane's
 * 55% surface over --bg (see app.css). The contrast maths needs the real
 * backdrop, not the palette's nominal `background`, which glassTheme drops. */
const LIGHT_PANE_BG = {
  light: '#f8f9fb',
  sepia: '#f8f2e6',
  paper: '#fefefe',
  frost: '#fdfefe',
  blossom: '#fffcfd',
  ash: '#eaeaec',
  slate: '#e5e9ee',
  fog: '#e8ede9',
  zinc: '#eae8ec',
};
/* and what app.css pins that same stack to while the overlay is off */
const FLAT_PANE_BG = '#0b0d10';

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbHex(rgb) {
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}
function luminance([r, g, b]) {
  const lin = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/* walk `hex` toward black (light backdrop) or white (dark one) until it reads
 * at `min`:1 against it */
function readable(hex, bgLum, min) {
  const rgb = hexRgb(hex);
  if (contrast(luminance(rgb), bgLum) >= min) return hex;
  const toward = bgLum > 0.4 ? 0 : 255;
  for (let t = 0.05; t < 1; t += 0.05) {
    const step = rgb.map((c) => c + (toward - c) * t);
    if (contrast(luminance(step), bgLum) >= min) return rgbHex(step);
  }
  return toward ? '#ffffff' : '#000000';
}

// palette keys painted *behind* text rather than as text: forcing contrast on
// them would fight the very thing it is trying to fix
const BACKDROP_KEYS = new Set(['background', 'cursorAccent', 'selectionBackground']);
// body text earns AAA; the rest of the ramp is decoration, AA is enough
const BODY_KEYS = new Set(['foreground', 'white', 'brightWhite']);

function readablePalette(palette, bgHex) {
  const bgLum = luminance(hexRgb(bgHex));
  const out = {};
  for (const [key, value] of Object.entries(palette)) {
    out[key] = BACKDROP_KEYS.has(key) ? value : readable(value, bgLum, BODY_KEYS.has(key) ? 7 : 4.5);
  }
  return out;
}

/* xterm's fixed 16–255 colours: a 6×6×6 cube, then a 24-step grey ramp. They
 * are what an app reaches for when it wants "grey" or "white" without asking
 * the theme — exactly the ones that disappear on a light pane. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
function extendedAnsiFor(bgHex) {
  const bgLum = luminance(hexRgb(bgHex));
  const out = [];
  for (let n = 0; n < 216; n++) {
    out.push(readable(rgbHex([CUBE_LEVELS[Math.floor(n / 36)], CUBE_LEVELS[Math.floor(n / 6) % 6], CUBE_LEVELS[n % 6]]), bgLum, 4.5));
  }
  for (let i = 0; i < 24; i++) out.push(readable(rgbHex([8 + i * 10, 8 + i * 10, 8 + i * 10]), bgLum, 4.5));
  return out;
}

let activeXtermTheme = glassTheme(XTERM_THEMES.dark);

const DEFAULT_FONT_SIZE = 13;
// last font size the user picked (MOD+/- or the pane buttons) — persists
// across restarts so reopened agent panes come back at the same text size
let activeFontSize = Number(localStorage.getItem('swarmeye.paneFontSize')) || DEFAULT_FONT_SIZE;

// "Show last command in pane header" option in ⌨ Options — off by default;
// app.js owns persistence, this just gates whether syncInitialCommandHeader
// reveals the row it fills in on every pane
let showInitialCommand = false;

// "Auto-organize agent windows" option in ⌨ Options — on by default; when off,
// the → / ↓ split buttons are how the user places new agents themselves, so
// they only make sense to show while auto-organize is off
let autoOrganize = true;

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
// how much of the tail the pane's ⧉ button copies — enough for a finished
// turn's summary or a stack trace, short enough to paste somewhere
const COPY_TAIL_LINES = 200;
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
   *                           onRestart, onToggleAutoRestart, onFocus, onStatusChange,
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

    // the model is drawn in exactly one place at a time — see syncModelChip
    this.llmEl = document.createElement('span');
    this.llmEl.className = 'pane-llm';
    this.llmEl.style.display = 'none';
    this.modelLabel = '';
    this.modelTip = 'Claude model for this agent';

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

    // pi panes: a static agent chip in the model slot (no hook events ever
    // fill it) and no mode selector — Shift+Tab mode cycling is Claude-only
    if (session.kind === 'pi') {
      this.modelLabel = 'pi';
      this.modelTip = 'Pi coding agent';
      this.modeSel.style.display = 'none';
    }
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
    this.btnApprove.textContent = '✓';
    this.btnApprove.style.display = 'none';
    this.btnApprove.addEventListener('click', (e) => {
      if (!this.respondToPrompt('yes', e.shiftKey)) toast("couldn't read the prompt — open the pane");
    });

    this.btnDeny = document.createElement('button');
    this.btnDeny.className = 'pane-btn deny';
    this.btnDeny.dataset.tip = 'Deny';
    this.btnDeny.textContent = '✕';
    this.btnDeny.style.display = 'none';
    this.btnDeny.addEventListener('click', () => {
      if (!this.respondToPrompt('no', false)) toast("couldn't read the prompt — open the pane");
    });

    this.badge = document.createElement('span');
    this.badge.className = 'pane-badge';
    this.badge.style.display = 'none';

    this.btnRestart = document.createElement('button');
    this.btnRestart.className = 'pane-btn restart';
    this.btnRestart.dataset.tip = 'Restart & continue last conversation (shift-click: fresh session)';
    this.btnRestart.textContent = '↻';
    this.btnRestart.style.display = 'none';
    this.btnRestart.addEventListener('click', (e) => handlers.onRestart(this, { resume: !e.shiftKey }));

    // armed = app.js respawns this agent (continuing its conversation) if its
    // session really dies; a mere tmux detach is not a death and is left alone
    this.autoRestart = !!session.autoRestart;
    this.autoRestartTries = 0; // consecutive auto-restarts, reset once one sticks
    this.btnAutoRestart = document.createElement('button');
    this.btnAutoRestart.className = 'pane-btn auto-restart';
    this.btnAutoRestart.addEventListener('click', () => this.setAutoRestart(!this.autoRestart));
    this.syncAutoRestartButton();

    // /clear — only shown once the agent is idle (finished a turn); wipes its
    // conversation context without restarting the process. Pi has no /clear.
    this.btnClear = document.createElement('button');
    this.btnClear.className = 'pane-btn clear';
    this.btnClear.dataset.tip = "Clear this agent's context (/clear)";
    this.btnClear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20H8.5L3.6 15a1.4 1.4 0 0 1 0-2L12.8 3.8a1.4 1.4 0 0 1 2 0l5.2 5.2a1.4 1.4 0 0 1 0 2L11.5 20"/><path d="M6.5 10.5l7 7"/></svg>';
    this.btnClear.style.display = 'none';
    this.btnClear.addEventListener('click', () => {
      if (this.exited || this.session.kind === 'pi') return;
      window.swarm.writeSession(this.session.id, '/clear\r');
    });

    const btnExport = document.createElement('button');
    btnExport.className = 'pane-btn export';
    btnExport.dataset.tip = 'Save transcript to a file';
    btnExport.textContent = '⤓';
    btnExport.addEventListener('click', () => handlers.onExport(this));

    // the tail of the transcript, straight to the clipboard — the common
    // "paste what the agent just said into a message/PR" move, without
    // scrolling and drag-selecting a pane that redraws under the cursor
    const btnCopy = document.createElement('button');
    btnCopy.className = 'pane-btn copy';
    btnCopy.dataset.tip = `Copy the last ${COPY_TAIL_LINES} lines (shift-click: the whole scrollback)`;
    btnCopy.textContent = '⧉';
    btnCopy.addEventListener('click', (e) => this.copyTail(e.shiftKey));

    const btnSearch = document.createElement('button');
    btnSearch.className = 'pane-btn search';
    btnSearch.dataset.tip = 'Search (Ctrl+Shift+F)';
    btnSearch.textContent = '⌕';
    btnSearch.addEventListener('click', () => this.toggleSearch());

    const btnMic = document.createElement('button');
    btnMic.className = 'pane-btn mic';
    btnMic.dataset.tip = 'Dictate (click to start/stop, Ctrl+R)';
    btnMic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>';
    // closing the pane mid-dictation must release the mic (see dispose)
    const mic = window.Speech.wire(btnMic, {
      onResult: (text) => { if (text) this.term.paste(text + ' '); },
    });
    this.toggleDictation = mic.toggle;
    this.stopDictation = mic.stop;

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
      this.dot, this.taskEl, this.roleEl, this.llmEl, this.gitEl, this.titleEl, this.statusEl, this.busyEl, this.btnApprove, this.btnDeny, this.modeSel, this.badge,
      this.btnAutoRestart, this.btnRestart, this.btnClear, btnExport, btnCopy, btnSearch, btnMic, btnFontDown, btnFontUp, btnMax, this.btnSplitRight, this.btnSplitDown, this.btnClose
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
    this.usageModelEl = document.createElement('span');
    this.usageModelEl.className = 'pane-usage-model';
    const usageTop = document.createElement('div');
    usageTop.className = 'pane-usage-row';
    usageTop.append(this.usageBarEl, this.usageCtxEl, this.usageCostEl, this.usageCacheEl, this.usageModelEl);

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
      // native OSC 8 hyperlinks (pi re-opens a full link span on every row a
      // long URL wraps across, e.g. its login link) — without this, xterm's
      // built-in fallback is a confirm() dialog plus window.open, which does
      // nothing useful in Electron. WebLinksAddon below covers plain-text
      // URLs; this covers OSC 8 ones the same way.
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

    // pi's TUI switches on terminal mouse reporting (DECSET 1000/1002/1006…),
    // which would make xterm hand every click to the app — breaking text
    // selection, copy, and both link providers above. No pane has a consumer
    // for raw mouse (same reasoning as `mouse off` in the tmux conf: wheel
    // scrolling and clicks are all handled client-side), so swallow the
    // requests and keep the mouse local.
    const MOUSE_DECSET = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
    for (const final of ['h', 'l']) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) =>
        params.every((p) => MOUSE_DECSET.has(p)));
    }

    this.term.open(this.termEl);

    // GPU renderer; falls back to the DOM renderer on failure/context loss
    this.webgl = null;
    this.rendererDropped = false; // true while a hidden pane's context is released (see dropRenderer)
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
    // /clear appears once the agent is done working and free (not mid-turn, not
    // blocked on a permission prompt, not exited); Pi has no /clear command
    const canClear = !this.exited && !this.working && !this.awaitingPrompt && this.session.kind !== 'pi';
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

  applyHookEvent({ event, tool, message, model, usage }) {
    if (this.exited) return;
    // per-turn totals from the transcript — a bookkeeping event, not a state
    // change, so it returns before any of the working/waiting handling below
    if (event === 'UsageUpdate') {
      // a null payload is the reset /clear sends: the tally starts over
      this.usage = usage || null;
      this.renderUsagePanel();
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

  /* ---- cost & context panel ---- */

  noteTurnStart() {
    this.waitingSince = 0;
    if (!this.turnStartedAt) this.turnStartedAt = Date.now();
  }

  /* Show or hide the panel, and keep the terminal's row count honest — two
   * rows of panel are two rows the terminal no longer has. */
  syncUsagePanel() {
    const show = showUsagePanel && this.session.kind !== 'pi'; // pi panes report no usage
    const was = this.usageEl.style.display !== 'none';
    this.usageEl.style.display = show ? '' : 'none';
    clearInterval(this.usageTimer);
    this.usageTimer = null;
    if (show) {
      this.renderUsagePanel();
      // the turn timer and the 5h share both move on their own
      this.usageTimer = setInterval(() => this.renderUsagePanel(), 1000);
    }
    this.syncModelChip(); // the panel takes the model over from the header

    if (show !== was && this.fit) this.refit();
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

    this.usageSparkEl.textContent = sparkline(u.series);
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

    this.usageToolsEl.textContent = this.toolTrail.join(' → ');
    this.usageToolsEl.dataset.tip = 'Most recent tools this agent ran';
  }

  /* ---- model chip ---- */

  setModel(label) {
    if (!label) return;
    this.modelLabel = label;
    this.syncModelChip();
  }

  /* One model, one place: the cost & context panel owns it whenever that
   * panel is on, and the header chip only fills in when it is off (which is
   * always the case for pi panes, whose panel never shows). */
  syncModelChip() {
    const inPanel = this.usageEl.style.display !== 'none';
    this.llmEl.textContent = this.modelLabel;
    this.llmEl.dataset.tip = this.modelTip;
    this.llmEl.style.display = this.modelLabel && !inPanel ? '' : 'none';
    this.usageModelEl.textContent = this.modelLabel;
    this.usageModelEl.style.display = this.modelLabel ? '' : 'none';
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

  /* Accept the blocking dialogs auto mode can't get past on its own (see
   * AUTO_ACCEPT_DIALOGS): each pre-highlights its accepting option, so
   * accepting is just pressing Enter — the same mechanism tryInjectPrompt
   * (app.js) uses to submit an initial task. Each fires at most once per
   * pane, and only when the user actually opted into auto mode. */
  async autoAcceptDialogs(lines = this.tailLines(30)) {
    const text = lines.join('\n');
    for (const [flag, re] of AUTO_ACCEPT_DIALOGS) {
      if (this.exited || this[flag] || !re.test(text)) continue;
      this[flag] = true;
      const cfg = await window.swarm.getConfig();
      if (cfg.skipPermissions) window.swarm.writeSession(this.session.id, '\r');
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

  /* ---- auto-restart ---- */

  /* `silent` is for the pane that inherits the flag from an auto-restarted
   * predecessor: the new session's metadata already carries it (see
   * PtyManager.restart), so re-persisting it would be a pointless round trip. */
  setAutoRestart(on, { silent = false } = {}) {
    this.autoRestart = !!on;
    this.session.autoRestart = this.autoRestart;
    if (!this.autoRestart) this.autoRestartTries = 0;
    this.syncAutoRestartButton();
    if (!silent) this.handlers.onToggleAutoRestart(this, this.autoRestart);
  }

  syncAutoRestartButton() {
    this.btnAutoRestart.textContent = this.autoRestart ? '◉' : '◎';
    this.btnAutoRestart.classList.toggle('armed', this.autoRestart);
    this.btnAutoRestart.dataset.tip = this.autoRestart
      ? 'Auto-restart is on — respawns this agent (continuing its conversation) if it exits'
      : 'Auto-restart is off — click to respawn this agent automatically if it exits';
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

  /* ⧉ in the header: the tail of the scrollback on the clipboard. Trailing
   * blank rows come off first — the TUI leaves a screenful of them below the
   * input box, which would otherwise be most of what gets copied. */
  copyTail(all = false) {
    const lines = this.getBufferText().split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const text = (all ? lines : lines.slice(-COPY_TAIL_LINES)).join('\n');
    if (!text.trim()) { if (window.toast) toast('nothing to copy yet'); return; }
    window.swarm.copyText(text);
    if (window.toast) {
      const n = all ? lines.length : Math.min(COPY_TAIL_LINES, lines.length);
      toast(`copied ${n} line${n === 1 ? '' : 's'} from ${this.session.agentName}`);
    }
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
    if (this.webgl || this.exited) return;
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

  dispose() {
    this.closeBranchMenu();
    if (this.stopDictation) this.stopDictation();
    clearTimeout(this.idleTimer);
    clearTimeout(this.closeArmTimer);
    clearTimeout(this.modeTimer);
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
    return activeXtermTheme;
  }
  const bg = overlayOn ? LIGHT_PANE_BG[name] : FLAT_PANE_BG;
  activeXtermTheme = glassTheme(readablePalette(base, bg));
  activeXtermTheme.extendedAnsi = extendedAnsiFor(bg);
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

/* app.js's Options-panel "Show last command in pane header" checkbox owns
 * persistence; this just flips the flag every pane's syncInitialCommandHeader
 * reads — the caller is responsible for re-syncing already-open panes */
Pane.setShowInitialCommand = (on) => { showInitialCommand = !!on; };

/* same pattern as setShowInitialCommand, for the → / ↓ split buttons */
Pane.setAutoOrganize = (on) => { autoOrganize = !!on; };

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
