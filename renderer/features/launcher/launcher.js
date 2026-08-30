/* Launcher: the launch card that fills an empty workspace — swarm size on
 * square tiles, and the four settings the agents start with. Exposes
 * window.Launcher.
 *
 * The fields open on the ⚙ Options defaults and a change is a one-off for
 * that launch: Options stays the one place a default is set, so the fields go
 * back to it the next time the card appears. They are keyed by the Options
 * storage names, so app.js mirrors them in exactly as it feeds Board — except
 * Provider, which is derived from the model value rather than stored. */

/* The mode/model/effort tables come from pane-const.js, not from Pane's
 * statics. Same arrays either way — Pane.MODELS *is* this one, which is why an
 * OpenRouter catalog pushed into it shows up in every picker — but reading
 * them here off the class meant importing the class, and the class imports
 * openrouter.js, which imports this file. That cycle is what left `Pane` in
 * the temporal dead zone while this module built its selects. */
import { EFFORTS, MODELS, MODES } from '../pane/pane-const.js';

import { elt } from '../../lib/dom.js';
import { modHeld } from '../../lib/keys.js';
import { OpenRouterUI } from '../openrouter/openrouter.js';
import { Scope } from '../scope/scope.js';

const LAUNCH_COUNTS = [1, 2, 4, 6, 8, 10, 12];
const LAUNCH_DEFAULT_COUNT = 4;

/* provider is derived from the model value ('or:' prefix), never stored — a
 * launch's model already says which provider it is, so Options keeps a single
 * defaultModel and the card just opens the right list */
// labelled by who pays, like the model rows themselves — the value stays
// 'claude', which is what fillModels and the launch path read
const LAUNCH_PROVIDERS = [['claude', 'Anthropic Subscription'], ['openrouter', 'OpenRouter']];
const launchClaudeModels = () => MODELS.filter(([v]) => !OpenRouterUI.isOpenRouter(v));
/* the catalog rows carry the bare slug, not a finished model value: which
 * harness it becomes is read from the Harness field at launch time, so
 * switching harness never has to refill this list (openModelMenu does the
 * same) */
const launchOrModels = () =>
  OpenRouterUI.models.map((m) => [m.id, m.id]);
const launchHarnesses = () =>
  OpenRouterUI.HARNESSES.map(([prefix, label]) => [prefix, label]);

/* `wide` fields take two grid columns: a provider row and a model row both
 * name who is billed ("Anthropic Subscription: Sonnet"), which a 151px column
 * ellipsizes down to "Anthropic Subsc…" — hiding the very thing the field is
 * for. Two columns fit the longest of them with room to spare, and the grid
 * still comes out even: provider+model take four of the six, leaving the row
 * to harness and effort. */
const LAUNCH_FIELDS = [
  { key: 'provider', label: 'Provider', wide: true, table: () => LAUNCH_PROVIDERS },
  // which CLI an OpenRouter model runs in — hidden while Provider is Claude.
  // The tip rides the field, not the options: a native <select>'s rows can't
  // carry tooltip.js's data-tip, and pi's always-auto has to be said somewhere.
  {
    key: 'harness',
    label: 'Harness',
    tip: 'Which CLI runs the OpenRouter model: clean is our own minimal agent, opencode and pi are their own TUIs. pi gates nothing by design — it is always auto.',
    table: () => launchHarnesses(),
  },
  { key: 'defaultModel', label: 'Model', wide: true, table: () => launchClaudeModels() },
  { key: 'defaultEffort', label: 'Effort', table: () => EFFORTS },
  // Claude Code's own /focus toggle, a checkbox in Options — a two-value
  // select here so the row reads as four of the same control
  { key: 'defaultFocus', label: 'Focus', table: () => [['off', 'off'], ['on', 'on']] },
  { key: 'defaultStartMode', label: 'Permissions', table: () => MODES },
  // which folder of the workspace these agents may edit. The list is the
  // workspace's own (renderer/features/scope/scope.js), filled in as the card comes into
  // view — an empty value is the whole workspace, i.e. no boundary at all.
  {
    key: 'scope',
    label: 'Scope',
    tip: 'Confine these agents to one area or folder: they can read the whole workspace but only edit inside it. Areas come from .swarmeye/areas.json in the repo.',
    table: () => [['', 'whole workspace']],
  },
];

export const Launcher = {
  el: null,
  headlineEl: null,
  hintEl: null,
  tiles: [], // [{n, btn}]
  selects: {}, // Options key -> <select>
  scopes: null, // Scope option value -> { label, paths }
  goEl: null,
  onLaunch: null,
  count: LAUNCH_DEFAULT_COUNT,
  free: 0,
  busy: false, // a launch run is in flight — the card stays locked until it ends
  shown: false, // last sync()'s visibility, so the fields reset on the way back in
  defaults: {
    defaultModel: 'default',
    defaultEffort: 'default',
    defaultFocus: 'off',
    defaultStartMode: 'default',
    scope: '', // never an Options default: a boundary is asked for per launch
  },

  /* host is #empty-state; headline and hint are the two lines the card
   * replaces while a workspace is selected. onLaunch(n, settings) spawns the
   * agents and resolves when the run is over. */
  init(host, headline, hint, onLaunch) {
    this.headlineEl = headline;
    this.hintEl = hint;

    const root = elt('div', 'empty-launcher');
    root.hidden = true;
    root.appendChild(elt('div', 'empty-launcher__hex'));
    root.appendChild(elt('div', 'empty-launcher__fade'));

    const card = elt('div', 'launcher-card');
    const head = elt('div', 'launcher-card__head');
    head.appendChild(elt('span', 'launcher-card__title', 'How many agents?'));
    head.appendChild(elt('span', 'launcher-card__sub', 'Pick a swarm size to fill this workspace'));
    card.appendChild(head);

    const tiles = elt('div', 'count-tiles');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Number of agents');
    for (const n of LAUNCH_COUNTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'count-tile';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.count = String(n);
      btn.appendChild(elt('span', 'count-tile__n', String(n)));
      btn.addEventListener('click', () => this.select(n));
      // double-click is "this many, go" — the size the tile names, launched
      // with the fields as they stand
      btn.addEventListener('dblclick', () => { this.select(n); this.launch(); });
      btn.addEventListener('keydown', (e) => this.onTileKey(e, n));
      this.tiles.push({ n, btn });
      tiles.appendChild(btn);
    }
    card.appendChild(tiles);
    card.appendChild(elt('div', 'launcher-card__rule'));

    const options = elt('div', 'launch-options');
    for (const f of LAUNCH_FIELDS) {
      const field = elt('div', 'launch-field' + (f.wide ? ' launch-field--wide' : ''));
      if (f.tip) field.dataset.tip = f.tip;
      field.appendChild(elt('span', 'launch-field__label', f.label));
      const sel = document.createElement('select');
      sel.className = 'launch-field__select';
      sel.setAttribute('aria-label', f.label);
      for (const [value, label] of f.table()) sel.add(new Option(label, value));
      this.selects[f.key] = sel;
      field.appendChild(sel);
      options.appendChild(field);
    }
    this.selects.provider.addEventListener('change', () => this.fillModels());
    card.appendChild(options);

    const foot = elt('div', 'launcher-card__foot');
    this.goEl = document.createElement('button');
    this.goEl.type = 'button';
    this.goEl.className = 'launcher-card__go';
    this.onLaunch = onLaunch;
    this.goEl.addEventListener('click', () => this.launch());
    foot.appendChild(this.goEl);
    card.appendChild(foot);

    root.appendChild(card);
    host.appendChild(root);
    this.el = root;
    this.applyDefaults();
    this.select(LAUNCH_DEFAULT_COUNT);

    // ⌘/Ctrl + a count picks that size — through modHeld itself (app.js), not
    // a restatement of it: Ctrl works on macOS like every other shortcut, and
    // the Windows key still never counts.
    window.addEventListener('keydown', (e) => {
      if (!modHeld(e) || e.shiftKey || e.altKey) return;
      if (this.busy || !this.visible()) return;
      const tile = this.tiles.find((t) => t.n === Number(e.key) && !t.btn.disabled);
      if (!tile) return;
      e.preventDefault();
      this.select(tile.n);
      tile.btn.focus();
    });
  },

  /* the one way out of the card: the Go button and a double-clicked tile both
   * come through here, so the busy lock and the disabled state are checked in
   * one place. */
  async launch() {
    if (this.busy || this.goEl.disabled) return;
    this.busy = true;
    this.el.classList.add('busy');
    try { await this.onLaunch(this.count, this.getSettings()); } finally {
      this.busy = false;
      this.el.classList.remove('busy');
    }
  },

  // hidden by its own flag, or by an ancestor (a full view is up, or panes exist)
  visible() {
    return !!this.el && !this.el.hidden && this.el.offsetParent !== null;
  },

  /* the ⚙ Options values the fields open on — mirrored in as each one is
   * applied, the same way Board.setDefaults is fed. Only the keys handed over
   * are touched, so changing one default can't wipe a pick made in another
   * field. */
  setDefaults(partial) {
    for (const [key, value] of Object.entries(partial)) {
      const sel = this.selects[key];
      if (!sel) continue;
      const v = key === 'defaultFocus' ? (value ? 'on' : 'off') : value;
      this.defaults[key] = v;
      if (key === 'defaultModel') this.applyModel(v);
      else sel.value = v;
    }
  },

  applyDefaults() {
    for (const [key, sel] of Object.entries(this.selects)) {
      if (key === 'provider' || key === 'harness' || key === 'defaultModel') continue;
      sel.value = this.defaults[key];
    }
    this.applyModel(this.defaults.defaultModel);
  },

  /* provider and harness both follow the model value: an OpenRouter default
   * opens the card on OpenRouter (if the catalog is there to show) and on the
   * harness its own prefix names, anything else on Claude */
  applyModel(want) {
    this.syncProviders();
    const v = String(want || '');
    const or = OpenRouterUI.isOpenRouter(v) && launchOrModels().length;
    this.selects.provider.value = or ? 'openrouter' : 'claude';
    /* a value saved before clean-everywhere ('or:') is a clean pick; a value
     * with no prefix to read at all opens on the habit the + Agent menu
     * remembers. The card only ever *reads* that habit — every field here is a
     * one-off for this launch, so a pick made in it must not quietly change
     * what Ctrl+N launches later. */
    const prefix = (OpenRouterUI.HARNESSES.find(([p]) => v.startsWith(p)) || [])[0]
      || (v.startsWith('or:') ? 'oc:' : OpenRouterUI.harnessPrefix());
    this.selects.harness.value = prefix;
    this.fillModels(or ? OpenRouterUI.slugOf(v) : v);
  },

  // the OpenRouter option is only offerable once a catalog exists (key saved)
  syncProviders() {
    const opt = this.selects.provider.querySelector('option[value="openrouter"]');
    opt.disabled = !launchOrModels().length;
  },

  /* the Model list follows the provider: Claude's fixed tiers, or the catalog
   * (bare slugs — getSettings glues the harness prefix on). The Harness field
   * only means anything on OpenRouter, and Effort greys out there — main drops
   * the flag for those models (claudeBase). */
  fillModels(want) {
    const or = this.selects.provider.value === 'openrouter';
    const sel = this.selects.defaultModel;
    sel.textContent = '';
    for (const [value, label] of (or ? launchOrModels() : launchClaudeModels())) sel.add(new Option(label, value));
    if (want != null) sel.value = want;
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    // hidden, not disabled: a Claude launch has no harness to pick, and the
    // grid drops the field entirely rather than leaving a greyed gap
    this.selects.harness.parentElement.hidden = !or;
    this.selects.harness.parentElement.parentElement.classList.toggle('has-harness', or);
    const effortField = this.selects.defaultEffort.parentElement;
    this.selects.defaultEffort.disabled = or;
    if (or) effortField.dataset.tip = 'effort is Claude-only — OpenRouter models ignore it';
    else delete effortField.dataset.tip;
  },

  /* what this workspace can be scoped to, once its areas and file list are
   * in: the areas its `.swarmeye/areas.json` names, then the raw folders,
   * under a heading each. Rebuilt rather than merged — it arrives while the
   * card is coming into view, before anyone has picked out of it. */
  fillScope(entries) {
    const sel = this.selects.scope;
    if (!sel) return;
    const keep = sel.value;
    this.scopes = new Map(entries.map((e) => [e.value, e.scope]));
    sel.textContent = '';
    sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'whole workspace' }));
    let group = null;
    for (const e of entries) {
      if (e.group !== (group && group.label)) {
        group = Object.assign(document.createElement('optgroup'), { label: e.group });
        sel.appendChild(group);
      }
      const opt = document.createElement('option');
      opt.value = e.value;
      opt.textContent = e.label;
      opt.title = e.tip; // a native <select>'s rows can't carry tooltip.js's data-tip
      group.appendChild(opt);
    }
    sel.value = keep;
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  },

  /* the catalog landed after init (boot config read, or a key saved in
   * Options) — unlock the provider option without touching a pick already
   * made in the visible card */
  catalogChanged() {
    if (this.selects.provider) this.syncProviders();
  },

  select(n) {
    this.count = n;
    for (const { n: value, btn } of this.tiles) {
      const on = value === n;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.tabIndex = on && !btn.disabled ? 0 : -1;
    }
    this.syncGo();
  },

  // arrows move between the tiles that are still selectable
  onTileKey(e, n) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(n); return; }
    let dir = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') dir = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') dir = -1;
    else return;
    const open = this.tiles.filter((t) => !t.btn.disabled);
    if (!open.length) return;
    e.preventDefault();
    const i = open.findIndex((t) => t.n === n);
    const next = open[(i + dir + open.length) % open.length];
    this.select(next.n);
    next.btn.focus();
  },

  syncGo() {
    const none = this.free <= 0;
    this.goEl.disabled = none;
    this.goEl.textContent = none
      ? 'Agent limit reached'
      : `Launch ${this.count} agent${this.count === 1 ? '' : 's'}`;
  },

  /* workspace: the selected workspace's id — somewhere to put the agents, and
   * whose folders the Scope field offers.
   * free: slots left under the agent cap, counted across all workspaces. */
  sync({ workspace, free }) {
    if (!this.el) return;
    // runs on every chrome beat with almost always the same inputs — the
    // hidden flips, tile loop and roving selection below are wasted work then
    if (workspace === this._syncWs && free === this._syncFree) return;
    this._syncWs = workspace;
    this._syncFree = free;
    this.el.hidden = !workspace;
    this.headlineEl.hidden = !!workspace;
    this.hintEl.hidden = !!workspace;
    if (!workspace) { this.shown = false; return; }

    // coming back into view: the last launch's one-off picks are spent, so the
    // fields go back to what Options says
    if (!this.shown) { this.applyDefaults(); this.shown = true; }
    // the folder list follows the workspace, so it is fetched on the change
    // this method already guards on rather than on every chrome beat
    Scope.entries(workspace).then((list) => { if (this._syncWs === workspace) this.fillScope(list); });

    this.free = free;
    for (const { n, btn } of this.tiles) {
      const over = n > free;
      btn.disabled = over;
      // dataset.tip, not title: the one custom tooltip system (tooltip.js)
      if (over) btn.dataset.tip = `only ${free} agent slot${free === 1 ? '' : 's'} left`;
      else delete btn.dataset.tip;
    }
    // the cap may have swallowed whatever was selected — fall back to the
    // largest size that is still reachable
    const open = this.tiles.filter((t) => !t.btn.disabled);
    const reachable = open.some((t) => t.n === this.count);
    this.select(reachable ? this.count : (open.length ? open[open.length - 1].n : LAUNCH_DEFAULT_COUNT));
  },

  getSettings() {
    const or = this.selects.provider.value === 'openrouter';
    return {
      // the catalog rows are bare slugs — the harness prefix is what turns one
      // into a launchable value (main/providers.js decodes it)
      model: (or ? this.selects.harness.value : '') + this.selects.defaultModel.value,
      effort: this.selects.defaultEffort.value,
      focus: this.selects.defaultFocus.value === 'on',
      startMode: this.selects.defaultStartMode.value,
      // { label, paths } — an area is several paths, a folder is one
      scope: (this.scopes && this.scopes.get(this.selects.scope.value)) || undefined,
    };
  },
};
