/* Activity: what one agent has actually been doing.
 *
 * The pane header names the call in flight; this is the rest of it — every call
 * this session in the order they ran, each with what it was on, how long it
 * took and whether it failed, above the files the agent has read and the files
 * it has written.
 *
 * All of it is already in the pane (see noteCall in pane.js), so this reads
 * pane state directly and asks main for nothing. A popover rather than a column
 * beside the terminal: the pane is the most contended file in the repo and a
 * column inside it is layout surgery, while this costs a script tag and a line
 * in ESCAPABLE. Exposes window.Activity. */

const Activity = (() => {
  const ROWS_MAX = 60; // the pane keeps this many; the list is the tail, newest first
  const FILES_MAX = 40; // per column, before "+n more"

  let pane = null;
  let raf = 0;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const pop = el('div');
  pop.id = 'activity-pop';
  pop.hidden = true;

  const head = el('div', 'activity-head');
  const titleEl = el('div', 'kbd-title activity-title', 'Activity');
  const countEl = el('span', 'activity-count');
  const closeBtn = el('button', 'pill', 'Close');
  closeBtn.type = 'button';
  closeBtn.dataset.tip = 'Close (Esc)';
  head.append(titleEl, countEl, closeBtn);

  const callsEl = el('div', 'activity-calls');
  const subsEl = el('div', 'activity-subs');
  const filesEl = el('div', 'activity-files');
  const readsEl = el('div', 'activity-col');
  const writesEl = el('div', 'activity-col');
  filesEl.append(readsEl, writesEl);
  const noteEl = el('div', 'activity-note',
    'Calls are read from the hook stream, so a burst can lose a row — the terminal is the record.');

  pop.append(head, callsEl, subsEl, filesEl, noteEl);
  document.body.appendChild(pop);

  /* A duration in the shortest form that is still honest — a 40ms Read and a
   * 40s Bash have to be told apart at a glance. */
  function fmtMs(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  /* Paths are shown from the workspace down: the leading directories are the
   * same for every row and push the part that differs off the end. */
  function shortPath(p) {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? String(p) : parts.slice(-2).join('/');
  }

  function renderCalls() {
    const rows = pane.activity.slice(-ROWS_MAX).reverse();
    callsEl.textContent = '';
    if (!rows.length) {
      callsEl.append(el('div', 'activity-empty', 'no tool calls seen yet'));
      return;
    }
    for (const call of rows) {
      const row = el('div', 'activity-row'
        + (call.failed ? ' failed' : '')
        + (call.cancelled ? ' cancelled' : '')
        + (call.done ? '' : ' live'));
      row.append(el('span', 'activity-tool', call.tool || 'tool'));
      // a path is shown from the workspace down, like the file columns below;
      // a command or a pattern is shown as it was written. The full string is
      // on the tooltip either way.
      const isPath = call.target && !/\s/.test(call.target) && /[\\/]/.test(call.target);
      const target = el('span', 'activity-target', isPath ? shortPath(call.target) : (call.target || ''));
      if (call.target) target.dataset.tip = call.target;
      row.append(target);
      // a call still in flight has no duration yet, and saying "0ms" would be a
      // lie about the one row the user is most likely looking at
      row.append(el('span', 'activity-ms',
        call.cancelled ? 'not run' : call.done ? fmtMs(call.ms) : '…'));
      callsEl.append(row);
    }
  }

  function renderFiles(col, label, map) {
    col.textContent = '';
    col.append(el('div', 'activity-col-head', `${label} (${map.size})`));
    if (!map.size) {
      col.append(el('div', 'activity-empty', 'none'));
      return;
    }
    // newest last in a Map, and the recent ones are the interesting ones
    const paths = [...map.keys()].reverse();
    for (const path of paths.slice(0, FILES_MAX)) {
      const n = map.get(path);
      const row = el('div', 'activity-file', shortPath(path) + (n > 1 ? ` ×${n}` : ''));
      row.dataset.tip = path;
      col.append(row);
    }
    if (paths.length > FILES_MAX) {
      col.append(el('div', 'activity-empty', `+${paths.length - FILES_MAX} more`));
    }
  }

  /* Claude Code's Task subagents. Only their description and whether they are
   * still running is knowable from here — a subagent runs in its own context
   * and fires no hooks of its own, so there is nothing finer to show. */
  function renderSubs() {
    subsEl.textContent = '';
    if (!pane.subagents.length) { subsEl.hidden = true; return; }
    subsEl.hidden = false;
    subsEl.append(el('div', 'activity-col-head', 'Subagents'));
    for (const sub of pane.subagents.slice().reverse()) {
      const row = el('div', 'activity-row' + (sub.done ? '' : ' live'));
      row.append(el('span', 'activity-tool', sub.done ? 'done' : 'running'));
      const desc = el('span', 'activity-target', sub.desc || 'subagent');
      desc.dataset.tip = sub.desc || 'subagent';
      row.append(desc, el('span', 'activity-ms', sub.done ? fmtMs(sub.ms) : '…'));
      subsEl.append(row);
    }
  }

  function render() {
    raf = 0;
    if (!pane || pop.hidden) return;
    titleEl.textContent = 'Activity · ' + pane.session.agentName;
    const running = pane.openCalls.length;
    const open = running ? ` · running ${running > 1 ? running + ' calls' : (pane.openCalls[0].tool || '')}` : '';
    countEl.textContent = `${pane.activity.length} calls${open}`;
    renderCalls();
    renderSubs();
    renderFiles(readsEl, 'Read', pane.reads);
    renderFiles(writesEl, 'Written', pane.writes);
  }

  /* Every PreToolUse and PostToolUse calls this — on a busy agent that is
   * several a second, so the repaint is coalesced onto a frame and does nothing
   * at all unless this pane's popover is the one on screen. */
  function sync(p) {
    if (pop.hidden || p !== pane || raf) return;
    raf = requestAnimationFrame(render);
  }

  // drag the corner; the size is kept between opens (see resizable.js)
  const SIZE_KEY = 'swarmeye.activitySize';

  function open(p) {
    pane = p;
    pop.hidden = false;
    Resizable.place(pop, SIZE_KEY);
    render();
  }

  function close() {
    if (pop.hidden) return;
    Resizable.remember(pop, SIZE_KEY);
    pop.hidden = true;
    pane = null;
  }

  /* A pane being disposed takes its popover with it — the alternative is a list
   * of a dead agent's calls that no longer updates and cannot be re-opened. */
  function closeFor(p) {
    if (pane === p) close();
  }

  function init() {
    closeBtn.addEventListener('click', close);
    document.addEventListener('click', (e) => {
      // the pane's status chip and the panel's tool trail are what open this;
      // a click on either must not also count as an outside click and shut the
      // popover in the same beat
      if (pop.hidden || pop.contains(e.target)
        || e.target.closest('.pane-status, .pane-sub, .pane-usage-tools')) return;
      close();
    });
  }

  return { init, open, close, closeFor, sync, isOpen: () => !pop.hidden };
})();

window.Activity = Activity;
