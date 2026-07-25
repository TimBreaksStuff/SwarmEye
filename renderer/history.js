/* History screen: every past Claude conversation in a workspace, each
 * resumable in a fresh pane.
 *
 * Claude Code keeps a transcript per session under ~/.claude/projects/, and
 * `claude --resume <id>` reopens any of them — so closing a pane stops being
 * the end of that thread. main/history.js does the listing (through the
 * shell, since on Windows those files live inside WSL); this screen is the
 * picker.
 *
 * Same full-view-swap slot as the Task Board, Skills, Costs and Swarm View,
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

  let sessions = [];
  let workspaces = [];
  let workspaceId = null;
  let query = '';
  let handlers = null;
  let loading = false;
  let failed = false;

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

  function makeRow(s) {
    const row = document.createElement('div');
    row.className = 'hist-row';

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
    resume.addEventListener('click', async () => {
      resume.disabled = true;
      await handlers.onResume(s.workspaceId, s.id);
      resume.disabled = false;
    });

    const copy = document.createElement('button');
    copy.className = 'hist-copy';
    copy.textContent = '📋';
    copy.dataset.tip = 'Copy the session id';
    copy.addEventListener('click', () => {
      window.swarm.copyText(s.id);
      toast('session id copied');
    });

    const actions = document.createElement('div');
    actions.className = 'hist-actions';
    actions.append(copy, resume);

    row.append(body, actions);
    return row;
  }

  function render() {
    listEl.innerHTML = '';
    const visible = sessions.filter(matches);
    emptyEl.hidden = visible.length > 0;
    emptyEl.textContent = loading ? 'reading transcripts…'
      : failed ? 'could not read ~/.claude/projects — is the shell reachable?'
      : !workspaceId ? 'add and select a workspace first'
      : sessions.length ? 'no conversation matches that filter'
      : 'no past conversations for this workspace yet';
    for (const s of visible) listEl.appendChild(makeRow(s));
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
    workspaceId = wsSel.value;
    load();
  });
  refreshBtn.addEventListener('click', () => load());
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

  return { refresh };
})();
