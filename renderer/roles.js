/* Roles: edit the role presets an agent can be launched as.
 *
 * A role is a short system prompt plus the model tier that job is worth. The
 * four that ship (Builder, Reviewer, Scout, Planner) used to be a const in
 * main/sessions.js; they are now a table in config.json that this edits — so a
 * preset can be reworded for your codebase, re-tiered, added to or deleted.
 *
 * A popover, built here, so index.html gains a script tag and nothing else.
 * Exposes window.Roles.
 *
 * Everything typed here is re-validated in main/roles.js before it is saved:
 * the prompt ends up inside the single-quoted tmux command that launches the
 * agent, so quotes, `$`, backticks and backslashes are stripped. The hint under
 * the box says so rather than letting it happen silently. */

const Roles = (() => {
  const PROMPT_MAX = 1200;
  const LABEL_MAX = 24;
  const UNSAFE = /["'`$\\]/g;

  let toast = () => {};
  let onSaved = () => {};
  let rows = []; // [{key, label, model, prompt}] — the working copy

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const SIZE_KEY = 'swarmeye.rolesSize'; // drag the corner; kept between opens

  const pop = el('div');
  pop.id = 'roles-pop';
  pop.hidden = true;

  const head = el('div', 'roles-head');
  const titleEl = el('div', 'kbd-title', 'Role presets');
  const addBtn = el('button', 'pill', '+ Role');
  addBtn.type = 'button';
  const closeBtn = el('button', 'pill', 'Close');
  closeBtn.type = 'button';
  closeBtn.dataset.tip = 'Close (Esc)';
  head.append(titleEl, addBtn, closeBtn);

  const listEl = el('div', 'roles-list');
  const foot = el('div', 'roles-foot');
  const noteEl = el('span', 'roles-note',
    'Quotes, $, backticks and backslashes are dropped from a prompt — it is passed to the agent on a shell command line.');
  const saveBtn = el('button', 'pill pill-primary', 'Save');
  saveBtn.type = 'button';
  foot.append(noteEl, saveBtn);

  pop.append(head, listEl, foot);
  document.body.appendChild(pop);

  /* One card per role. Rebuilt only on open / add / delete — typing edits the
   * working copy in place, so a re-render never fights the caret. */
  function render() {
    listEl.textContent = '';
    for (const row of rows) {
      const card = el('div', 'roles-card');

      const label = document.createElement('input');
      label.className = 'roles-label';
      label.value = row.label || '';
      label.maxLength = LABEL_MAX;
      label.placeholder = 'name';
      label.spellcheck = false;
      label.addEventListener('input', () => { row.label = label.value; });

      // Pane.MODELS is the renderer's one model table — a new tier is one edit
      const model = document.createElement('select');
      model.className = 'roles-model';
      for (const [value, text] of Pane.MODELS) {
        const opt = document.createElement('option');
        opt.value = value === 'default' ? '' : value;
        opt.textContent = value === 'default' ? 'default tier' : text;
        model.appendChild(opt);
      }
      model.value = row.model || '';
      model.addEventListener('change', () => { row.model = model.value; });

      const del = el('button', 'roles-del', '✕');
      del.type = 'button';
      del.dataset.tip = 'Delete this role (click twice)';
      del.addEventListener('click', () => {
        Confirm.armOrFire(del, 'role:' + (row.key || row.label), () => {
          rows = rows.filter((r) => r !== row);
          render();
        });
      });

      const top = el('div', 'roles-card-top');
      top.append(label, model, del);

      const prompt = document.createElement('textarea');
      prompt.className = 'roles-prompt';
      prompt.value = row.prompt || '';
      prompt.maxLength = PROMPT_MAX;
      prompt.rows = 3;
      prompt.spellcheck = false;
      prompt.placeholder = 'what this agent is, in a sentence or two';
      const warn = el('div', 'roles-warn');
      const syncWarn = () => {
        const bad = (row.prompt || '').match(UNSAFE);
        warn.textContent = bad ? `${bad.length} character${bad.length > 1 ? 's' : ''} will be dropped on save` : '';
      };
      prompt.addEventListener('input', () => { row.prompt = prompt.value; syncWarn(); });
      // typing must not reach the app's document-level shortcuts
      for (const node of [label, prompt]) {
        node.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      }
      syncWarn();

      card.append(top, prompt, warn);
      listEl.append(card);
    }
    if (!rows.length) listEl.append(el('div', 'roles-empty', 'no roles — add one, or save to restore the four built-ins'));
  }

  async function save() {
    const saved = await window.swarm.saveRoles(rows.map((r) => ({ ...r })));
    rows = (saved || []).map((r) => ({ ...r }));
    render();
    onSaved(rows.map((r) => ({ ...r })));
    toast('roles saved — agents started from now on use them');
  }

  async function open() {
    pop.hidden = false;
    Resizable.place(pop, SIZE_KEY);
    const list = await window.swarm.listRoles();
    rows = (list || []).map((r) => ({ ...r }));
    render();
  }

  function close() {
    if (pop.hidden) return;
    Resizable.remember(pop, SIZE_KEY);
    pop.hidden = true;
    Confirm.disarm(); // an armed delete must not survive a reopen
  }

  function init(h) {
    toast = (h && h.toast) || (() => {});
    onSaved = (h && h.onSaved) || (() => {});
    addBtn.addEventListener('click', () => {
      rows.push({ key: '', label: '', model: '', prompt: '' });
      render();
      const last = listEl.querySelector('.roles-card:last-child .roles-label');
      if (last) last.focus();
    });
    saveBtn.addEventListener('click', save);
    closeBtn.addEventListener('click', close);
  }

  return { init, open, close, isOpen: () => !pop.hidden };
})();

window.Roles = Roles;
