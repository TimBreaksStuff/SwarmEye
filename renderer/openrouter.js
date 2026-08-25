/* renderer/openrouter.js — the OpenRouter key row in ⌨ Options → Setup.
 * Self-contained like tooltip.js: wires its own controls on load and talks
 * only to the window.swarm.openrouter* IPC wrappers, so app.js is untouched.
 * The key goes up once and never comes back down — status() reports counts.
 * The model selects pick the catalog up from config:get on the next boot;
 * openrouter:changed (a plain DOM event on window) lets same-session UI
 * refresh without a restart once Phase 3 listens for it. */
/* OpenRouterUI.install(models) extends the model pickers with the catalog:
 * entries pushed into Pane.MODELS cover selects built later from that table
 * (roles/coordinator read it lazily), and an <optgroup> is appended to the
 * two selects app.js/board.js already built synchronously at load. The
 * launch card is separate: its Provider select reads this.models directly.
 * Values are 'or:<slug>' — the encoding main/providers.js decodes. */
window.OpenRouterUI = {
  models: [],
  install(models) {
    if (!Array.isArray(models) || !models.length) return;
    this.models = models;
    // re-runnable: a catalog refresh (Options → Setup) calls this again with
    // the newly fetched list, so the previous catalog's rows come out before
    // the new ones go in — otherwise a model released after boot stayed
    // invisible until the app restarted.
    // every catalog pick is a *clean* agent ('oc:', agent/clean.js — no
    // Claude Code harness). The CC-wrapped 'or:' spelling still launches
    // (already-persisted sessions and tasks) but is no longer offered
    // anywhere.
    for (let i = Pane.MODELS.length - 1; i >= 0; i--) {
      if (Pane.MODELS[i][0].startsWith('oc:')) Pane.MODELS.splice(i, 1);
    }
    for (const m of models) Pane.MODELS.push(['oc:' + m.id, m.id]);
    // the two selects with ids — the launch card is not in this list: it has
    // its own Provider control and reads this.models per pick (launcher.js)
    const sels = ['default-model-sel', 'board-form-model'].map((id) => document.getElementById(id));
    for (const sel of sels) {
      if (!sel) continue;
      const grp = document.createElement('optgroup');
      grp.label = 'OpenRouter';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = 'oc:' + m.id;
        opt.textContent = m.id;
        grp.appendChild(opt);
      }
      const old = sel.querySelector('optgroup');
      const was = sel.value; // swapping the group drops a selected 'oc:' row
      if (old) sel.replaceChild(grp, old); else sel.appendChild(grp);
      if (was) sel.value = was;
    }
    // the launch card's Provider select unlocks its OpenRouter option
    if (window.Launcher && Launcher.catalogChanged) Launcher.catalogChanged();
    // a stored OpenRouter default was unappliable while the options didn't
    // exist yet — the select fell back to its first row; set it right. A
    // default saved before clean-everywhere ('or:') migrates to 'oc:' once.
    let want = localStorage.getItem('swarmeye.defaultModel');
    if (want && want.startsWith('or:')) {
      want = 'oc:' + want.slice(3);
      localStorage.setItem('swarmeye.defaultModel', want);
    }
    if (want && want.startsWith('oc:')) {
      const sel = document.getElementById('default-model-sel');
      if (sel) sel.value = want;
      if (window.Board) Board.setDefaults({ defaultModel: want });
      if (window.Launcher) Launcher.setDefaults({ defaultModel: want });
    }
  },

  /* Which CLI a catalog pick launches. All three talk to the same OpenRouter
   * model; they differ in what wraps it — see opencode-pi-plan.md. The choice
   * is a per-user habit, so it is remembered, and it lives here rather than in
   * app.js/pane.js so that every caller of openModelMenu inherits it without
   * knowing the prefixes exist.
   *
   * The Options and board selects stay clean-only (install() pushes 'oc:'
   * alone) because a flat <select> of the whole catalog times three harnesses
   * is unreadable — the board picks its harness in a select of its own beside
   * the model and rewrites the prefix on submit (board.js pickedModel). The
   * scheduler treats all three alike: every gate it applies tests isBare. */
  HARNESSES: [
    ['oc:', 'clean', 'Our own minimal CLI — four tools, no Claude Code'],
    ['opencode:', 'opencode', 'opencode.ai — its own TUI, tools and permissions'],
    ['pi:', 'pi', 'pi.dev — minimal TUI, and always auto: it gates nothing by design'],
  ],
  harnessPrefix() {
    const want = localStorage.getItem('swarmeye.orHarness');
    return this.HARNESSES.some(([p]) => p === want) ? want : 'oc:';
  },
  setHarnessPrefix(p) {
    if (this.HARNESSES.some(([x]) => x === p)) localStorage.setItem('swarmeye.orHarness', p);
  },

  /* Which harness a model value names: 'or' (catalog model inside Claude
   * Code), 'clean', 'opencode', 'pi', or null for a Claude tier. One decoder,
   * so nothing else has to know a prefix is three characters long — 'opencode:'
   * is nine, which a slice(3) would silently mangle. */
  harnessOf(model) {
    const v = String(model || '');
    if (v.startsWith('or:')) return 'or';
    for (const [prefix, name] of this.HARNESSES) if (v.startsWith(prefix)) return name;
    return null;
  },
  /* The slug behind any of those prefixes ('' for a Claude tier). */
  slugOf(model) {
    const v = String(model || '');
    if (v.startsWith('or:')) return v.slice(3);
    for (const [prefix] of this.HARNESSES) if (v.startsWith(prefix)) return v.slice(prefix.length);
    return '';
  },
  /* True for an agent running without the Claude Code harness at all — clean,
   * opencode or pi. They share what they *lack*: no skill system, no /focus,
   * no /effort, no permission footer to steer, and a conversation only the
   * same harness can resume. Every gate that used to test for 'oc:' means
   * this. */
  isBare(model) {
    const h = this.harnessOf(model);
    return h === 'clean' || h === 'opencode' || h === 'pi';
  },
  /* True for anything billed to OpenRouter rather than the Anthropic account,
   * bare harness or not. What the callers of this actually mean is "not a
   * Claude Code agent on a Claude tier": no --effort to type, and not a
   * candidate when an explicitly Claude-only agent was asked for. It replaces
   * a /^o[rc]:/ test that predates the two longer prefixes and would quietly
   * miss them. */
  isOpenRouter(model) {
    return this.harnessOf(model) !== null;
  },

  /* Ctrl+N's provider question — Claude or OpenRouter — with a "remember for
   * future agents" checkbox that persists the answer (the Options select can
   * change it back). app.js only asks while a catalog is installed. onPick
   * gets 'claude' | 'openrouter'; remembering is handled here. */
  _provEl: null,
  _onProvDismiss: null,
  _onProvKey: null,
  closeProviderMenu() {
    if (!this._provEl) return;
    this._provEl.remove();
    this._provEl = null;
    document.removeEventListener('mousedown', this._onProvDismiss, true);
    document.removeEventListener('keydown', this._onProvKey, true);
    this._onProvDismiss = this._onProvKey = null;
  },
  openProviderMenu(anchorEl, onPick) {
    this.closeProviderMenu();
    this.closeModelMenu();
    const menu = document.createElement('div');
    menu.className = 'branch-menu or-provider-menu';
    const remember = document.createElement('input');
    remember.type = 'checkbox';
    const entries = [
      ['claude', 'Anthropic Subscription', 'Your Options default model'],
      ['openrouter', 'OpenRouter…', 'Pick any catalog model'],
    ];
    for (const [provider, label, tip] of entries) {
      const row = elt('button', 'branch-item', label);
      row.dataset.tip = tip;
      row.addEventListener('click', () => {
        if (remember.checked) this.applyNewAgentProvider(provider);
        this.closeProviderMenu();
        onPick(provider);
      });
      menu.appendChild(row);
    }
    const rememberRow = elt('label', 'or-provider-remember');
    rememberRow.appendChild(remember);
    rememberRow.appendChild(document.createTextNode('remember for future agents'));
    menu.appendChild(rememberRow);
    const r = anchorEl.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    document.body.appendChild(menu);
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
    menu.querySelector('.branch-item').focus(); // Enter = Claude, the pre-feature behaviour
    this._provEl = menu;
    this._onProvDismiss = (e) => {
      if (!menu.contains(e.target)) this.closeProviderMenu();
    };
    this._onProvKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeProviderMenu(); }
    };
    document.addEventListener('mousedown', this._onProvDismiss, true);
    document.addEventListener('keydown', this._onProvKey, true);
  },

  /* the persisted answer behind the menu above: 'ask' | 'claude' |
   * 'openrouter', read by app.js's Ctrl+N handler. Kept in sync with the
   * Options select, which init() wires below. */
  applyNewAgentProvider(v) {
    localStorage.setItem('swarmeye.newAgentProvider', v);
    const sel = document.getElementById('newagent-provider-sel');
    if (sel) sel.value = v;
  },

  /* The + Agent menu's model picker: a filterable catalog list under the
   * anchor button. onPick gets the row's value — 'or:<slug>' for a catalog
   * model, or whatever `extra` supplied — and the caller decides what a pick
   * means (app.js spawns an agent with it, a pane restarts onto it). Same
   * .branch-menu chrome as the menu that opened it.
   *
   * `extra` is an optional [[value, label], …] listed above the catalog and
   * filtered with it, so a caller that can offer more than OpenRouter (the
   * pane chip, which also offers the Claude tiers) needs no second menu. */
  /* The harness toggle that sits above the filter: which CLI the model picked
   * below will run in. Three buttons rather than a select — it is a one-click
   * choice made right before picking a model, and the whole row is narrower
   * than the slugs underneath it. */
  _harnessRow() {
    const row = document.createElement('div');
    row.className = 'or-harness-row';
    const sync = () => {
      const active = this.harnessPrefix();
      for (const b of row.children) b.classList.toggle('on', b.dataset.prefix === active);
    };
    for (const [prefix, label, tip] of this.HARNESSES) {
      const b = elt('button', 'or-harness');
      b.dataset.prefix = prefix;
      b.textContent = label;
      b.dataset.tip = tip;
      b.addEventListener('click', () => { this.setHarnessPrefix(prefix); sync(); });
      row.appendChild(b);
    }
    sync();
    return row;
  },

  _menuEl: null,
  _onMenuDismiss: null,
  closeModelMenu() {
    if (!this._menuEl) return;
    this._menuEl.remove();
    this._menuEl = null;
    document.removeEventListener('mousedown', this._onMenuDismiss, true);
    document.removeEventListener('keydown', this._onMenuKey, true);
    this._onMenuDismiss = null;
    this._onMenuKey = null;
  },
  openModelMenu(anchorEl, onPick, { extra = [] } = {}) {
    this.closeModelMenu();
    const menu = document.createElement('div');
    menu.className = 'branch-menu or-model-menu';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'branch-new-input';
    const fmtM = (v) => '$' + (v * 1e6).toFixed(2) + '/M';
    // one flat list of {value, text, tip} so the filter, the rendering and the
    // pick have a single shape whatever the row came from. A catalog row
    // carries its slug instead of a value: which harness that becomes is read
    // at click time, so switching the toggle needs no re-render.
    // the label already names the provider ("Anthropic Subscription: Opus"),
    // so the tip repeats it rather than prefixing a second one
    const rows = extra.map(([value, label]) => ({ value, text: label, tip: label }))
      .concat(this.models.map((m) => ({
        slug: m.id,
        text: m.id,
        tip: m.label
          + (m.ctx ? ` · ${Math.round(m.ctx / 1000)}k context` : '')
          + (m.in || m.out ? ` · ${fmtM(m.in)} in · ${fmtM(m.out)} out` : ' · free'),
      })));
    input.placeholder = `filter ${rows.length} models…`;
    menu.appendChild(this._harnessRow());
    menu.appendChild(input);
    const list = document.createElement('div');
    list.className = 'or-model-list';
    menu.appendChild(list);
    const fill = (q) => {
      list.textContent = '';
      const needle = q.trim().toLowerCase();
      for (const m of rows) {
        if (needle && !(m.text + ' ' + m.tip).toLowerCase().includes(needle)) continue;
        const row = elt('button', 'branch-item', m.text);
        row.dataset.tip = m.tip;
        row.addEventListener('click', () => {
          this.closeModelMenu();
          onPick(m.slug ? this.harnessPrefix() + m.slug : m.value);
        });
        list.appendChild(row);
      }
      if (!list.childElementCount) {
        const none = document.createElement('div');
        none.className = 'or-model-none';
        none.textContent = 'no model matches';
        list.appendChild(none);
      }
    };
    fill('');
    input.addEventListener('input', () => fill(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeModelMenu(); }
      else if (e.key === 'Enter') {
        const first = list.querySelector('.branch-item');
        if (first) first.click();
      }
    });
    const r = anchorEl.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    document.body.appendChild(menu);
    // the + Agent button hugs the right window edge and the slugs are long —
    // clamp after appending, when the menu's real width is measurable
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
    // a pane's model chip sits at the *bottom* of the pane, so a bottom-row
    // agent opened 60vh of catalog below the middle of the window and all of
    // it but the harness row hung off the screen. Flip above the anchor the
    // way the branch and scope menus already do — and, since this menu is far
    // taller than those, cap it to the room on whichever side it lands, so a
    // chip too low for either half still shows a scrollable list.
    const below = window.innerHeight - r.bottom - 14;
    const above = r.top - 14;
    if (menu.offsetHeight > below) {
      const flip = above > below;
      menu.style.maxHeight = `${Math.round(flip ? above : below)}px`;
      if (flip) menu.style.top = `${Math.round(Math.max(8, r.top - 6 - menu.offsetHeight))}px`;
    }
    input.focus();
    this._menuEl = menu;
    this._onMenuDismiss = (e) => {
      if (!menu.contains(e.target)) this.closeModelMenu();
    };
    // document-level like the provider menu's: the input's own handler only
    // fires while the input has focus, and Escape after a list click fell
    // through to whatever ESCAPABLE surface sat underneath
    this._onMenuKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeModelMenu(); }
    };
    document.addEventListener('mousedown', this._onMenuDismiss, true);
    document.addEventListener('keydown', this._onMenuKey, true);
  },
};

(() => {
  const $ = (id) => document.getElementById(id);

  /* The extra models `/model` offers inside an OpenRouter agent: a chip each
   * (click to drop it) and a ＋ that opens the same filterable catalog menu
   * the + Agent button uses. Three is the ceiling because that is how many
   * tier slots the launch env has left over — see main/providers.js. */
  const ALT_MAX = 3;
  let alts = [];

  async function saveAlts(next) {
    render(await window.swarm.openrouterSetAlts(next));
  }

  function renderAlts() {
    // the slugs are far wider than the options panel's control column, so the
    // chips get their own full-width line under the row — same escape #or-error
    // takes — and only the ＋ stays beside the label
    const list = $('or-alts-list');
    list.textContent = '';
    list.hidden = !alts.length || $('or-alts-row').hidden;
    for (const slug of alts) {
      const chip = document.createElement('button');
      chip.className = 'or-alt-chip';
      chip.textContent = slug + ' ✕';
      chip.dataset.tip = 'Stop offering ' + slug;
      chip.addEventListener('click', () => saveAlts(alts.filter((s) => s !== slug)));
      list.appendChild(chip);
    }
    $('or-alts-add').hidden = alts.length >= ALT_MAX;
  }

  function render(st) {
    const s = $('or-status');
    const err = $('or-error');
    if (!st) { s.textContent = ''; err.hidden = true; $('or-alts-row').hidden = $('or-alts-list').hidden = true; return; }
    $('or-alts-row').hidden = !st.configured;
    alts = st.alts || [];
    renderAlts();
    // errors get a full-width line under the row — squeezed next to the input
    // they ellipsized into "⚠ that d…"; the inline span keeps only the short
    // happy-path status ("312 models" — the placeholder already says "no key")
    err.textContent = st.error ? '⚠ ' + st.error : '';
    err.hidden = !st.error;
    s.textContent = st.configured ? st.models + ' models' : '';
    // one control set at a time: the input to enter a key, or refresh/forget
    $('or-key-input').hidden = st.configured;
    $('or-key-save').hidden = st.configured;
    $('or-key-refresh').hidden = !st.configured;
    $('or-key-clear').hidden = !st.configured;
    if (!st.error) window.dispatchEvent(new CustomEvent('openrouter:changed', { detail: st }));
  }

  async function save() {
    const key = $('or-key-input').value.trim();
    if (!key) return;
    $('or-status').textContent = 'fetching catalog…';
    const st = await window.swarm.openrouterSetKey(key);
    if (!st.error) $('or-key-input').value = '';
    render(st);
  }

  function init() {
    window.swarm.openrouterStatus().then(render);
    // a key saved *or a catalog refreshed* this session reaches the pickers
    // without a restart: the catalog just landed in config, re-read it and
    // install over whatever was there
    window.addEventListener('openrouter:changed', (e) => {
      if (e.detail && e.detail.configured && e.detail.models) {
        window.swarm.getConfig().then((cfg) => OpenRouterUI.install(cfg.openrouterModels || []));
      }
    });
    $('or-key-save').addEventListener('click', save);
    $('or-key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    $('or-key-refresh').addEventListener('click', async () => {
      $('or-status').textContent = 'fetching catalog…';
      render(await window.swarm.openrouterRefresh());
    });
    $('or-key-clear').addEventListener('click', () => {
      Confirm.armOrFire($('or-key-clear'), 'or-key-clear', async () => {
        render(await window.swarm.openrouterClearKey());
      });
    });
    const add = $('or-alts-add');
    add.addEventListener('click', () => {
      OpenRouterUI.openModelMenu(add, (v) => saveAlts(alts.concat(v.replace(/^o[rc]:/, ''))));
    });
    // the Ctrl+N provider setting — options are static in index.html
    const provSel = $('newagent-provider-sel');
    provSel.value = localStorage.getItem('swarmeye.newAgentProvider') || 'ask';
    provSel.addEventListener('change', () => OpenRouterUI.applyNewAgentProvider(provSel.value));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
