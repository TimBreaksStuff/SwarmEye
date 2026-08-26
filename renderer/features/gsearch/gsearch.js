/* Search across every agent's scrollback at once.
 *
 * A pane's own Ctrl+F searches one terminal; this one answers "which agent
 * said that?" without opening each pane to find out. Matches are grouped per
 * agent and capped at four rows each — the pane search is the right tool once
 * you know where to look, so jumping hands the query to it.
 *
 * Owns no app state: the panes, the current workspace and the two view
 * switches all arrive in `init`. */

let ctx = null;

export const popEl = document.getElementById('gsearch');
const btnEl = document.getElementById('gsearch-btn');
const inputEl = document.getElementById('gs-input');
const resultsEl = document.getElementById('gs-results');
let timer = null;

export function toggle(show) {
  // anchor the popup right below the button (the top bar can be zoomed)
  if (show) placePop(popEl, btnEl, { align: 'right', gap: 8 });
  popEl.hidden = !show;
  if (show) {
    inputEl.focus();
    inputEl.select();
    run();
  } else {
    const pane = ctx.focusedPane();
    if (pane) pane.term.focus();
  }
}

function run() {
  const q = inputEl.value.trim().toLowerCase();
  resultsEl.innerHTML = '';
  if (q.length < 2) return;
  let total = 0;
  for (const pane of ctx.state.panes.values()) {
    const lines = pane.getBufferText().split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) hits.push(i);
    }
    if (!hits.length) continue;
    total += hits.length;
    const group = document.createElement('div');
    group.className = 'gs-group';
    const head = document.createElement('div');
    head.className = 'gs-head';
    head.textContent = `${pane.session.agentName} · ${pane.session.workspaceName} · ${hits.length} match${hits.length > 1 ? 'es' : ''}`;
    group.appendChild(head);
    for (const i of hits.slice(0, 4)) {
      const row = document.createElement('div');
      row.className = 'gs-row';
      row.textContent = lines[i].trim().slice(0, 160) || '(blank line)';
      row.dataset.tip = 'Jump to this match';
      row.addEventListener('click', () => jumpToMatch(pane, i, inputEl.value.trim()));
      group.appendChild(row);
    }
    if (hits.length > 4) {
      const more = document.createElement('div');
      more.className = 'gs-more';
      more.textContent = `… ${hits.length - 4} more — jump in and use the pane search`;
      group.appendChild(more);
    }
    resultsEl.appendChild(group);
  }
  if (!total) {
    const none = document.createElement('div');
    none.className = 'gs-none';
    none.textContent = 'no matches in any agent';
    resultsEl.appendChild(none);
  }
}

async function jumpToMatch(pane, line, q) {
  toggle(false);
  ctx.toggleBoard(false);
  if (pane.session.workspaceId !== ctx.state.selectedWorkspaceId) {
    await ctx.selectWorkspace(pane.session.workspaceId);
  }
  pane.focus();
  pane.term.scrollToLine(line);
  pane.searchInput.value = q;
  pane.toggleSearch(true);
  pane.search.findNext(q);
}

export function init(context) {
  ctx = context;

  /* Every run translates each live pane's whole scrollback (up to 20k lines) —
   * pane.write() drops that memo on every chunk of agent output, so with a busy
   * swarm the work is real on every keystroke. Debounced long enough that typing
   * a word costs one pass rather than one per letter. */
  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggle(false); e.preventDefault(); }
    e.stopPropagation();
  });
  // click outside the popup closes it
  document.addEventListener('click', (e) => {
    if (!popEl.hidden && !popEl.contains(e.target)) toggle(false);
  });
  btnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(popEl.hidden);
  });
}
