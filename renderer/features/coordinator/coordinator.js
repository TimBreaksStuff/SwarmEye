/* Coordinator — a multi-part request in, a reviewable list of tasks out.
 *
 * Two states in one modal: the request, then the split it came back with.
 * Nothing is created until the rows are approved, because a misread request
 * would otherwise spend a whole agent per subtask before anyone saw it.
 *
 * Owns no app state: the workspace, the role list and what to do with an
 * approved row all arrive in open(). */
const Coordinator = (() => {
  const SIZE_KEY = 'swarmeye.coordSize'; // drag the corner; kept between opens
  const el = document.getElementById('coord-modal');
  const boxEl = document.getElementById('coord-modal-box');
  const metaEl = document.getElementById('coord-modal-meta');
  const inputEl = document.getElementById('coord-input');
  const planEl = document.getElementById('coord-plan');
  const splitBtn = document.getElementById('coord-split');
  const createBtn = document.getElementById('coord-create');
  const closeBtn = document.getElementById('coord-close');

  const REASONS = {
    'no-workspace': 'that workspace is gone',
    'empty-text': 'nothing to split',
    'tmp-unreachable': 'the temp folder isn’t reachable from the shell',
    'no-claude': 'the coordinator call failed — is claude on the PATH?',
    'unreadable-plan': 'the coordinator didn’t answer with a usable plan',
    'empty-plan': 'the coordinator split it into nothing',
  };

  let ctx = null; // { workspaceId, workspaceName, roles, onCreate }
  let rows = [];  // the live plan — one entry per subtask row

  function select(options, value) {
    const sel = document.createElement('select');
    for (const [val, label] of options) sel.add(new Option(label, val));
    sel.value = value;
    return sel;
  }

  function renderPlan() {
    planEl.innerHTML = '';
    rows.forEach((row, i) => {
      const wrap = elt('div', 'coord-row');

      const text = document.createElement('textarea');
      text.rows = 3;
      text.value = row.text;
      text.addEventListener('input', () => { row.text = text.value; syncFoot(); });
      // keys typed here must not reach app.js's document-level shortcuts —
      // Escape is left alone so it still closes the modal
      text.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });

      const controls = document.createElement('div');
      controls.className = 'coord-row-controls';

      const roleSel = select(
        [['', 'plain agent']].concat(ctx.roles.map((r) => [r.key, r.label])),
        row.role
      );
      roleSel.dataset.tip = 'Role preset this subtask’s agent launches with';
      roleSel.addEventListener('change', () => { row.role = roleSel.value; });

      // Pane.MODELS is the one renderer model table — a new tier is one edit
      const modelSel = select(Pane.MODELS, row.model);
      modelSel.dataset.tip = 'Model for this subtask — “default” lets the role decide';
      modelSel.addEventListener('change', () => { row.model = modelSel.value; });

      const drop = document.createElement('button');
      drop.className = 'pill coord-drop';
      drop.dataset.tip = 'Drop this subtask';
      Icons.set(drop, 'close');
      drop.addEventListener('click', () => {
        rows.splice(i, 1);
        renderPlan();
        syncFoot();
      });

      controls.append(roleSel, modelSel, drop);
      wrap.append(text, controls);
      planEl.appendChild(wrap);
    });
  }

  function syncFoot() {
    const live = rows.filter((r) => r.text.trim()).length;
    createBtn.textContent = live === 1 ? 'Create 1 task' : `Create ${live} tasks`;
    createBtn.disabled = !live;
  }

  function showRequest() {
    rows = [];
    planEl.hidden = true;
    planEl.innerHTML = '';
    inputEl.hidden = false;
    createBtn.hidden = true;
    splitBtn.hidden = false;
    splitBtn.disabled = false;
    splitBtn.textContent = 'Split';
    metaEl.textContent = `${ctx.workspaceName} · one haiku call splits this into subtasks — nothing starts until you approve them`;
  }

  async function doSplit() {
    const text = inputEl.value.trim();
    if (!text) return;
    splitBtn.disabled = true;
    splitBtn.textContent = 'splitting…';
    metaEl.textContent = 'asking the coordinator…';
    // never let a rejected invoke escape — it would leave the button wedged
    // at "splitting…" (main catches its own failures, this covers the rest)
    let res;
    try {
      res = await window.swarm.splitTask(text, ctx.workspaceId);
    } catch {
      res = null;
    }
    if (el.hidden) return; // closed while the call was in flight — ctx is gone
    if (!res || !res.ok) {
      splitBtn.disabled = false;
      splitBtn.textContent = 'Split';
      metaEl.textContent = (REASONS[res && res.reason] || 'the split failed') + ' — try rewording the request';
      return;
    }
    rows = res.items;
    inputEl.hidden = true;
    splitBtn.hidden = true;
    planEl.hidden = false;
    createBtn.hidden = false;
    metaEl.textContent = `${ctx.workspaceName} · ${rows.length} subtask${rows.length > 1 ? 's' : ''}`
      + ` · $${res.cost.toFixed(3)} to split · they run in parallel in one working copy — check that no two edit the same file`;
    renderPlan();
    syncFoot();
  }

  function createAll() {
    // 'auto' rather than 'now': the whole point is that the board's scheduler
    // decides how many of these can run at once and whether there is usage
    // headroom for them, instead of spawning N agents on the spot
    for (const row of rows) {
      if (!row.text.trim()) continue;
      ctx.onCreate({
        text: row.text.trim(),
        workspaceId: ctx.workspaceId,
        mode: 'auto',
        // same Options default the task composer pre-fills — without it every
        // coordinator subtask launched in manual-approval mode
        startMode: localStorage.getItem('swarmeye.defaultStartMode') || 'default',
        model: row.model,
        role: row.role,
      });
    }
    close();
  }

  function open(next) {
    ctx = next;
    el.hidden = false;
    showRequest();
    inputEl.value = '';
    Resizable.place(boxEl, SIZE_KEY);
    inputEl.focus();
  }

  function close() {
    if (!el.hidden) Resizable.remember(boxEl, SIZE_KEY);
    el.hidden = true;
    planEl.innerHTML = '';
    rows = [];
    ctx = null;
  }

  splitBtn.addEventListener('click', doSplit);
  createBtn.addEventListener('click', createAll);
  closeBtn.addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation(); // same reason as the plan rows
    // modHeld (app.js): Win+Enter must not fire a paid split call
    if (e.key === 'Enter' && modHeld(e)) doSplit();
  });

  return { open, close };
})();
