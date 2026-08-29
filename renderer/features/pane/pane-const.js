/* ---- Pane: option state, mode/model tables, and the pure formatters ----
 *
 * Split out of the one 2416-line pane.js. The pane's vocabulary — the ⌨ Options mirrors app.js pushes in, the Claude
 * mode/model/effort tables board.js and launcher.js also read off Pane, the
 * tool sets behind the right-sizing offer, and the small formatters. Nothing
 * here touches a Pane instance.
 */

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

// longest agent name a rename can produce — the header row has one line of
// room, and anything longer only ever showed as ellipsis
const NAME_MAX = 20;

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
const TOOL_TRAIL_MAX = 3;

/* Claude Code's own Task subagents. They are invisible in a terminal — the
 * parent's pane is where all of their output lands — so the `Task` calls the
 * hook stream already reports are kept in their own short list, which is what
 * the header chip counts. Their own tool calls never reach us: a subagent runs
 * in its own context and fires no hooks of its own, so "what it is doing" is
 * not answerable, only "it is still running". */
const SUBAGENTS_MAX = 20;

/* Calls started but not yet reported back. Parallel tool use is normal, a lost
 * PostToolUse is not rare, and this only has to stay bounded. */
const OPEN_CALLS_MAX = 24;

/* Asking a live agent to stop editing — the fallback behind picking `plan` in
 * the mode dropdown, for when the Shift+Tab cycle cannot land it. Deliberately
 * plain English sent as a normal message: SwarmEye cannot *enforce* read-only
 * without per-tool permissions, which agents only pick up at launch, so this
 * is a request — and the dropdown says so rather than implying a lock. */
const READ_ONLY_ASK =
  'Please stop editing for now: do not use Edit, Write, MultiEdit or NotebookEdit, '
  + 'and do not run any command that changes files. Read and report only, until I say otherwise.';
const READ_ONLY_LIFT = 'You can edit files again — the read-only request is lifted.';

/* How long the agent has been blocked, in the coarsest unit that is still true:
 * the question this answers is "40 seconds or 40 minutes", never the seconds. */
function fmtWait(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

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

const IDLE_AFTER_MS = 2500;
// output arriving this soon after a keystroke/mouse report is its echo, not
// the agent working — typing or clicking must not light the busy indicator
const INPUT_ECHO_MS = 400;

// How many glyph-atlas pages a pane's GPU renderer may fill before the atlas is
// thrown away and rebuilt (Pane.attachWebgl explains why), and the shortest gap
// between two of those rebuilds — a screen that genuinely needs many pages must
// not clear on every frame.
const ATLAS_PAGE_LIMIT = 3;
const ATLAS_CLEAR_MIN_MS = 10000;
// ...and the counters that drive it. They are per swarm, not per pane: xterm
// hands every terminal sharing a font, theme and cell size the *same* texture
// atlas (acquireTextureAtlas), so pages one pane fills are pages every other
// pane draws from, and a clear anywhere is a clear everywhere.
let atlasPages = 0;
let atlasClearedAt = 0;
let atlasRebuild = 0; // rAF handle while a rebuild is already scheduled

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
const MODE_TIP = 'Claude mode — switches by cycling Shift+Tab in the agent';
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
 * once the agent starts, same mechanism a user typing it themselves uses.
 *
 * Every label names who is billed. An OpenRouter catalog row sits in the same
 * lists (openrouter.js pushes them into this table) and costs money per token
 * on a key you pasted, while these run on the Claude subscription — a
 * distinction worth a few characters of width, since the two kinds of row are
 * otherwise just names in one dropdown. The values are untouched: they are
 * what reaches `--model`, and main re-validates them against its own table. */
const MODELS = [
  ['default', 'Anthropic Subscription: default'],
  ['sonnet', 'Anthropic Subscription: Sonnet'],
  ['opus', 'Anthropic Subscription: Opus'],
  ['haiku', 'Anthropic Subscription: Haiku'],
  ['fable', 'Anthropic Subscription: Fable'],
  ['opusplan', 'Anthropic Subscription: Opus plan, Sonnet execution'],
  ['opus[1m]', 'Anthropic Subscription: Opus (1M context)'],
  ['sonnet[1m]', 'Anthropic Subscription: Sonnet (1M context)'],
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

/* Every file a drop carries, as agent-side paths a shell can take verbatim —
 * quoted where the path has a space. Shared by the terminal drop target and
 * the board's task box; both bail when it comes back empty. */
function droppedPaths(e) {
  return [...e.dataTransfer.files]
    .map((f) => window.swarm.pathForFile(f))
    .filter(Boolean)
    .map(agentPath)
    .map((p) => (/\s/.test(p) ? `"${p}"` : p));
}

/* "claude-opus-4-8" -> "Opus 4.8", "claude-3-5-sonnet-20241022" -> "Sonnet
 * 3.5". Best-effort: drops the claude- prefix and any trailing date stamp,
 * then puts the family name first and joins version numbers with a dot —
 * covers both the new (name-first) and legacy (numbers-first) id shapes. */
function prettyModelName(id) {
  if (!id || typeof id !== 'string') return null;
  // an OpenRouter slug ('qwen/qwen3-coder-flash') — the tail is the readable
  // part. Never /^opus/, so the right-sizing offer stays Claude-only.
  if (id.includes('/')) return id.split('/').pop();
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
