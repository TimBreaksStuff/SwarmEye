/* ---- Settings: the ⌨ Options popover and every preference in it ----
 *
 * Split out of app.js. Everything here is one of three things: the popover's
 * own open/close, one option's wiring, or ↺ Reset. Nothing else in the app
 * writes a preference, so this is the whole surface.
 *
 * Options the rest of the app reads back are `export let` — an ES module's
 * live bindings mean app.js sees a flip the moment it happens, so importers
 * keep spelling them exactly as they did when this was all one file.
 *
 * The app-wide things an option's effect needs (the pane map, the grid, the
 * toast) arrive once through `init(ctx)` rather than being reached for: this
 * module is loaded by app.js, never the other way round.
 */

/* keyboard-shortcuts / options popover. Looked up at module scope because
 * app.js's ESCAPABLE list closes over both of them. */
export const kbdPop = document.getElementById('kbd-pop');
export const kbdShortcutsPop = document.getElementById('kbd-shortcuts-pop');
/* the top bar's gear. Exported because two things elsewhere open the popover
 * by clicking it: the update pill and the command palette. */
export const kbdHelpBtn = document.getElementById('kbd-help');
const kbdShortcutsBtn = document.getElementById('kbd-shortcuts-btn');

/* colour theme — swatches in the ⌨ popover; persisted locally. Exported
 * because the command palette offers the same switch. */
export const themeDots = document.querySelectorAll('#theme-opts .theme-dot');

/* option values the rest of the app reads. Assigned here, imported live. */
export let maxAgents = 10; // cap on simultaneous agents — also stored in config
export let autoUsageLimit = 85; // usage-% ceiling for auto-scheduled tasks — also stored in config
export let taskSummaries = true;
export let desktopNotifs = true;
export let notifSpeech = false;
export let notifSound = localStorage.getItem('swarmeye.notifSound') || 'chime';

const leftbarEl = document.getElementById('leftbar'); // also drives the rail's expand/hover states below

/* set once by init() — what an option's effect needs from app.js */
let ctx = null;

/* The two ± text-size controls (⌨ popover) do the same four things: clamp to
 * 0.7–1.6 in 0.1 steps, scale the elements they own, label the percentage,
 * persist. They differ only in which elements and which storage key.
 *
 * `elements` is a thunk because some of them (gsearch) live in app.js —
 * looking them up at click time avoids depending on load order. */
function makeZoomControl({ storageKey, elements, valueEl, downId, upId }) {
  let zoom = Number(localStorage.getItem(storageKey)) || 1;
  const apply = (z) => {
    zoom = Math.round(Math.max(0.7, Math.min(1.6, z)) * 10) / 10;
    for (const el of elements()) el.style.zoom = zoom;
    valueEl.textContent = Math.round(zoom * 100) + '%';
    localStorage.setItem(storageKey, String(zoom));
  };
  document.getElementById(downId).addEventListener('click', () => apply(zoom - 0.1));
  document.getElementById(upId).addEventListener('click', () => apply(zoom + 0.1));
  apply(zoom);
  return apply;
}

/* Every plain checkbox in the ⌨ Options panel is the same wiring — reflect
 * the stored value into the box, persist a flip, run the option's own effect —
 * so only the effect is written per option. Returns the apply function, which
 * the reset button uses to flip options programmatically.
 *
 * Options saved by older versions wrote '' for off rather than '0'; both read
 * back as false, so no migration is needed. */
function boolOption(id, key, defaultOn, effect) {
  const box = document.getElementById(id);
  const apply = (on) => {
    box.checked = on;
    localStorage.setItem('swarmeye.' + key, on ? '1' : '0');
    effect(on);
  };
  box.addEventListener('change', () => apply(box.checked));
  const saved = localStorage.getItem('swarmeye.' + key);
  apply(saved === null ? defaultOn : saved === '1');
  return apply;
}

/* local engine installers — the ⌨ popover's dictation and voice rows. Neither
 * engine ships with the app (a Python venv plus a ~465 MB Whisper model for
 * dictation, the Piper binary plus a ~61 MB voice for speech, both inside WSL
 * on Windows), so each row runs the same scripts/setup-*.sh that
 * `npm run setup:*` does and streams its output into a log box — a
 * multi-minute download behind a disabled button is indistinguishable from a
 * hang. Neither is part of ↺ Reset: an install isn't a preference. */
const ENGINE_LOG_MAX = 200;

function engineRow({ statusId, btnId, logId, installed, install, onProgress, okToast, failToast }) {
  const statusEl = document.getElementById(statusId);
  const btn = document.getElementById(btnId);
  const logEl = document.getElementById(logId);

  const refresh = async () => {
    const on = await installed();
    statusEl.textContent = on ? 'installed' : 'not installed';
    statusEl.classList.toggle('ok', on);
    btn.textContent = on ? 'Reinstall' : 'Install';
  };

  // registered once, not per click — preload's onX are bare ipcRenderer.on with
  // no unsubscribe, same constraint onSkillUpdateStatus lives with
  onProgress(({ line }) => {
    logEl.textContent += line + '\n';
    const lines = logEl.textContent.split('\n');
    if (lines.length > ENGINE_LOG_MAX) logEl.textContent = lines.slice(-ENGINE_LOG_MAX).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    statusEl.textContent = 'installing…';
    statusEl.classList.remove('ok');
    logEl.textContent = '';
    logEl.hidden = false;
    const res = await install();
    btn.disabled = false;
    // the main process clears its cached availability check on success, so the
    // engine works straight away — no app restart
    if (res.ok) ctx.toast(okToast);
    else if (res.reason === 'busy') ctx.toast('an install is already running');
    else ctx.toast(failToast);
    refresh();
  });

  refresh();
}

/* left menu style — collapsed (icons only, hover to preview the expanded
 * view) or expanded (always shows workspace names + usage gauges); the
 * "Small left menu" checkbox in the ⌨ popover, persisted locally. New installs
 * default to expanded (checkbox unchecked). */
let leftbarStyle = localStorage.getItem('swarmeye.leftbarStyle') || 'expanded';
const leftbarSmallToggle = document.getElementById('leftbar-small-toggle');
function applyLeftbarStyle(style) {
  leftbarStyle = style === 'collapsed' ? 'collapsed' : 'expanded';
  localStorage.setItem('swarmeye.leftbarStyle', leftbarStyle);
  leftbarEl.classList.toggle('expanded', leftbarStyle === 'expanded');
  if (leftbarStyle === 'expanded') leftbarEl.classList.remove('hover-expanded');
  leftbarSmallToggle.checked = leftbarStyle === 'collapsed';
}

/* colour theme — pushes the matching xterm palette into every open pane, so a
 * theme switch reaches running agents and not just the chrome. */
export function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('swarmeye.theme', name);
  const xt = Pane.setXtermTheme(name);
  const minContrast = Pane.getMinContrast();
  for (const p of ctx.state.panes.values()) {
    p.term.options.theme = xt;
    p.term.options.minimumContrastRatio = minContrast;
  }
  for (const dot of themeDots) dot.classList.toggle('active', dot.dataset.theme === name);
}

/* auto mode (bypass permissions) — off by default; the checkbox in the ⌨
 * popover opts in, since it launches claude with --allow-dangerously-skip-permissions.
 * Every flip goes through applySkipPermissions so the checkbox, main's copy and
 * the panes' own copy (pane.js reads it when it decides whether to accept the
 * blocking first-run dialogs) can't drift apart. */
const skipPermissionsToggle = document.getElementById('skip-permissions-toggle');
function applySkipPermissions(on) {
  skipPermissionsToggle.checked = on;
  Pane.setSkipPermissions(on);
  window.swarm.setSkipPermissions(on);
}

/* The ⌨ popover's three default pickers are one control three times: fill the
 * select from a Pane table, persist the choice locally, and mirror it into the
 * task board's matching per-task select. They differ only in the table, the
 * storage key, and — for start mode — one extra coupling. */
const DEFAULT_PICKERS = [
  {
    id: 'default-startmode-sel',
    table: () => Pane.MODES,
    key: 'defaultStartMode',
    // 'default' is relabeled from Pane.MODES' own "manual" the same way the
    // task board's picker does, so the two read as the same choice
    optionText: (value, label) => (value === 'default' ? 'default' : label),
    // bypass ("auto") only exists in claude's Shift+Tab cycle when it was
    // launched with --allow-dangerously-skip-permissions, so picking it here
    // silently no-ops unless that prerequisite is also on — flip it on to match
    // instead of leaving the picker looking selectable but non-functional.
    onApply: (name) => {
      if (name === 'bypass' && !skipPermissionsToggle.checked) applySkipPermissions(true);
    },
  },
  { id: 'default-model-sel', table: () => Pane.MODELS, key: 'defaultModel' },
  { id: 'default-effort-sel', table: () => Pane.EFFORTS, key: 'defaultEffort' },
];

const applyDefault = {}; // key -> apply(value), for the ↺ Reset button below

/* Everything the reset button flips, filled in by init() in the order the
 * options are wired — resetOptions runs long after that. */
const applied = {};

/* notification sound picker — lives here rather than with the notification
 * center because it is a stored preference; what plays it is app.js. */
const notifSoundSel = document.getElementById('notif-sound-sel');

/* reset to default — restores every setting in the Options popover. Two
 * clicks, like every other control here that can't be undone: one stray click
 * would otherwise throw away a whole configuration silently. */
async function resetOptions() {
  applyLeftbarStyle('expanded');
  applied.anthropicUsage(true);
  applied.openrouterUsage(true);
  applied.topbarZoom(1);
  applied.boardZoom(1);
  applied.agentFontSize(Pane.DEFAULT_FONT_SIZE);
  applied.agentFontWeight(Pane.DEFAULT_FONT_WEIGHT);
  await applied.maxAgents(10);
  await applied.autoUsageLimit(85);
  applySkipPermissions(false);
  applied.showInitialCommand(false);
  applied.promptHistory(true);
  applied.usagePanel(false);
  applied.fixedPaneActions(false);
  applied.autoOrganize(true);
  applied.agentPadding(true);
  for (const { key } of DEFAULT_PICKERS) applyDefault[key]('default');
  applied.defaultFocus(false);
  OpenRouterUI.applyNewAgentProvider('ask');
  applied.taskSummary(true);
  applied.desktopNotifs(true);
  applied.notifSpeech(false);
  applyTheme('dark');
  applied.themeOverlay(true);
  notifSound = 'chime';
  notifSoundSel.value = notifSound;
  localStorage.setItem('swarmeye.notifSound', notifSound);
  ctx.toast('options reset to default');
}

/* The stored half of the settings: main owns these three, so they arrive with
 * the rest of the config at boot rather than from localStorage. */
export function applyConfig(cfg) {
  maxAgents = cfg.maxAgents || 10;
  document.getElementById('max-agents-val').textContent = maxAgents;
  autoUsageLimit = cfg.autoUsageLimit ?? 85;
  document.getElementById('auto-limit-val').textContent = autoUsageLimit + '%';
  // straight from the stored value: applySkipPermissions would push it back to
  // main, which already has it
  skipPermissionsToggle.checked = !!cfg.skipPermissions;
  Pane.setSkipPermissions(!!cfg.skipPermissions);
}

/* Wires every control in the popover. Called from app.js at the point this
 * code used to sit, so the boot-time order of the applies is unchanged —
 * applyTheme in particular has to run after the overlay attribute below. */
export function init(context) {
  ctx = context;

  /* ---- the popover itself ---- */
  kbdHelpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (kbdPop.hidden) {
      ctx.closeNotifPop(); // popovers are mutually exclusive
      // anchor the popover below the gear button — it sits in the top bar's
      // icon group, so it drops down right-aligned with the button
      const r = kbdHelpBtn.getBoundingClientRect();
      kbdPop.style.bottom = '';
      kbdPop.style.left = '';
      kbdPop.style.top = Math.round(r.bottom + 8) + 'px';
      kbdPop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    }
    kbdPop.hidden = !kbdPop.hidden;
    if (kbdPop.hidden) kbdShortcutsPop.hidden = true;
  });
  document.addEventListener('click', (e) => {
    // the alt-models picker (Options → Setup → ＋) floats on document.body, so
    // a click into it is not "outside" even though kbdPop doesn't contain it
    if (!kbdPop.hidden && !kbdPop.contains(e.target) && !kbdShortcutsPop.contains(e.target) && !e.target.closest('.or-model-menu')) kbdPop.hidden = true;
    if (!kbdShortcutsPop.hidden && !kbdShortcutsPop.contains(e.target) && !kbdShortcutsBtn.contains(e.target)) kbdShortcutsPop.hidden = true;
  });

  /* ---- filter ---- */

  /* Typed into the box in the header bar, left of Reset: rows whose label or
   * tooltip don't match hide, sections left empty disappear. Built here
   * rather than in index.html: one element, and index.html is contended. */
  const filterEl = document.createElement('input');
  filterEl.id = 'options-filter';
  filterEl.type = 'search';
  filterEl.placeholder = 'Filter options…';
  filterEl.spellcheck = false;
  document.getElementById('options-reset-btn').before(filterEl);
  const filterSects = [...kbdPop.querySelectorAll('.kbd-sect')];
  const submenuBtn = kbdPop.querySelector('.kbd-submenu-btn');
  // the sections stopped being an accordion when the popover went two-column:
  // every group is open all the time, the summary is just its header (CSS
  // makes it inert), and the <details> markup simply stays as it is
  for (const sect of filterSects) {
    sect.open = true;
    // pointer-events:none stops the mouse; this stops the keyboard path too
    sect.addEventListener('toggle', () => { if (!sect.open) sect.open = true; });
  }
  const applyFilter = () => {
    const q = filterEl.value.trim().toLowerCase();
    for (const sect of filterSects) {
      let any = false;
      for (const row of sect.querySelectorAll('.kbd-row')) {
        const tip = row.querySelector('[data-tip]');
        const hit = !q || (row.textContent + ' ' + (tip ? tip.dataset.tip : '')).toLowerCase().includes(q);
        row.style.display = hit ? '' : 'none';
        any = any || hit;
      }
      sect.style.display = !q || any ? '' : 'none';
    }
    submenuBtn.style.display = !q || submenuBtn.textContent.toLowerCase().includes(q) ? '' : 'none';
  };
  filterEl.addEventListener('input', applyFilter);
  filterEl.addEventListener('keydown', (e) => {
    // Esc clears the filter first, then (empty) bubbles to close the popover;
    // anything else stays out of the document-level shortcut handler
    if (e.key === 'Escape' && filterEl.value) {
      filterEl.value = '';
      applyFilter();
      e.stopPropagation();
    } else if (e.key !== 'Escape') e.stopPropagation();
  });

  /* keyboard-shortcuts submenu — a nested popover launched from a button inside
   * the Options popover. It anchors beside kbd-pop itself rather than below the
   * button: the button sits near the bottom of kbd-pop's content, so opening
   * downward would risk running off-screen the way the Archived popover once
   * did. kbd-pop hangs off the right edge now, so this one opens to its left. */
  kbdShortcutsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (kbdShortcutsPop.hidden) {
      const popRect = kbdPop.getBoundingClientRect();
      const btnRect = kbdShortcutsBtn.getBoundingClientRect();
      kbdShortcutsPop.style.left = '';
      kbdShortcutsPop.style.right = Math.min(
        Math.round(window.innerWidth - popRect.left + 12),
        Math.max(8, window.innerWidth - 408)
      ) + 'px';
      kbdShortcutsPop.style.bottom = Math.max(8, Math.round(window.innerHeight - btnRect.bottom)) + 'px';
    }
    kbdShortcutsPop.hidden = !kbdShortcutsPop.hidden;
  });

  /* ---- appearance ---- */

  /* menu-bar (top bar + icon rail) scale, plus the sub-menus anchored to it
   * (search, notifications). The options popover is excluded: its text
   * size is owned by "Task board, Skills & Options text size" instead. */
  applied.topbarZoom = makeZoomControl({
    storageKey: 'swarmeye.topbarZoom',
    elements: () => [
      document.getElementById('topbar'),
      leftbarEl,
      document.getElementById('gsearch'),
      document.getElementById('msg-pop'),
      ctx.notifPopEl,
    ],
    valueEl: document.getElementById('ui-font-val'),
    downId: 'ui-font-down',
    upId: 'ui-font-up',
  });

  leftbarSmallToggle.addEventListener('change', () => applyLeftbarStyle(leftbarSmallToggle.checked ? 'collapsed' : 'expanded'));
  applyLeftbarStyle(leftbarStyle);

  // hovering the collapsed rail previews the expanded layout as a floating
  // overlay (#leftbar-surface grows past #leftbar's own reserved width, so
  // the grid never reflows just from a mouse pass) — same hide-delay pattern
  // as the workspace-tile flyout in topbar.js, so a quick pass-through
  // doesn't flicker it open
  let leftbarHoverTimer = null;
  leftbarEl.addEventListener('mouseenter', () => {
    if (leftbarStyle !== 'collapsed') return;
    clearTimeout(leftbarHoverTimer);
    leftbarEl.classList.add('hover-expanded');
  });
  leftbarEl.addEventListener('mouseleave', () => {
    clearTimeout(leftbarHoverTimer);
    leftbarHoverTimer = setTimeout(() => leftbarEl.classList.remove('hover-expanded'), 200);
  });

  /* task board text scale — the ± control in the central Options popover; persisted locally.
   * Applies to board-main (new-task form + columns), board-archive, skills-main
   * and the options popover itself, so every non-terminal UI surface besides the
   * icon rail/top bar (covered by "Menu bar size") and agent panes shares one text size. */
  applied.boardZoom = makeZoomControl({
    storageKey: 'swarmeye.boardZoom',
    elements: () => [
      document.getElementById('board-main'),
      document.getElementById('board-archive'),
      document.getElementById('skills-main'),
      document.getElementById('history-main'),
      kbdPop,
      kbdShortcutsPop,
    ],
    valueEl: document.getElementById('board-font-val'),
    downId: 'board-font-down',
    upId: 'board-font-up',
  });

  /* agent pane text size — the ± control in the central Options popover; persisted
   * locally as the default new panes start at (same store Ctrl+/- and the pane's
   * own buttons write to). Also pushes the new size to every already-open pane,
   * so it reads as a single "text size" setting rather than just a new-pane default. */
  const agentFontVal = document.getElementById('agent-font-val');
  applied.agentFontSize = (px) => {
    const size = Pane.setDefaultFontSize(px);
    agentFontVal.textContent = size + 'px';
    for (const p of ctx.state.panes.values()) p.setFontSize(size);
  };
  document.getElementById('agent-font-down').addEventListener('click', () => applied.agentFontSize(Pane.getDefaultFontSize() - 1));
  document.getElementById('agent-font-up').addEventListener('click', () => applied.agentFontSize(Pane.getDefaultFontSize() + 1));
  applied.agentFontSize(Pane.getDefaultFontSize());

  /* agent pane text weight — the ± control below the size one, same shape. Its
   * reason to exist is the light themes: dark text on a near-white pane reads
   * thinner than the dark themes' light-on-dark at the same weight. */
  const AGENT_WEIGHT_LABELS = { 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semibold' };
  const agentWeightVal = document.getElementById('agent-weight-val');
  applied.agentFontWeight = (w) => {
    const weight = Pane.setDefaultFontWeight(w);
    agentWeightVal.textContent = AGENT_WEIGHT_LABELS[weight];
    for (const p of ctx.state.panes.values()) p.setFontWeight(weight);
  };
  document.getElementById('agent-weight-down').addEventListener('click', () => applied.agentFontWeight(Pane.getDefaultFontWeight() - 100));
  document.getElementById('agent-weight-up').addEventListener('click', () => applied.agentFontWeight(Pane.getDefaultFontWeight() + 100));
  applied.agentFontWeight(Pane.getDefaultFontWeight());

  /* ---- limits ---- */

  /* max simultaneous agents — the ± control in the ⌨ popover; persisted in config */
  const maxAgentsVal = document.getElementById('max-agents-val');
  applied.maxAgents = async (n) => {
    const res = await window.swarm.setMaxAgents(n);
    maxAgents = res.maxAgents;
    maxAgentsVal.textContent = maxAgents;
    ctx.syncChrome(); // counter and + button follow the new cap
    ctx.runScheduler(); // a raised cap can immediately unblock queued tasks
  };
  document.getElementById('max-agents-down').addEventListener('click', () => applied.maxAgents(maxAgents - 1));
  document.getElementById('max-agents-up').addEventListener('click', () => applied.maxAgents(maxAgents + 1));

  /* auto-start usage threshold — the ± control in the ⌨ popover; persisted in config */
  const autoLimitVal = document.getElementById('auto-limit-val');
  applied.autoUsageLimit = async (n) => {
    const res = await window.swarm.setAutoUsageLimit(n);
    autoUsageLimit = res.autoUsageLimit;
    autoLimitVal.textContent = autoUsageLimit + '%';
    ctx.renderBoard();
    ctx.runScheduler(); // a loosened threshold can immediately unblock queued tasks
  };
  document.getElementById('auto-limit-down').addEventListener('click', () => applied.autoUsageLimit(autoUsageLimit - 5));
  document.getElementById('auto-limit-up').addEventListener('click', () => applied.autoUsageLimit(autoUsageLimit + 5));

  skipPermissionsToggle.addEventListener('change', () => applySkipPermissions(skipPermissionsToggle.checked));

  /* ---- panes and grid ---- */

  /* "Show last command in pane header" — off by default; pushed to every
   * already-open pane so it reads as a single live setting */
  applied.showInitialCommand = boolOption('show-initial-cmd-toggle', 'showInitialCommand', false, (on) => {
    Pane.setShowInitialCommand(on);
    for (const p of ctx.state.panes.values()) p.syncInitialCommandHeader();
  });

  /* the left menu's two usage sections — both on by default. Off takes the
   * heading and the bars out of the rail in either menu size; the OpenRouter
   * one stops polling too, and stays hidden anyway while no key is saved. */
  applied.anthropicUsage = boolOption('anthropic-usage-toggle', 'anthropicUsage', true, (on) => Topbar.setUsageSection('anthropic', on));
  applied.openrouterUsage = boolOption('openrouter-usage-toggle', 'openrouterUsage', true, (on) => Topbar.setUsageSection('openrouter', on));

  /* "Remember prompt history" — on by default; what the palette offers back
   * (see prompts.js). Off only stops recording — nothing stored is lost. */
  applied.promptHistory = boolOption('prompt-history-toggle', 'promptHistory', true, (on) => Prompts.setEnabled(on));

  /* "Show cost & context panel" — off by default; the panel eats two rows of
   * every pane's terminal, so opening it re-fits each one */
  applied.usagePanel = boolOption('usage-panel-toggle', 'usagePanel', false, (on) => {
    Pane.setShowUsagePanel(on);
    for (const p of ctx.state.panes.values()) p.syncUsagePanel();
  });

  /* "Fixed agent pane buttons" — off by default: the two rarely-used text-size
   * buttons fold behind each pane's ⋯. On puts them back inline. */
  applied.fixedPaneActions = boolOption('pane-fixed-actions-toggle', 'paneFixedActions', false, (on) => {
    Pane.setFixedActions(on);
    for (const p of ctx.state.panes.values()) p.syncActionsMode();
  });

  /* "Auto-organize agent windows" — on by default; off lets each pane's → / ↓
   * buttons place new agents by hand instead of the automatic square-ish grid */
  applied.autoOrganize = boolOption('auto-organize-toggle', 'autoOrganize', true, (on) => {
    Pane.setAutoOrganize(on);
    ctx.grid.setAutoOrganize(on);
    for (const p of ctx.state.panes.values()) p.syncSplitButtons();
  });

  /* "Space between agent panes" — on by default (12px gap + draggable divider,
   * plus the grid's own edge padding); off collapses panes flush together with
   * no gap and lets the grid fill the window edge-to-edge too */
  applied.agentPadding = boolOption('agent-padding-toggle', 'agentPadding', true, (on) => {
    ctx.grid.setGutter(on ? 12 : 0);
    ctx.gridWrapEl.classList.toggle('no-pane-gap', !on);
  });

  /* ---- theme ---- */

  /* "Theme background overlay" state — applied before applyTheme below, which
   * needs it: with the overlay off --term-bg is pinned dark whatever the theme,
   * and that is the backdrop the terminal palette is built against. The option
   * itself is wired up further down and re-applies the same attribute. */
  document.documentElement.dataset.themeOverlay =
    localStorage.getItem('swarmeye.themeOverlay') === '0' ? 'off' : 'on';

  themeDots.forEach((dot) => dot.addEventListener('click', () => applyTheme(dot.dataset.theme)));
  /* a theme this build no longer ships (the picker used to offer 25) falls back
   * to dark rather than leaving data-theme pointing at a block that is gone */
  const savedTheme = localStorage.getItem('swarmeye.theme');
  applyTheme([...themeDots].some((d) => d.dataset.theme === savedTheme) ? savedTheme : 'dark');

  /* "Theme background overlay" — on by default; off hides the theme-tinted
   * background grid wash and pins the app's chassis (background, left bar,
   * panes, terminals) to the default dark shades, leaving only the theme's
   * colours — borders, text, accents, terminal ramp — themed. See app.css. */
  applied.themeOverlay = boolOption('theme-overlay-toggle', 'themeOverlay', true, (on) => {
    document.documentElement.dataset.themeOverlay = on ? 'on' : 'off';
    applyTheme(document.documentElement.dataset.theme); // terminal palette follows the backdrop
  });

  /* ---- notifications ---- */

  /* "Task summary on completion" — on by default. The agent's closing message
   * is pulled out of the transcript by main/hooks.js on the same read that
   * already runs at every turn boundary, and lands on the completed card, so the
   * board says what came of a task without opening its transcript. */
  applied.taskSummary = boolOption('task-summary-toggle', 'taskSummary', true, (on) => {
    taskSummaries = on;
  });

  /* "Desktop notifications" — on by default. The taskbar flash and the bell only
   * help while SwarmEye is on screen; this is the one that reaches you with the
   * window minimized behind an editor. Main only raises a toast when the window
   * isn't focused, so this never fires at something you're already looking at. */
  applied.desktopNotifs = boolOption('desktop-notif-toggle', 'desktopNotifs', true, (on) => {
    desktopNotifs = on;
  });

  /* notification sound — the picker in the ⌨ popover; persisted locally and
   * played whenever an agent's turn finishes (see onStatusChange in app.js) */
  for (const [value, label] of Sounds.OPTIONS) notifSoundSel.add(new Option(label, value));
  notifSoundSel.value = notifSound;
  notifSoundSel.addEventListener('change', () => {
    notifSound = notifSoundSel.value;
    localStorage.setItem('swarmeye.notifSound', notifSound);
    Sounds.play(notifSound); // preview so the pick is audible immediately
  });

  /* "Spoken notifications" — off by default, and dead until the voice engine in
   * the row below is installed. Says which agent finished and what it said last;
   * only for turns that end while you aren't watching, the same gate the sound
   * uses. Deliberately not wired to 'attention': that already flashes the
   * taskbar, raises a toast and rings the bell, and a busy swarm would talk
   * without pause. */
  applied.notifSpeech = boolOption('voice-notif-toggle', 'notifSpeech', false, (on) => {
    notifSpeech = on;
  });
  document.getElementById('voice-notif-toggle').addEventListener('change', (e) => {
    // a preview only when it's switched on by hand — boolOption's own effect
    // also runs at boot, where an announcement out of nowhere would be a bug
    if (e.target.checked) Sounds.speak('Spoken notifications on');
  });

  /* ---- setup ---- */

  engineRow({
    statusId: 'stt-status', btnId: 'stt-install-btn', logId: 'stt-log',
    installed: () => window.swarm.speechInstalled(),
    install: () => window.swarm.speechInstall(),
    onProgress: window.swarm.onSpeechInstallProgress,
    okToast: 'dictation engine installed — the mic button works now',
    failToast: 'dictation engine install failed — see the log in ⌨ Options',
  });

  engineRow({
    statusId: 'tts-status', btnId: 'tts-install-btn', logId: 'tts-log',
    installed: () => window.swarm.ttsInstalled(),
    install: () => window.swarm.ttsInstall(),
    onProgress: window.swarm.onTtsInstallProgress,
    okToast: 'voice installed — spoken notifications work now',
    failToast: 'voice install failed — see the log in ⌨ Options',
  });

  /* ---- defaults for new agents ---- */

  for (const { id, table, key, optionText, onApply } of DEFAULT_PICKERS) {
    const sel = document.getElementById(id);
    for (const [value, label] of table()) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = optionText ? optionText(value, label) : label;
      sel.appendChild(opt);
    }
    const apply = (name) => {
      sel.value = name;
      localStorage.setItem('swarmeye.' + key, name);
      Board.setDefaults({ [key]: name });
      Launcher.setDefaults({ [key]: name }); // the empty-workspace card opens on these too
      if (onApply) onApply(name);
    };
    applyDefault[key] = apply;
    sel.addEventListener('change', () => apply(sel.value));
    apply(localStorage.getItem('swarmeye.' + key) || 'default');
  }

  /* default focus mode — a checkbox rather than a select, so it stays its own
   * few lines instead of bending the table above around one odd case */
  applied.defaultFocus = boolOption('default-focus-toggle', 'defaultFocus', false, (on) => {
    Board.setDefaults({ defaultFocus: on });
    Launcher.setDefaults({ defaultFocus: on });
  });

  const optionsResetBtn = document.getElementById('options-reset-btn');
  optionsResetBtn.addEventListener('click', () => {
    Confirm.armOrFire(optionsResetBtn, 'options-reset', resetOptions);
  });
}
