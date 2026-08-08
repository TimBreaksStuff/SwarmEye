/* Diff: review what an agent changed, commit it, merge it back.
 *
 * The pane git chip stops at `diff --stat`; this is the rest of that story —
 * the full patch, per file, plus the two actions a worktree needs to be worth
 * having (main/worktree.js): commit inside it, and merge its branch into the
 * workspace.
 *
 * A popover rather than a sixth full-screen view: it floats over whatever is
 * up, and costs none of the view-toggle wiring. Its own root is built here, so
 * index.html gains nothing but a script tag. Exposes window.Diff.
 *
 * Everything is addressed by id — a workspace, a session, or a worktree by
 * name. The renderer never names a path; main resolves the repo (see
 * repoTarget in main/main.js). */

const Diff = (() => {
  const LINES_MAX = 2000; // one file's patch; beyond this the DOM cost stops being worth it

  let toast = () => {};
  let ws = null; // { id, name }
  let target = null; // { workspaceId, sessionId? , worktreeName? }
  let label = ''; // whose changes are on screen
  let branch = ''; // the branch those changes sit on, when it is a worktree
  let files = [];
  let untracked = [];
  let worktrees = [];
  let selected = 0;
  let loadToken = 0; // a second open/reload while one is in flight owns the box

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /* ---- the popover itself ---- */

  const SIZE_KEY = 'swarmeye.diffSize'; // drag the corner; kept between opens

  const pop = el('div');
  pop.id = 'diff-pop';
  pop.hidden = true;

  const head = el('div', 'diff-head');
  const titleEl = el('div', 'kbd-title diff-title', 'Review');
  const branchEl = el('span', 'diff-branch');
  const closeBtn = el('button', 'pill', 'Close');
  closeBtn.type = 'button';
  closeBtn.dataset.tip = 'Close (Esc)';
  head.append(titleEl, branchEl, closeBtn);

  const body = el('div', 'diff-body');
  const side = el('div', 'diff-side');
  const filesEl = el('div', 'diff-files');
  const wtHeadEl = el('div', 'diff-side-head', 'Worktrees');
  const wtEl = el('div', 'diff-worktrees');
  side.append(el('div', 'diff-side-head', 'Changed files'), filesEl, wtHeadEl, wtEl);
  const patchEl = el('div', 'diff-patch');
  body.append(side, patchEl);

  const foot = el('div', 'diff-foot');
  const noteEl = el('span', 'diff-note');
  const msgEl = document.createElement('input');
  msgEl.type = 'text';
  msgEl.className = 'diff-msg';
  msgEl.placeholder = 'commit message…';
  msgEl.maxLength = 500;
  msgEl.spellcheck = false;
  const commitBtn = el('button', 'pill', 'Commit');
  commitBtn.type = 'button';
  const mergeBtn = el('button', 'pill pill-primary', 'Merge');
  mergeBtn.type = 'button';
  foot.append(noteEl, msgEl, commitBtn, mergeBtn);

  pop.append(head, body, foot);
  document.body.appendChild(pop);

  /* ---- reading a patch ---- */

  /* One entry per file, in the order git emitted them. The name is taken from
   * the `b/` side, so a rename shows where the file ended up. */
  function parsePatch(text) {
    const out = [];
    let cur = null;
    for (const line of String(text || '').split('\n')) {
      if (line.startsWith('diff --git ')) {
        const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
        cur = { path: m ? m[2] : line.slice(11), lines: [] };
        out.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      }
    }
    return out;
  }

  function lineClass(line) {
    if (line.startsWith('@@')) return 'diff-line hunk';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return 'diff-line meta';
    if (line.startsWith('+')) return 'diff-line add';
    if (line.startsWith('-')) return 'diff-line del';
    if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')
      || line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('\\')) return 'diff-line meta';
    return 'diff-line';
  }

  function renderPatch() {
    patchEl.textContent = '';
    const file = files[selected];
    if (!file) {
      patchEl.append(el('div', 'diff-empty', untracked.length
        ? 'nothing tracked has changed — only untracked files'
        : 'no changes since HEAD'));
      return;
    }
    if (file.untracked) {
      patchEl.append(el('div', 'diff-empty', 'untracked — not part of the diff until it is added'));
      return;
    }
    const shown = file.lines.slice(0, LINES_MAX);
    for (const line of shown) {
      patchEl.append(el('div', lineClass(line), line || ' '));
    }
    if (file.lines.length > shown.length) {
      patchEl.append(el('div', 'diff-line meta', `… ${file.lines.length - shown.length} more lines`));
    }
  }

  function renderFiles() {
    filesEl.textContent = '';
    const rows = files.map((f, i) => ({ f, i }));
    if (!rows.length) filesEl.append(el('div', 'diff-empty', 'no changes'));
    for (const { f, i } of rows) {
      const row = el('button', 'diff-file' + (i === selected ? ' current' : '') + (f.untracked ? ' untracked' : ''));
      row.type = 'button';
      row.textContent = f.path;
      row.dataset.tip = f.path + (f.untracked ? ' — untracked' : '');
      row.addEventListener('click', () => { selected = i; renderFiles(); renderPatch(); });
      filesEl.append(row);
    }
  }

  /* Every worktree in this workspace: what is in it, whether an agent is still
   * working there, and — for the ones nobody is — a confirm-armed remove. This
   * is the only place a worktree left behind by a killed agent is visible. */
  function renderWorktrees() {
    const any = worktrees.length > 0;
    wtHeadEl.hidden = !any;
    wtEl.hidden = !any;
    wtEl.textContent = '';
    for (const w of worktrees) {
      const row = el('div', 'diff-wt' + (label === w.name ? ' current' : ''));
      const open = el('button', 'diff-wt-name');
      open.type = 'button';
      open.textContent = w.name;
      open.dataset.tip = `${w.branch} — ${w.ahead} commit${w.ahead === 1 ? '' : 's'} ahead${w.dirty ? ', uncommitted changes' : ''}`;
      open.addEventListener('click', () => showWorktree(w));
      const meta = el('span', 'diff-wt-meta',
        (w.ahead ? `${w.ahead}▲` : '') + (w.dirty ? ' ●' : '') + (w.live ? '' : ' idle'));
      row.append(open, meta);
      if (!w.live) {
        const rm = el('button', 'diff-wt-x', '✕');
        rm.type = 'button';
        rm.dataset.tip = 'Remove this worktree — its uncommitted changes go with it';
        rm.addEventListener('click', () => {
          Confirm.armOrFire(rm, 'wt:' + w.name, () => removeWorktree(w));
        });
        Confirm.restoreArmed(rm, 'wt:' + w.name);
        row.append(rm);
      }
      wtEl.append(row);
    }
  }

  function syncFoot() {
    branchEl.textContent = branch || '';
    branchEl.hidden = !branch;
    mergeBtn.hidden = !branch;
    mergeBtn.textContent = 'Merge ' + (branch || '');
    titleEl.textContent = 'Review · ' + label;
  }

  /* ---- loading ---- */

  async function load() {
    const token = ++loadToken;
    patchEl.textContent = '';
    patchEl.append(el('div', 'diff-empty', 'reading the diff…'));
    const [patch, list] = await Promise.all([
      window.swarm.gitPatch(target),
      window.swarm.listWorktrees(ws.id),
    ]);
    if (token !== loadToken || pop.hidden) return;
    files = patch ? parsePatch(patch.patch) : [];
    untracked = (patch && patch.untracked) || [];
    for (const p of untracked) files.push({ path: p, lines: [], untracked: true });
    if (patch && patch.truncated) {
      note('the patch was too large to show whole — the tail is cut');
    }
    worktrees = list || [];
    selected = 0;
    renderFiles();
    renderPatch();
    renderWorktrees();
    if (!patch) note('could not read the diff');
  }

  function note(text) {
    noteEl.textContent = text || '';
    noteEl.classList.toggle('warn', !!text);
  }

  /* ---- actions ---- */

  function showWorktree(w) {
    target = { workspaceId: ws.id, worktreeName: w.name };
    label = w.name;
    branch = w.branch;
    note('');
    syncFoot();
    load();
  }

  async function commit() {
    const message = msgEl.value.trim();
    if (!message) { msgEl.focus(); note('a commit needs a message'); return; }
    commitBtn.disabled = true;
    const res = await window.swarm.gitCommit(target, message);
    commitBtn.disabled = false;
    if (!res || !res.ok) { note((res && res.error) || 'commit failed'); return; }
    msgEl.value = '';
    note('');
    toast('committed in ' + label);
    load();
  }

  async function merge() {
    if (!branch) return;
    mergeBtn.disabled = true;
    const res = await window.swarm.gitMerge(ws.id, branch);
    mergeBtn.disabled = false;
    if (res && res.ok) {
      note('');
      toast(`merged ${branch} into ${ws.name}`);
      load();
      return;
    }
    const conflicts = (res && res.conflicts) || [];
    note(conflicts.length
      ? `conflicts in ${conflicts.join(', ')} — ${ws.name} was left untouched`
      : ((res && res.error) || 'merge failed'));
  }

  async function removeWorktree(w) {
    const res = await window.swarm.removeWorktree(ws.id, w.name);
    if (!res || !res.ok) { note((res && res.error) || 'could not remove the worktree'); return; }
    toast('removed worktree ' + w.name);
    // the popover may have been showing the thing that just went away
    if (target.worktreeName === w.name) showWorkspace();
    else load();
  }

  function showWorkspace() {
    target = { workspaceId: ws.id };
    label = ws.name;
    branch = '';
    syncFoot();
    load();
  }

  /* ---- open / close ---- */

  /* opts: the workspace (always), and optionally the session whose worktree is
   * being reviewed — a pane opens this on itself, the rail on the workspace. */
  function open(opts) {
    ws = { id: opts.workspaceId, name: opts.workspaceName || 'workspace' };
    if (opts.sessionId) {
      target = { workspaceId: ws.id, sessionId: opts.sessionId };
      label = opts.title || 'agent';
      branch = opts.branch || '';
    } else {
      target = { workspaceId: ws.id };
      label = ws.name;
      branch = '';
    }
    files = [];
    untracked = [];
    worktrees = [];
    msgEl.value = '';
    note('');
    syncFoot();
    pop.hidden = false;
    Resizable.place(pop, SIZE_KEY);
    load();
    msgEl.focus();
  }

  function close() {
    if (pop.hidden) return;
    Resizable.remember(pop, SIZE_KEY);
    pop.hidden = true;
    Confirm.disarm(); // an armed remove must not survive into the next open
    loadToken++;
  }

  function init(h) {
    toast = (h && h.toast) || (() => {});
    closeBtn.addEventListener('click', close);
    commitBtn.addEventListener('click', commit);
    mergeBtn.addEventListener('click', merge);
    msgEl.addEventListener('keydown', (e) => {
      e.stopPropagation(); // no agent cycling or app shortcuts while typing
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  return { init, open, close, isOpen: () => !pop.hidden };
})();

window.Diff = Diff;
