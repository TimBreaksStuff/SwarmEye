/* Launcher: the launch card that fills an empty workspace — swarm size on
 * square tiles, and the four settings the agents start with. Exposes
 * window.Launcher.
 *
 * The four fields open on the ⚙ Options defaults and a change is a one-off for
 * that launch: Options stays the one place a default is set, so the fields go
 * back to it the next time the card appears. They are keyed by the Options
 * storage names, so app.js mirrors them in exactly as it feeds Board. */

const LAUNCH_COUNTS = [1, 2, 4, 6, 8, 10, 12];
const LAUNCH_DEFAULT_COUNT = 4;

const LAUNCH_FIELDS = [
  { key: 'defaultModel', label: 'Model', table: () => Pane.MODELS },
  { key: 'defaultEffort', label: 'Effort', table: () => Pane.EFFORTS },
  // Claude Code's own /focus toggle, a checkbox in Options — a two-value
  // select here so the row reads as four of the same control
  { key: 'defaultFocus', label: 'Focus', table: () => [['off', 'off'], ['on', 'on']] },
  { key: 'defaultStartMode', label: 'Permissions', table: () => Pane.MODES },
];

const Launcher = {
  el: null,
  headlineEl: null,
  hintEl: null,
  tiles: [], // [{n, btn}]
  selects: {}, // Options key -> <select>
  goEl: null,
  count: LAUNCH_DEFAULT_COUNT,
  free: 0,
  busy: false, // a launch run is in flight — the card stays locked until it ends
  shown: false, // last sync()'s visibility, so the fields reset on the way back in
  defaults: {
    defaultModel: 'default',
    defaultEffort: 'default',
    defaultFocus: 'off',
    defaultStartMode: 'default',
  },

  /* host is #empty-state; headline and hint are the two lines the card
   * replaces while a workspace is selected. onLaunch(n, settings) spawns the
   * agents and resolves when the run is over. */
  init(host, headline, hint, onLaunch) {
    this.headlineEl = headline;
    this.hintEl = hint;

    const root = launchEl('div', 'empty-launcher');
    root.hidden = true;
    root.appendChild(launchEl('div', 'empty-launcher__hex'));
    root.appendChild(launchEl('div', 'empty-launcher__fade'));

    const card = launchEl('div', 'launcher-card');
    const head = launchEl('div', 'launcher-card__head');
    head.appendChild(launchEl('span', 'launcher-card__title', 'How many agents?'));
    head.appendChild(launchEl('span', 'launcher-card__sub', 'Pick a swarm size to fill this workspace'));
    card.appendChild(head);

    const tiles = launchEl('div', 'count-tiles');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Number of agents');
    for (const n of LAUNCH_COUNTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'count-tile';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.count = String(n);
      btn.appendChild(launchEl('span', 'count-tile__n', String(n)));
      btn.addEventListener('click', () => this.select(n));
      btn.addEventListener('keydown', (e) => this.onTileKey(e, n));
      this.tiles.push({ n, btn });
      tiles.appendChild(btn);
    }
    card.appendChild(tiles);
    card.appendChild(launchEl('div', 'launcher-card__rule'));

    const options = launchEl('div', 'launch-options');
    for (const f of LAUNCH_FIELDS) {
      const field = launchEl('div', 'launch-field');
      field.appendChild(launchEl('span', 'launch-field__label', f.label));
      const sel = document.createElement('select');
      sel.className = 'launch-field__select';
      sel.setAttribute('aria-label', f.label);
      for (const [value, label] of f.table()) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      }
      this.selects[f.key] = sel;
      field.appendChild(sel);
      options.appendChild(field);
    }
    card.appendChild(options);

    const foot = launchEl('div', 'launcher-card__foot');
    this.goEl = document.createElement('button');
    this.goEl.type = 'button';
    this.goEl.className = 'launcher-card__go';
    this.goEl.addEventListener('click', async () => {
      if (this.busy || this.goEl.disabled) return;
      this.busy = true;
      root.classList.add('busy');
      try { await onLaunch(this.count, this.getSettings()); } finally {
        this.busy = false;
        root.classList.remove('busy');
      }
    });
    foot.appendChild(this.goEl);
    card.appendChild(foot);

    root.appendChild(card);
    host.appendChild(root);
    this.el = root;
    this.applyDefaults();
    this.select(LAUNCH_DEFAULT_COUNT);

    // ⌘/Ctrl + a count picks that size. Windows Chromium reports the Windows
    // key as metaKey, so accepting metaKey there would make Win+4 pick a swarm
    // size — the same rule app.js's modHeld follows.
    window.addEventListener('keydown', (e) => {
      if (!(window.swarm.isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (this.busy || !this.visible()) return;
      const tile = this.tiles.find((t) => t.n === Number(e.key) && !t.btn.disabled);
      if (!tile) return;
      e.preventDefault();
      this.select(tile.n);
      tile.btn.focus();
    });
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
      sel.value = v;
    }
  },

  applyDefaults() {
    for (const [key, sel] of Object.entries(this.selects)) sel.value = this.defaults[key];
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

  /* workspace: one is selected, so there is somewhere to put the agents.
   * free: slots left under the agent cap, counted across all workspaces. */
  sync({ workspace, free }) {
    if (!this.el) return;
    this.el.hidden = !workspace;
    this.headlineEl.hidden = !!workspace;
    this.hintEl.hidden = !!workspace;
    if (!workspace) { this.shown = false; return; }

    // coming back into view: the last launch's one-off picks are spent, so the
    // fields go back to what Options says
    if (!this.shown) { this.applyDefaults(); this.shown = true; }

    this.free = free;
    for (const { n, btn } of this.tiles) {
      const over = n > free;
      btn.disabled = over;
      btn.title = over ? `only ${free} agent slot${free === 1 ? '' : 's'} left` : '';
    }
    // the cap may have swallowed whatever was selected — fall back to the
    // largest size that is still reachable
    const open = this.tiles.filter((t) => !t.btn.disabled);
    const reachable = open.some((t) => t.n === this.count);
    this.select(reachable ? this.count : (open.length ? open[open.length - 1].n : LAUNCH_DEFAULT_COUNT));
  },

  getSettings() {
    return {
      model: this.selects.defaultModel.value,
      effort: this.selects.defaultEffort.value,
      focus: this.selects.defaultFocus.value === 'on',
      startMode: this.selects.defaultStartMode.value,
    };
  },
};

function launchEl(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

window.Launcher = Launcher;
