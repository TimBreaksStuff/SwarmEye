/* Task board: queue todos for agents (pick a workspace, start now or let
 * the scheduler auto-start it), see manual/scheduled/active/completed at a glance.
 * Scheduling and task lifecycle live in app.js — this module only owns
 * rendering and the creation form. Exposes window.Board. */

const Board = (() => {
  const newBtn = document.getElementById('board-new-btn');
  const closeBtn = document.getElementById('board-close-btn');
  const formEl = document.getElementById('board-form');
  const textEl = document.getElementById('board-form-text');
  const wsSel = document.getElementById('board-form-ws');
  const categorySel = document.getElementById('board-form-category');
  const categoryManageBtn = document.getElementById('board-form-category-manage');
  const micBtn = document.getElementById('board-form-mic');
  const categoryPopEl = document.getElementById('board-category-pop');
  const categoryPopTitleEl = document.getElementById('board-category-pop-title');
  const categoryPopListEl = document.getElementById('board-category-pop-list');
  const categoryPopInputEl = document.getElementById('board-category-pop-input');
  const categoryPopAddBtn = document.getElementById('board-category-pop-add');
  const categoryFilterEl = document.getElementById('board-category-filter');
  const startModeSel = document.getElementById('board-form-startmode');
  const modelSel = document.getElementById('board-form-model');
  const effortSel = document.getElementById('board-form-effort');
  const focusToggle = document.getElementById('board-form-focus');
  const closeOnEndToggle = document.getElementById('board-form-closeonend');
  const prioritySel = document.getElementById('board-form-priority');
  const autoHint = document.getElementById('board-form-auto-hint');
  const cancelBtn = document.getElementById('board-form-cancel');
  const submitBtn = document.getElementById('board-form-submit');
  const modeRadios = [...document.querySelectorAll('input[name="board-mode"]')];

  const statsEl = document.getElementById('board-stats');
  const statTodayEl = document.getElementById('board-stats-today');
  const statWeekEl = document.getElementById('board-stats-week');
  const statMonthEl = document.getElementById('board-stats-month');
  const statYearEl = document.getElementById('board-stats-year');
  const statQuipEl = document.getElementById('board-stats-quip');

  const cols = {
    manual: document.getElementById('board-col-manual'),
    pending: document.getElementById('board-col-pending'),
    active: document.getElementById('board-col-active'),
    completed: document.getElementById('board-col-completed'),
  };
  const counts = {
    manual: document.getElementById('board-count-manual'),
    pending: document.getElementById('board-count-pending'),
    active: document.getElementById('board-count-active'),
    completed: document.getElementById('board-count-completed'),
  };
  const EMPTY_TEXT = {
    manual: 'no manual tasks',
    pending: 'no tasks queued',
    active: 'nothing running',
    completed: 'nothing finished yet',
  };

  const sessionViewEl = document.getElementById('session-view');
  const sessionViewTitleEl = document.getElementById('session-view-title');
  const sessionViewBodyEl = document.getElementById('session-view-body');
  const sessionViewExportBtn = document.getElementById('session-view-export');
  const sessionViewCloseBtn = document.getElementById('session-view-close');
  let sessionViewTask = null;
  let sessionViewHandlers = null;

  const archiveBtn = document.getElementById('board-archive-btn');
  const boardMainEl = document.getElementById('board-main');
  const archiveViewEl = document.getElementById('board-archive');
  const archiveListEl = document.getElementById('board-archive-list');
  const archiveCountEl = document.getElementById('board-archive-count');
  const archiveDeleteAllBtn = document.getElementById('board-archive-delete-all');
  const archiveSearchEl = document.getElementById('board-archive-search');
  const archivePriorityFilterEl = document.getElementById('board-archive-priority-filter');
  const archiveCategoryFilterEl = document.getElementById('board-archive-category-filter');
  let archiveShown = false;
  let lastArchiveHandlers = null;
  let lastArchivedTasks = [];
  let lastArchiveWorkspaces = [];
  let formWasOpenBeforeArchive = false;

  let autoUsageLimit = 85;
  let lastHandlers = null;
  // presets for a new task's own pickers, mirrored from the ⌨ Options panel
  const defaults = {
    defaultStartMode: 'default',
    defaultModel: 'default',
    defaultEffort: 'default',
    defaultFocus: false,
  };
  let lastTasks = [];
  let lastWorkspaces = [];

  // built once from Pane.MODES — the same source of truth as the per-pane
  // mode dropdown, so a mode never means something different in two places.
  // Pane.MODES labels its 'default' value "manual" (fine on its own, next to
  // no other "manual" concept) — but this select sits directly under the
  // board-mode scheduling radios, which have their own unrelated "manual"
  // option (stay off the scheduler until moved to Scheduled). Relabeled here
  // only, so the two stop reading as the same choice.
  startModeSel.dataset.tip = 'Claude’s starting permission mode for the agent — unrelated to the scheduling mode above';
  for (const [value, label] of Pane.MODES) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value === 'default' ? 'default' : label;
    startModeSel.appendChild(opt);
  }

  for (const [value, label] of Pane.MODELS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    modelSel.appendChild(opt);
  }

  for (const [value, label] of Pane.EFFORTS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    effortSel.appendChild(opt);
  }

  // startMode's own "manual" label (from Pane.MODES) reads as the same word
  // as the scheduling-mode badge right next to it — relabeled to "default"
  // here too, matching the picker above, so a card can't badge itself
  // "manual · manual" for two unrelated reasons.
  function modeLabel(startMode) {
    if (startMode === 'default' || !startMode) return 'default';
    const found = Pane.MODES.find(([v]) => v === startMode);
    return found ? found[1] : 'default';
  }

  // funny-feedback copy, tiered by how many tasks finished today — picked
  // deterministically from today's count + day-of-month so it holds steady
  // across re-renders instead of reshuffling on every board refresh
  const QUIP_TIERS = [
    { max: 0, quips: [
      "Blank scoreboard. The cursor blinks, waiting for greatness.",
      "Nothing shipped yet — the agents are as idle as you are.",
    ] },
    { max: 2, quips: [
      "One down, momentum is now technically real.",
      "Warming up the flux capacitor. Nice start.",
    ] },
    { max: 5, quips: [
      "Now we're vibing. Keep the streak alive.",
      "Solid pace — the rubber duck is impressed.",
    ] },
    { max: 9, quips: [
      "Certified task-shredder today. Hydrate, though.",
      "You're basically speedrunning your own backlog.",
    ] },
    { max: Infinity, quips: [
      "10+? Okay Flash Gordon, save some tasks for tomorrow.",
      "Are you even sleeping, or just compiling dreams into commits?",
    ] },
  ];

  function pickQuip(todayCount) {
    const tier = QUIP_TIERS.find((t) => todayCount <= t.max);
    const list = tier.quips;
    return list[(todayCount + new Date().getDate()) % list.length];
  }

  function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfWeek(ts) { const d = new Date(ts); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfMonth(ts) { const d = new Date(ts); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function startOfYear(ts) { const d = new Date(ts); d.setMonth(0, 1); d.setHours(0, 0, 0, 0); return d.getTime(); }

  // counts tasks completed today/this-week/this-month/this-year across both
  // the live board and the archive (archiving a task doesn't erase its
  // completedAt) — shown next to the new-task form to nudge you along
  function renderStats() {
    const now = Date.now();
    const dayStart = startOfDay(now);
    const weekStart = startOfWeek(now);
    const monthStart = startOfMonth(now);
    const yearStart = startOfYear(now);
    let today = 0, week = 0, month = 0, year = 0;
    for (const t of [...lastTasks, ...lastArchivedTasks]) {
      if (!t.completedAt) continue;
      if (t.completedAt >= yearStart) year++;
      if (t.completedAt >= monthStart) month++;
      if (t.completedAt >= weekStart) week++;
      if (t.completedAt >= dayStart) today++;
    }
    statTodayEl.textContent = today;
    statWeekEl.textContent = week;
    statMonthEl.textContent = month;
    statYearEl.textContent = year;
    statQuipEl.textContent = pickQuip(today);
  }

  function selectedRadio() {
    const r = modeRadios.find((r) => r.checked);
    return r ? r.value : 'now';
  }

  function updateAutoHint() {
    const mode = selectedRadio();
    autoHint.hidden = mode === 'now';
    if (mode === 'auto') autoHint.textContent = `starts once usage stays under ${autoUsageLimit}%`;
    else if (mode === 'next-session') autoHint.textContent = 'starts once the current usage session ends and a new one begins';
    else if (mode === 'manual') autoHint.textContent = 'stays in Manual until you move it to Scheduled';
  }

  // rebuilds the category select from the currently chosen workspace's
  // categories, keeping the previous pick only if it still exists there
  function populateCategorySelect() {
    const ws = lastWorkspaces.find((w) => w.id === wsSel.value);
    const cats = (ws && ws.categories) || [];
    const prev = categorySel.value;
    categorySel.innerHTML = '';
    for (const c of cats) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      categorySel.appendChild(opt);
    }
    if (cats.includes(prev)) categorySel.value = prev;
    else if (cats.includes('maintenance')) categorySel.value = 'maintenance';
    else if (cats.length) categorySel.value = cats[0];
  }

  // shared by the live-board and archive category filters: every category
  // any workspace currently defines, plus any category still sitting on a
  // task even if its workspace later deleted that category
  function populateCategoryFilter(selectEl, tasksList, workspaces) {
    const names = new Set();
    for (const ws of workspaces) for (const c of ws.categories || []) names.add(c);
    for (const t of tasksList) if (t.category) names.add(t.category);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    const prev = selectEl.value;
    selectEl.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'all categories';
    selectEl.appendChild(allOpt);
    for (const name of sorted) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      selectEl.appendChild(opt);
    }
    if (sorted.includes(prev)) selectEl.value = prev;
  }

  function showForm(show) {
    stopDictation(); // opening, clearing (submit) or hiding the form must release the mic
    formEl.hidden = !show;
    statsEl.hidden = !show;
    if (show) {
      textEl.value = '';
      submitBtn.disabled = true;
      startModeSel.value = defaults.defaultStartMode;
      modelSel.value = defaults.defaultModel;
      effortSel.value = defaults.defaultEffort;
      focusToggle.checked = defaults.defaultFocus;
      closeOnEndToggle.checked = true;
      prioritySel.value = 'medium';
      if (categorySel.querySelector('option[value="maintenance"]')) categorySel.value = 'maintenance';
      updateAutoHint();
      renderStats();
      textEl.focus();
    }
  }

  // Tab/letters typed here must not fall through to the document-level
  // shortcut handler (bare Tab would cycle agents mid-edit) — Escape is the
  // one key left alone so it bubbles up to app.js's board-close handling,
  // which this module doesn't own.
  formEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
    if ((e.ctrlKey || (window.swarm.isMac && e.metaKey)) && e.key === 'Enter' && !submitBtn.disabled) {
      e.preventDefault();
      submitBtn.click();
    }
  });

  textEl.addEventListener('input', () => {
    submitBtn.disabled = !textEl.value.trim();
  });

  // dropping files onto the task text pastes their paths at the cursor —
  // same path-rewriting convention as dropping onto a running agent's
  // terminal (pane.js), just inserted into a textarea instead of xterm
  textEl.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    textEl.classList.add('file-drop');
  });
  textEl.addEventListener('dragleave', () => textEl.classList.remove('file-drop'));
  textEl.addEventListener('drop', (e) => {
    textEl.classList.remove('file-drop');
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files]
      .map((f) => window.swarm.pathForFile(f))
      .filter(Boolean)
      .map(agentPath)
      .map((p) => (/\s/.test(p) ? `"${p}"` : p));
    if (!paths.length) return;
    const insert = paths.join(' ') + ' ';
    const start = textEl.selectionStart ?? textEl.value.length;
    const end = textEl.selectionEnd ?? textEl.value.length;
    textEl.value = textEl.value.slice(0, start) + insert + textEl.value.slice(end);
    textEl.selectionStart = textEl.selectionEnd = start + insert.length;
    textEl.dispatchEvent(new Event('input'));
    textEl.focus();
  });
  // stops an in-progress dictation (no-op otherwise) — without this the mic
  // kept recording invisibly after submit/cancel/board-close, and the next
  // recognition result resurrected the previous task's text in the cleared box
  let stopDictation = () => {};
  if (!window.Speech || !window.Speech.supported) {
    micBtn.style.display = 'none';
  } else {
    let dictating = false;
    let micBase = '';
    stopDictation = () => { if (dictating) window.Speech.stop(); };
    micBtn.addEventListener('click', () => {
      if (dictating) { window.Speech.stop(); return; }
      micBase = textEl.value;
      if (micBase && !/\s$/.test(micBase)) micBase += ' ';
      dictating = true;
      micBtn.classList.add('listening');
      window.Speech.start({
        interim: true,
        onResult: (text, isFinal) => {
          textEl.value = micBase + text;
          textEl.dispatchEvent(new Event('input'));
          if (isFinal) {
            micBase = textEl.value;
            if (!/\s$/.test(micBase)) micBase += ' ';
          }
        },
        onEnd: () => { dictating = false; micBtn.classList.remove('listening'); },
        onError: (err) => {
          dictating = false;
          micBtn.classList.remove('listening');
          if (err === 'not-allowed' || err === 'service-not-allowed') toast('microphone permission denied');
          else if (err === 'not-installed') toast('dictation engine not installed — install it in ⌨ Options');
        },
      });
    });
  }
  modeRadios.forEach((r) => r.addEventListener('change', updateAutoHint));
  newBtn.addEventListener('click', () => showForm(formEl.hidden));
  cancelBtn.addEventListener('click', () => showForm(false));
  wsSel.addEventListener('change', populateCategorySelect);
  submitBtn.addEventListener('click', () => {
    const text = textEl.value.trim();
    if (!text || !wsSel.value || !lastHandlers) return;
    lastHandlers.onCreate({
      text,
      workspaceId: wsSel.value,
      mode: selectedRadio(),
      startMode: startModeSel.value,
      model: modelSel.value,
      effort: effortSel.value,
      focus: focusToggle.checked,
      closeOnComplete: closeOnEndToggle.checked,
      priority: prioritySel.value,
      category: categorySel.value,
    });
    showForm(true);
  });

  // category-manage popover: add/remove categories for whichever workspace
  // is currently picked in the new-task form
  function renderCategoryPop() {
    const ws = lastWorkspaces.find((w) => w.id === wsSel.value);
    categoryPopTitleEl.textContent = 'Categories' + (ws ? ' (' + ws.name + ')' : '');
    categoryPopListEl.innerHTML = '';
    const cats = (ws && ws.categories) || [];
    if (!cats.length) {
      const empty = document.createElement('div');
      empty.className = 'board-col-empty';
      empty.textContent = 'no categories — add one below';
      categoryPopListEl.appendChild(empty);
    }
    for (const c of cats) {
      const row = document.createElement('div');
      row.className = 'arch-row';
      const info = document.createElement('div');
      info.className = 'arch-info arch-name';
      info.textContent = c;
      const del = document.createElement('button');
      del.className = 'arch-del';
      del.textContent = '✕';
      del.dataset.tip = 'Remove category (click twice)';
      del.addEventListener('click', () => {
        armOrFire(del, 'cat:' + ws.id + ':' + c, () => lastHandlers && lastHandlers.onRemoveCategory(ws.id, c));
      });
      restoreArmed(del, 'cat:' + ws.id + ':' + c);
      row.append(info, del);
      categoryPopListEl.appendChild(row);
    }
  }

  function addCategoryFromPop() {
    const ws = lastWorkspaces.find((w) => w.id === wsSel.value);
    const name = categoryPopInputEl.value.trim();
    if (!ws || !name || !lastHandlers) return;
    lastHandlers.onAddCategory(ws.id, name);
    categoryPopInputEl.value = '';
  }
  categoryPopAddBtn.addEventListener('click', addCategoryFromPop);

  // stop keys from falling through to the document-level shortcut handler
  // (same reason as formEl above) — Escape closes just this popover
  categoryPopEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); addCategoryFromPop(); }
    else if (e.key === 'Escape') { e.preventDefault(); categoryPopEl.hidden = true; }
  });

  categoryManageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (categoryPopEl.hidden) {
      const r = categoryManageBtn.getBoundingClientRect();
      categoryPopEl.style.top = Math.round(r.bottom + 8) + 'px';
      categoryPopEl.style.left = Math.max(8, Math.round(r.left)) + 'px';
      renderCategoryPop();
    }
    categoryPopEl.hidden = !categoryPopEl.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!categoryPopEl.hidden && !categoryPopEl.contains(e.target)) categoryPopEl.hidden = true;
  });

  /* arm/confirm state for the ✕ buttons lives here, not as a CSS class alone —
   * the board rebuilds its cards on git polls and task events, which would
   * wipe an armed button mid-confirm and make the second click just re-arm */
  let armedDelete = { key: null, until: 0 };
  function armOrFire(btn, key, fire) {
    if (armedDelete.key === key && Date.now() < armedDelete.until) {
      armedDelete = { key: null, until: 0 };
      fire();
      return;
    }
    armedDelete = { key, until: Date.now() + 3000 };
    btn.classList.add('armed');
    setTimeout(() => btn.classList.remove('armed'), 3000);
  }
  function restoreArmed(btn, key) {
    if (armedDelete.key === key && Date.now() < armedDelete.until) btn.classList.add('armed');
  }

  // shared by the live board and the archive view — who/badges/meta/text are
  // identical, only the action row (start/jump vs. permanent delete) differs
  // completed-task transcript popup — the scrollback captured by app.js the
  // moment a task finished, so you can review what an agent actually did
  // after its pane is long gone. Works the same from the live board and the
  // archive, since both pass the same handlers object through.
  function openSessionView(task, workspaces, handlers) {
    sessionViewTask = task;
    sessionViewHandlers = handlers;
    const ws = workspaces.find((w) => w.id === task.workspaceId);
    const agentName = handlers.getPaneAgentName(task.paneId);
    sessionViewTitleEl.textContent = [agentName, ws && ws.name].filter(Boolean).join(' — ') || 'session';
    sessionViewBodyEl.textContent = task.sessionLog || '';
    sessionViewEl.hidden = false;
  }

  function closeSessionView() {
    sessionViewEl.hidden = true;
    sessionViewTask = null;
    sessionViewHandlers = null;
  }

  sessionViewCloseBtn.addEventListener('click', closeSessionView);
  sessionViewExportBtn.addEventListener('click', () => {
    if (sessionViewTask && sessionViewHandlers) sessionViewHandlers.onExportSession(sessionViewTask);
  });
  // click on the dimmed backdrop (not the box itself) closes it
  sessionViewEl.addEventListener('click', (e) => {
    if (e.target === sessionViewEl) closeSessionView();
  });

  const PRIORITIES = [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['critical', 'critical']];

  /* the priority/category badges on a not-yet-running card double as pickers.
   * Rendered as real <select>s styled like the static badges, so editing is
   * one click with no popover machinery. `card` is needed to suspend its own
   * draggable while the dropdown is being used, or the mousedown that opens
   * the list starts a card drag instead. */
  function makeCardSelect(card, className, options, value, onPick) {
    const sel = document.createElement('select');
    sel.className = 'board-card-select ' + className;
    for (const [v, label] of options) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('mousedown', () => { card.draggable = false; });
    // renders were skipped while this held focus — catch up now that it
    // doesn't, so a card the category filter should hide actually goes
    sel.addEventListener('blur', () => { card.draggable = true; renderCols(); });
    sel.addEventListener('click', (e) => e.stopPropagation()); // jumpable cards jump on click — not from here
    sel.addEventListener('change', () => onPick(sel.value));
    return sel;
  }

  function priorityPicker(card, task, handlers) {
    const value = task.priority || 'medium';
    const sel = makeCardSelect(card, 'board-card-priority board-card-priority-' + value, PRIORITIES, value, (v) => {
      // recolor now: the re-render that follows is skipped while this select
      // still holds focus (see renderCols), so the badge would keep the old hue
      sel.className = 'board-card-select board-card-priority board-card-priority-' + v;
      handlers.onSetPriority(task.id, v);
    });
    sel.dataset.tip = 'Priority — auto mode starts higher-priority tasks first';
    return sel;
  }

  function categoryPicker(card, task, workspaces, handlers) {
    const ws = workspaces.find((w) => w.id === task.workspaceId);
    const names = [...((ws && ws.categories) || [])];
    // a task keeps its category even if the workspace later drops it — listing
    // it anyway stops the picker from silently reading as "(none)"
    if (task.category && !names.includes(task.category)) names.push(task.category);
    const options = [['', '(none)'], ...names.map((c) => [c, c])];
    const sel = makeCardSelect(card, 'board-card-category', options, task.category || '', (v) => {
      handlers.onSetCategory(task.id, v);
    });
    sel.dataset.tip = 'Category';
    return sel;
  }

  function buildCardBody(card, task, workspaces, handlers, editable) {
    const top = document.createElement('div');
    top.className = 'board-card-top';
    const whoWrap = document.createElement('span');
    whoWrap.className = 'board-card-who-wrap';
    if (task.status === 'active') {
      const dot = document.createElement('span');
      dot.className = 'board-card-dot';
      dot.dataset.tip = 'active';
      whoWrap.appendChild(dot);
    }
    const who = document.createElement('span');
    who.className = 'board-card-who';
    const agentName = handlers.getPaneAgentName(task.paneId);
    const ws = workspaces.find((w) => w.id === task.workspaceId);
    who.textContent = ws ? ws.name : '(removed)';
    whoWrap.appendChild(who);
    const badges = document.createElement('span');
    badges.className = 'board-card-badges';
    const badge = document.createElement('span');
    badge.className = 'board-card-badge';
    const modeText = task.mode === 'auto' ? 'auto' : task.mode === 'next-session' ? 'next session' : task.mode === 'manual' ? 'manual' : 'now';
    badge.textContent = modeText + ' · ' + modeLabel(task.startMode);
    if (editable) {
      badges.appendChild(priorityPicker(card, task, handlers));
      badges.appendChild(categoryPicker(card, task, workspaces, handlers));
    } else {
      const priority = document.createElement('span');
      priority.className = 'board-card-priority board-card-priority-' + (task.priority || 'medium');
      priority.textContent = task.priority || 'medium';
      badges.appendChild(priority);
      if (task.category) {
        const cat = document.createElement('span');
        cat.className = 'board-card-category';
        cat.textContent = task.category;
        badges.appendChild(cat);
      }
    }
    badges.appendChild(badge);
    top.append(whoWrap, badges);
    card.appendChild(top);

    // agent/branch detail row — only meaningful once a task has a live or
    // former agent attached (pending tasks have neither yet)
    const git = handlers.getGit(task.workspaceId);
    if (agentName || (git && git.branch)) {
      const meta = document.createElement('div');
      meta.className = 'board-card-meta';
      if (agentName) {
        const agentEl = document.createElement('span');
        agentEl.className = 'board-card-agent';
        agentEl.textContent = '▸ ' + agentName;
        agentEl.dataset.tip = 'agent: ' + agentName;
        meta.appendChild(agentEl);
      }
      if (git && git.branch) {
        const branchEl = document.createElement('span');
        branchEl.className = 'board-card-branch';
        branchEl.textContent = '⎇ ' + git.branch;
        branchEl.classList.toggle('dirty', !!git.dirty);
        branchEl.dataset.tip = git.dirty
          ? `branch ${git.branch} — uncommitted changes`
          : `branch ${git.branch} — clean`;
        meta.appendChild(branchEl);
      }
      card.appendChild(meta);
    }

    const text = document.createElement('div');
    text.className = 'board-card-text';
    text.textContent = task.text;
    text.dataset.tip = task.text;
    card.appendChild(text);

    return agentName;
  }

  // shared by both card renderers — re-queues a completed task as a fresh
  // 'now' task with the same text/settings, so a one-off task doesn't have
  // to be retyped from scratch to run it again
  function addRunAgainButton(actions, task, handlers) {
    if (task.status !== 'completed') return;
    const btn = document.createElement('button');
    btn.className = 'board-card-rerun';
    btn.dataset.tip = 'Run this task again';
    btn.textContent = '⟳';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onRunAgain(task);
    });
    actions.appendChild(btn);
  }

  // shared by both card renderers — only a completed task ever has a
  // sessionLog (captured by app.js when the task finishes), so this quietly
  // no-ops for every other status
  function addSessionButton(actions, task, workspaces, handlers) {
    if (!task.sessionLog) return;
    const viewBtn = document.createElement('button');
    viewBtn.className = 'board-card-session';
    viewBtn.dataset.tip = 'View agent session transcript';
    viewBtn.textContent = '▤';
    viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionView(task, workspaces, handlers);
    });
    actions.appendChild(viewBtn);
  }

  /* drag & drop between columns. Manual/pending/active cards move; nothing
   * un-completes, so Completed accepts nothing. Dragging Active back to
   * Manual or Scheduled stops the running agent first (onStopAndMove) —
   * same as dragging manual/pending across each other (plain onMoveStatus),
   * and dragging manual/pending onto Active starts it (identical to ▶). */
  const DROP_TARGETS = {
    manual: {
      accepts: ['pending', 'active'],
      apply: (id, from) => (from === 'active' ? lastHandlers.onStopAndMove(id, 'manual') : lastHandlers.onMoveStatus(id, 'manual')),
    },
    pending: {
      accepts: ['manual', 'active'],
      apply: (id, from) => (from === 'active' ? lastHandlers.onStopAndMove(id, 'pending') : lastHandlers.onMoveStatus(id, 'pending')),
    },
    active: { accepts: ['manual', 'pending'], apply: (id) => lastHandlers.onStart(id) },
  };
  let draggingTask = null; // { id, status } while a card is in flight

  function clearDropHighlights() {
    for (const key of Object.keys(DROP_TARGETS)) cols[key].classList.remove('drag-over');
  }

  for (const [key, target] of Object.entries(DROP_TARGETS)) {
    const list = cols[key];
    const accepts = () => draggingTask && target.accepts.includes(draggingTask.status);
    list.addEventListener('dragover', (e) => {
      if (!accepts()) return;
      e.preventDefault(); // the only way to declare this a valid drop target
      e.dataTransfer.dropEffect = 'move';
      list.classList.add('drag-over');
    });
    // fires when crossing onto a child too — only a move that actually left
    // the column should drop the highlight
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) list.classList.remove('drag-over');
    });
    list.addEventListener('drop', (e) => {
      clearDropHighlights();
      if (!accepts()) return;
      e.preventDefault();
      const id = draggingTask.id;
      const from = draggingTask.status;
      draggingTask = null; // cleared before apply(), whose re-render must not be skipped
      target.apply(id, from);
    });
  }

  function makeDraggable(card, task) {
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      draggingTask = { id: task.id, status: task.status };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      clearDropHighlights();
      if (!draggingTask) return; // dropped: apply() already re-rendered
      draggingTask = null;
      renderCols(); // cancelled drag — replay the renders skipped meanwhile
    });
  }

  /* Board and archive cards share their shell, their actions row and their ✕;
   * they differ in the middle (an archive card has no move/start controls) and
   * in what the ✕ does — archive vs permanently delete. */
  function makeCardShell(task) {
    const card = document.createElement('div');
    card.className = 'board-card board-card-' + task.status + (task.stopped ? ' board-card-stopped' : '');
    return card;
  }

  function makeActionsRow(task) {
    const actions = document.createElement('div');
    actions.className = 'board-card-actions';
    if (task.status === 'completed' && task.stopped) {
      const stoppedBadge = document.createElement('span');
      stoppedBadge.className = 'board-card-stopped-badge';
      stoppedBadge.textContent = '■ stopped';
      stoppedBadge.dataset.tip = 'You stopped this agent before it finished';
      actions.appendChild(stoppedBadge);
    }
    return actions;
  }

  function addDeleteButton(actions, { tip, key, fire }) {
    const delBtn = document.createElement('button');
    delBtn.className = 'board-del';
    delBtn.textContent = '✕';
    delBtn.dataset.tip = tip;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      armOrFire(delBtn, key, fire);
    });
    restoreArmed(delBtn, key);
    actions.appendChild(delBtn);
  }

  function makeCard(task, workspaces, handlers) {
    const card = makeCardShell(task);

    const editable = task.status === 'manual' || task.status === 'pending';
    // active cards drag too — dropping one on Manual/Scheduled stops the
    // agent (see DROP_TARGETS above); they just don't get the inline
    // priority/category pickers `editable` grants.
    if (editable || task.status === 'active') makeDraggable(card, task);

    const agentName = buildCardBody(card, task, workspaces, handlers, editable);

    const actions = makeActionsRow(task);

    if (task.status === 'manual') {
      const rightBtn = document.createElement('button');
      rightBtn.className = 'board-card-move';
      rightBtn.dataset.tip = 'Move to Scheduled';
      rightBtn.textContent = '→';
      rightBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onMoveStatus(task.id, 'pending');
      });
      actions.appendChild(rightBtn);
    } else if (task.status === 'pending') {
      const leftBtn = document.createElement('button');
      leftBtn.className = 'board-card-move';
      leftBtn.dataset.tip = 'Move to Manual';
      leftBtn.textContent = '←';
      leftBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onMoveStatus(task.id, 'manual');
      });
      actions.appendChild(leftBtn);

      const startBtn = document.createElement('button');
      startBtn.className = 'board-card-start';
      startBtn.dataset.tip = 'Start this task now';
      startBtn.textContent = '▶ start';
      startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onStart(task.id);
      });
      actions.appendChild(startBtn);
    } else if (agentName) {
      // active/completed cards with a live pane jump to it on click
      card.classList.add('jumpable');
      card.dataset.tip = 'Jump to this agent';
      card.addEventListener('click', () => handlers.onJump(task.paneId));
    }

    addRunAgainButton(actions, task, handlers);
    addSessionButton(actions, task, workspaces, handlers);

    addDeleteButton(actions, {
      tip: task.status === 'active'
        ? 'Archive (click twice) — does not stop the agent'
        : 'Archive (click twice)',
      key: 'del:' + task.id,
      fire: () => handlers.onDelete(task.id),
    });

    card.appendChild(actions);
    return card;
  }

  function makeArchiveCard(task, workspaces, handlers) {
    const card = makeCardShell(task);

    buildCardBody(card, task, workspaces, handlers, false);

    const actions = makeActionsRow(task);

    addRunAgainButton(actions, task, handlers);
    addSessionButton(actions, task, workspaces, handlers);

    addDeleteButton(actions, {
      tip: 'Permanently delete (click twice)',
      key: 'purge:' + task.id,
      fire: () => handlers.onPurge(task.id),
    });

    card.appendChild(actions);
    return card;
  }

  function renderCols() {
    // renders arrive on git polls and hook events — rebuilding the cards
    // mid-interaction would yank the dragged card out from under the cursor
    // (cancelling the drag) or snap an open priority/category picker shut.
    // Both paths re-render themselves once done.
    if (draggingTask) return;
    if (document.activeElement && document.activeElement.classList.contains('board-card-select')) return;

    const categoryFilter = categoryFilterEl.value;
    const filtered = categoryFilter ? lastTasks.filter((t) => (t.category || '') === categoryFilter) : lastTasks;
    const byStatus = { manual: [], pending: [], active: [], completed: [] };
    for (const t of filtered) (byStatus[t.status] || byStatus.pending).push(t);

    for (const key of ['manual', 'pending', 'active', 'completed']) {
      const list = byStatus[key].sort((a, b) => a.createdAt - b.createdAt);
      cols[key].innerHTML = '';
      counts[key].textContent = list.length || '';
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'board-col-empty';
        empty.textContent = EMPTY_TEXT[key];
        cols[key].appendChild(empty);
      } else {
        for (const t of list) cols[key].appendChild(makeCard(t, lastWorkspaces, lastHandlers));
      }
    }
  }
  categoryFilterEl.addEventListener('change', renderCols);

  function render(tasks, archivedTasks, workspaces, limit, handlers) {
    autoUsageLimit = limit;
    lastHandlers = handlers;
    lastTasks = tasks;
    lastArchivedTasks = archivedTasks;
    lastWorkspaces = workspaces;
    if (!formEl.hidden) { updateAutoHint(); renderStats(); }

    // refresh the pickers (not user-typed state, safe to rebuild) — unless
    // one is focused/open right now: renders arrive on git polls and hook
    // events, and rebuilding would snap its dropdown shut mid-selection
    const active = document.activeElement;
    if (active !== wsSel && active !== categorySel && active !== categoryFilterEl) {
      const prevWs = wsSel.value;
      wsSel.innerHTML = '';
      for (const ws of workspaces) {
        const opt = document.createElement('option');
        opt.value = ws.id;
        opt.textContent = ws.name;
        wsSel.appendChild(opt);
      }
      if (workspaces.some((w) => w.id === prevWs)) wsSel.value = prevWs;
      populateCategorySelect();
      populateCategoryFilter(categoryFilterEl, tasks, workspaces);
    }
    if (!categoryPopEl.hidden) renderCategoryPop();

    renderCols();
  }

  function renderArchive(archivedTasks, workspaces, handlers) {
    lastArchiveHandlers = handlers;
    lastArchivedTasks = archivedTasks;
    lastArchiveWorkspaces = workspaces;
    // same open-dropdown guard as render() above
    if (document.activeElement !== archiveCategoryFilterEl) {
      populateCategoryFilter(archiveCategoryFilterEl, archivedTasks, workspaces);
    }
    renderArchiveList();
  }

  function renderArchiveList() {
    const query = archiveSearchEl.value.trim().toLowerCase();
    const priorityFilter = archivePriorityFilterEl.value;
    const categoryFilter = archiveCategoryFilterEl.value;
    let list = [...lastArchivedTasks].sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
    if (priorityFilter) list = list.filter((t) => (t.priority || 'medium') === priorityFilter);
    if (categoryFilter) list = list.filter((t) => (t.category || '') === categoryFilter);
    if (query) list = list.filter((t) => (t.text || '').toLowerCase().includes(query));

    archiveCountEl.textContent = list.length || '';
    archiveDeleteAllBtn.disabled = !lastArchivedTasks.length;
    archiveListEl.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'board-col-empty';
      empty.textContent = lastArchivedTasks.length ? 'no archived tasks match' : 'no archived tasks';
      archiveListEl.appendChild(empty);
    } else {
      for (const t of list) archiveListEl.appendChild(makeArchiveCard(t, lastArchiveWorkspaces, lastArchiveHandlers));
    }
  }

  archiveSearchEl.addEventListener('input', renderArchiveList);
  archivePriorityFilterEl.addEventListener('change', renderArchiveList);
  archiveCategoryFilterEl.addEventListener('change', renderArchiveList);

  function toggleArchive(show) {
    archiveShown = show;
    boardMainEl.hidden = show;
    archiveViewEl.hidden = !show;
    archiveBtn.classList.toggle('active', show);
    archiveBtn.textContent = show ? '◀ Board' : '🗄 Archive';
    if (show) {
      stopDictation(); // the form is hidden without going through showForm
      formWasOpenBeforeArchive = !formEl.hidden;
      formEl.hidden = true;
    } else if (formWasOpenBeforeArchive) {
      formWasOpenBeforeArchive = false;
      formEl.hidden = false;
    }
  }

  archiveBtn.addEventListener('click', () => toggleArchive(!archiveShown));
  archiveDeleteAllBtn.addEventListener('click', () => {
    if (!lastArchiveHandlers) return;
    if (archiveDeleteAllBtn.classList.contains('armed')) { lastArchiveHandlers.onPurgeAll(); return; }
    archiveDeleteAllBtn.classList.add('armed');
    setTimeout(() => archiveDeleteAllBtn.classList.remove('armed'), 3000);
  });

  function setDefaults(patch) {
    Object.assign(defaults, patch);
  }

  return { render, renderArchive, toggleArchive, setDefaults, showForm, closeSessionView, stopDictation: () => stopDictation() };
})();

window.Board = Board;
