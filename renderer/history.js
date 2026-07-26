/* History screen: every past Claude conversation in a workspace, each
 * resumable in a fresh pane.
 *
 * Claude Code keeps a transcript per session under ~/.claude/projects/, and
 * `claude --resume <id>` reopens any of them — so closing a pane stops being
 * the end of that thread. main/history.js does the listing (through the
 * shell, since on Windows those files live inside WSL); this screen is the
 * picker.
 *
 * Same full-view-swap slot as the Task Board, Skills and Swarm View,
 * and self-contained the way Skills is: it fetches its own data over IPC.
 * The workspaces and the resume action come from app.js, which owns pane
 * state. Exposes the global `History`.
 */

const History = (() => {
  const listEl = document.getElementById('history-list');
  const emptyEl = document.getElementById('history-empty');
  const wsSel = document.getElementById('history-ws');
  const searchEl = document.getElementById('history-search');
  const refreshBtn = document.getElementById('history-refresh-btn');
  const archiveBtn = document.getElementById('history-archive-btn');
  const headTitleEl = document.getElementById('history-list-title');
  const headCountEl = document.getElementById('history-list-count');
  const deleteAllBtn = document.getElementById('history-delete-all');
  const modalEl = document.getElementById('hist-modal');
  const modalTitle = document.getElementById('hist-modal-title');
  const modalMeta = document.getElementById('hist-modal-meta');
  const modalBody = document.getElementById('hist-modal-body');
  const modalDl = document.getElementById('hist-modal-download');
  const modalClose = document.getElementById('hist-modal-close');

  let sessions = [];
  let workspaces = [];
  let workspaceId = null;
  let query = '';
  let handlers = null;
  let loading = false;
  let failed = false;
  // which half of the list is on screen. main/history.js flags everything past
  // the newest few as archived; this screen shows one set or the other
  let archiveShown = false;
  let listed = []; // the rows render() painted, and so what 🗑 Delete All deletes
  let openSession = null; // the row whose transcript the modal is showing
  let openTurns = null;   // …and its turns, so ⭳ doesn't re-read the file

  function fmtAgo(t) {
    if (!t) return 'unknown';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d < 30 ? d + 'd ago' : new Date(t).toLocaleDateString();
  }

  function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  function matches(s) {
    if (!query) return true;
    return (s.preview || '').toLowerCase().includes(query) || s.id.toLowerCase().includes(query);
  }

  function makeTurn(t) {
    const el = document.createElement('div');
    el.className = 'hist-turn hist-turn-' + t.role + (t.sub ? ' hist-turn-sub' : '');
    const who = document.createElement('div');
    who.className = 'hist-who';
    who.textContent = (t.role === 'user' ? 'you' : 'claude')
      + (t.sub ? ' · subagent' : '')
      + (t.at ? ' · ' + new Date(t.at).toLocaleString() : '');
    const text = document.createElement('pre');
    text.className = 'hist-turn-text';
    text.textContent = t.text;
    el.append(who, text);
    return el;
  }

  /* One conversation in full. Re-read on every open rather than cached — an
   * agent may still be appending to the file behind us. */
  async function openModal(s) {
    openSession = s;
    openTurns = null;
    modalTitle.textContent = s.preview ? s.preview.slice(0, 90) : 'Conversation';
    // mtime/size are unknown when the caller is a notification rather than a
    // listed row — those parts are dropped instead of printed as "unknown"
    modalMeta.textContent = [s.modifiedAt ? fmtAgo(s.modifiedAt) : null,
      s.size ? fmtSize(s.size) : null, s.id].filter(Boolean).join(' · ');
    modalBody.textContent = 'reading transcript…';
    modalEl.hidden = false;
    modalBody.scrollTop = 0;
    const turns = await window.swarm.readHistory(s.workspaceId, s.id);
    if (openSession !== s) return; // another row was clicked while we read
    openTurns = turns;
    modalBody.innerHTML = '';
    if (!turns) { modalBody.textContent = 'could not read this transcript'; return; }
    if (!turns.length) { modalBody.textContent = 'this transcript has no readable turns'; return; }
    for (const t of turns) modalBody.appendChild(makeTurn(t));
  }

  function closeModal() {
    modalEl.hidden = true;
    openSession = null;
    openTurns = null;
    modalBody.innerHTML = '';
  }

  function transcriptText(s, turns) {
    const head = [s.preview || '(conversation)', 'session ' + s.id, new Date(s.modifiedAt).toLocaleString()].join('\n');
    return head + '\n' + turns.map((t) => `\n───── ${t.role}${t.sub ? ' (subagent)' : ''}`
      + `${t.at ? ' · ' + new Date(t.at).toLocaleString() : ''} ─────\n${t.text}`).join('\n');
  }

  /* Save the conversation as text, through the same save dialog the pane's
   * own transcript export uses. */
  async function download(s, btn) {
    btn.disabled = true;
    try {
      const turns = (openSession === s && openTurns) || await window.swarm.readHistory(s.workspaceId, s.id);
      if (!turns || !turns.length) { toast('could not read that transcript'); return; }
      const res = await window.swarm.exportSession('conversation ' + s.id.slice(0, 8), transcriptText(s, turns));
      if (res && res.ok) toast('saved to ' + res.path);
      else if (res && res.reason) toast('save failed: ' + res.reason);
    } finally {
      btn.disabled = false;
    }
  }

  function makeRow(s) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.dataset.tip = 'Click to read the whole conversation';
    row.addEventListener('click', () => openModal(s));

    const body = document.createElement('div');
    body.className = 'hist-body';
    const prev = document.createElement('div');
    prev.className = 'hist-preview';
    prev.textContent = s.preview || '(no readable first message)';
    if (s.preview) prev.dataset.tip = s.preview;
    const meta = document.createElement('div');
    meta.className = 'hist-meta';
    meta.textContent = `${fmtAgo(s.modifiedAt)} · ${fmtSize(s.size)} · ${s.id}`;
    body.append(prev, meta);

    const resume = document.createElement('button');
    resume.className = 'hist-resume';
    resume.textContent = '▶ Resume';
    resume.dataset.tip = 'Open this conversation in a new agent pane (claude --resume)';
    resume.addEventListener('click', async (e) => {
      e.stopPropagation(); // the row itself opens the transcript
      resume.disabled = true;
      await handlers.onResume(s.workspaceId, s.id);
      resume.disabled = false;
    });

    const copy = document.createElement('button');
    copy.className = 'hist-copy';
    copy.textContent = '📋';
    copy.dataset.tip = 'Copy the session id';
    copy.addEventListener('click', (e) => {
      e.stopPropagation();
      window.swarm.copyText(s.id);
      toast('session id copied');
    });

    const dl = document.createElement('button');
    dl.className = 'hist-copy';
    dl.textContent = '⭳';
    dl.dataset.tip = 'Save this conversation as a text file';
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      download(s, dl);
    });

    const actions = document.createElement('div');
    actions.className = 'hist-actions';
    actions.append(copy, dl, resume);

    row.append(body, actions);
    return row;
  }

  function render() {
    listEl.innerHTML = '';
    const inSection = sessions.filter((s) => !!s.archived === archiveShown);
    // 🗑 acts on exactly these rows — the filtered ones, not the whole section,
    // so what the button deletes is always what is on screen
    listed = inSection.filter(matches);
    headTitleEl.textContent = archiveShown ? 'Archived ' : 'Recent ';
    headCountEl.textContent = inSection.length || '';
    deleteAllBtn.disabled = !listed.length;
    deleteAllBtn.textContent = listed.length ? `🗑 Delete All (${listed.length})` : '🗑 Delete All';
    deleteAllBtn.dataset.tip = `Permanently delete the ${listed.length} conversation`
      + `${listed.length === 1 ? '' : 's'} listed here from ~/.claude/projects`
      + ' — a running agent\'s own conversation is kept (click twice)';
    Confirm.restoreArmed(deleteAllBtn, purgeKey());
    emptyEl.hidden = listed.length > 0;
    emptyEl.textContent = loading ? 'reading transcripts…'
      : failed ? 'could not read ~/.claude/projects — is the shell reachable?'
      : !workspaceId ? 'add and select a workspace first'
      : inSection.length ? 'no conversation matches that filter'
      : archiveShown ? 'nothing archived — the 15 most recent conversations stay in History'
      : 'no past conversations for this workspace yet';
    for (const s of listed) listEl.appendChild(makeRow(s));
  }

  function toggleArchive(show) {
    Confirm.disarm(); // the same 🗑 element now stands for the other section
    archiveShown = show;
    archiveBtn.classList.toggle('active', show);
    archiveBtn.textContent = show ? '◀ History' : '🗄 Archive';
    render();
  }

  // per workspace and per section: the one 🗑 element deletes different files in
  // each, so an arm must never survive a switch as a single-click delete
  function purgeKey() {
    return `hist-purge:${workspaceId}:${archiveShown ? 'archived' : 'recent'}`;
  }

  /* Delete the conversations currently listed, by id — main takes the ids
   * rather than re-deriving a set, so the deletion cannot drift from the rows
   * the user was looking at, and it keeps back any transcript a running agent
   * is still writing. */
  async function purge() {
    const ids = listed.map((s) => s.id);
    deleteAllBtn.disabled = true;
    const res = await window.swarm.deleteHistory(workspaceId, ids);
    if (!res || !res.ok) toast('could not delete those conversations');
    else {
      toast(`${res.deleted} conversation${res.deleted === 1 ? '' : 's'} deleted`
        + (res.kept ? ` · ${res.kept} kept, in use by a running agent` : ''));
    }
    await load();
  }

  function fillWorkspaceSelect() {
    wsSel.innerHTML = '';
    for (const ws of workspaces) {
      const opt = document.createElement('option');
      opt.value = ws.id;
      opt.textContent = ws.name;
      wsSel.appendChild(opt);
    }
    if (workspaceId) wsSel.value = workspaceId;
  }

  async function load() {
    if (!workspaceId) { sessions = []; failed = false; render(); return; }
    loading = true;
    failed = false;
    render();
    const asked = workspaceId; // the picker can move while the read is in flight
    const res = await window.swarm.listHistory(asked);
    if (asked !== workspaceId) return;
    loading = false;
    failed = res == null;
    sessions = res || [];
    render();
  }

  /* app.js calls this every time the screen is opened — the transcript folder
   * changes under us as agents run, so the list is always re-read rather than
   * cached between visits. */
  async function refresh(wss, selectedId, h) {
    closeModal();
    Confirm.disarm(); // never reopen the screen with a 🗑 one click from firing
    workspaces = wss || [];
    handlers = h;
    if (!workspaces.some((w) => w.id === workspaceId)) {
      workspaceId = workspaces.some((w) => w.id === selectedId)
        ? selectedId
        : (workspaces[0] && workspaces[0].id) || null;
    }
    fillWorkspaceSelect();
    await load();
  }

  wsSel.addEventListener('change', () => {
    closeModal();
    Confirm.disarm(); // 🗑 was armed for the workspace being left, not this one
    workspaceId = wsSel.value;
    load();
  });
  modalClose.addEventListener('click', closeModal);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
  modalDl.addEventListener('click', () => { if (openSession) download(openSession, modalDl); });
  refreshBtn.addEventListener('click', () => load());
  archiveBtn.addEventListener('click', () => toggleArchive(!archiveShown));
  deleteAllBtn.addEventListener('click', () => {
    Confirm.armOrFire(deleteAllBtn, purgeKey(), purge);
  });
  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim().toLowerCase();
    render();
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchEl.value) {
      searchEl.value = '';
      query = '';
      render();
      e.stopPropagation();
    }
  });

  /* Read one conversation without going through this screen — the
   * notification centre opens a running agent's own transcript this way.
   * The modal is a fixed overlay outside #history-view, so it paints
   * wherever the app happens to be. */
  function openTranscript({ workspaceId: wsId, id, preview }) {
    openModal({ workspaceId: wsId, id, preview: preview || '', modifiedAt: 0, size: 0 });
  }

  return { refresh, closeModal, openTranscript };
})();
