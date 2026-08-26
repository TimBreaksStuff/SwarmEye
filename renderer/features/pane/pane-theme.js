/* ---- Pane: terminal palettes, contrast and font state ----
 *
 * Split out of the one 2416-line pane.js. Classic script, like everything it loads beside — these are plain top-level
 * consts and lets, shared through script scope with pane.js and its mixins.
 * Pane.setXtermTheme / setDefaultFontSize (in pane.js) reassign the lets here;
 * that works across classic scripts because they share one lexical scope.
 */

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

/* the dark page's complete ramp, shared by `dark` and its accent variants */
const DARK_RAMP = {
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
};

/* The twelve accent variants of `light`: same page, same ramp, and only the
 * cursor and the selection follow the accent — so that pair is the whole
 * entry. [name, cursor, selection-rgb]; the selection is that hue at 0.25. */
const LIGHT_ACCENTS = [
  ['blue', '#1e40af', '29, 78, 216'],
  ['neoblue', '#0043c7', '0, 87, 255'],
  ['purple', '#5b21b6', '109, 40, 217'],
  ['teal', '#115e59', '15, 118, 110'],
  ['rose', '#9f1239', '190, 18, 60'],
  ['violet', '#6d28d9', '124, 58, 237'],
  ['sky', '#075985', '3, 105, 161'],
  ['indigo', '#3730a3', '67, 56, 202'],
  ['fuchsia', '#86198f', '162, 28, 175'],
  ['emerald', '#065f46', '4, 120, 87'],
  ['amber', '#7a4700', '154, 91, 0'],
  ['slate', '#334155', '71, 85, 105'],
];

const XTERM_THEMES = {
  dark: DARK_RAMP,
  light: LIGHT_RAMP,
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
for (const [name, cursor, rgb] of LIGHT_ACCENTS) {
  XTERM_THEMES[name] = { ...LIGHT_RAMP, cursor, selectionBackground: `rgba(${rgb}, 0.25)` };
}
/* The terminal paints its own opaque background rather than letting a pane
 * tint show through (it used to be transparent, back when the panes were
 * glass; chrome-clean.css has filled .pane-term with a flat var(--term-bg)
 * since it took the design over). That is a legibility fix, not a cosmetic
 * one: with `allowTransparency` on, xterm rasterizes its glyph atlas into a
 * canvas created with `{alpha: true}`, and Chromium will only greyscale-
 * antialias into one of those. Opaque, it subpixel-antialiases instead —
 * which is most of the difference on Windows, where DirectWrite already
 * lays down lighter stems than CoreText and the text read washed out.
 *
 * So the palette's background has to be the colour the CSS would have
 * painted, read from the same variable: it covers every theme and both
 * states of the background overlay, which pins --term-bg dark whatever the
 * theme is. xterm also measures its luminance for the contrast pass below,
 * so a wrong value there would mis-correct the light themes' foregrounds. */
function paneTheme(palette) {
  const css = getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim();
  return { ...palette, background: /^#[0-9a-f]{6}$/i.test(css) ? css : palette.background };
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
const LIGHT_THEMES = new Set([
  'light', 'blue', 'neoblue', 'purple', 'teal', 'rose', 'violet',
  'sky', 'indigo', 'fuchsia', 'emerald', 'amber', 'slate',
]);

// WCAG AA for text. Left at 1 (xterm's "off") for the dark themes, whose
// panes are the backdrop agents already assume.
const MIN_CONTRAST = 4.5;

let activeXtermTheme = paneTheme(XTERM_THEMES.dark);
let activeMinContrast = 1;

// Terminal font. JetBrains Mono is the app's own; the macOS "Native Apple
// style" option (settings.js) swaps in the system mono so agent panes match
// Terminal.app rather than the rest of the chrome. A variable, not a literal
// in the term options, because the option flips it at runtime.
const DEFAULT_MONO_FONT = "'JetBrains Mono', monospace";
const NATIVE_MONO_FONT = "ui-monospace, 'SF Mono', Menlo, 'JetBrains Mono', monospace";
let activeMonoFont = DEFAULT_MONO_FONT;

const DEFAULT_FONT_SIZE = 13;
// last font size the user picked (MOD+/- or the pane buttons) — persists
// across restarts so reopened agent panes come back at the same text size
let activeFontSize = Number(localStorage.getItem('swarmeye.paneFontSize')) || DEFAULT_FONT_SIZE;

// Windows starts two steps heavier: DirectWrite rasterizes stems lighter than
// macOS's Skia/CoreText, so the same 400 that looks right on a Mac reads thin
// and washed out there. Still just a default — the Options knob overrides it.
const DEFAULT_FONT_WEIGHT = window.swarm.isMac ? 400 : 600;
// "Agent pane text weight" option in ⌨ Options — the light themes draw dark
// text on a near-white pane, which reads thinner than the dark themes'
// light-on-dark, so the weight is a knob rather than a constant. Capped at 600
// (JetBrains Mono is a 300–700 variable font) so bold, which tracks 300 above,
// stays heavier than body text at every step — 400 gives xterm's own 700.
let activeFontWeight = Number(localStorage.getItem('swarmeye.paneFontWeight')) || DEFAULT_FONT_WEIGHT;
const boldFor = (weight) => Math.min(700, weight + 300);
