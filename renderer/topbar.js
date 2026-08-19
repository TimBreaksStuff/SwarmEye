/* Icon rail + top bar rendering: workspace tiles (drag to reorder, hover
 * flyout for rename/remove), the top bar's active-workspace context, usage
 * mini bars. Exposes window.Topbar. */

const Topbar = (() => {
  const workspacesEl = document.getElementById('workspaces');
  const addAgentBtn = document.getElementById('add-agent');
  const usageEl = document.getElementById('usage');
  const ctxEl = document.getElementById('topbar-ctx');

  let lastUsage = null;
  const WS_DRAG = 'text/swarmeye-ws';

  // workspace identity palette — the one copy lives in main/config.js
  // (WORKSPACE_COLORS), which assigns each new workspace its default and
  // validates every pick against the list; app.js hands it over at boot and
  // it drives the flyout swatches
  let WS_COLORS = [];

  /* the 57px rail only shows initials — hovering a tile opens a flyout with
   * the full name (double-click to rename) and the ✕ remove button */
  const flyout = document.createElement('div');
  flyout.id = 'rail-flyout';
  flyout.hidden = true;
  document.body.appendChild(flyout);
  let flyoutWsId = null;
  let flyoutHideTimer = null;
  // context from the last renderWorkspaces, so a colour pick or a programmatic
  // flyout-open (openWorkspaceFlyout, used after "add workspace") can rebuild it
  let railCtx = { workspaces: [], counts: {}, handlers: null };
  const tileById = new Map();
  // what the rail last drew — see the guard in renderWorkspaces
  let railSig = null;
  flyout.addEventListener('mouseenter', () => clearTimeout(flyoutHideTimer));
  flyout.addEventListener('mouseleave', scheduleHideFlyout);

  function hideFlyout() {
    clearTimeout(flyoutHideTimer);
    flyout.hidden = true;
    flyoutWsId = null;
  }

  function scheduleHideFlyout() {
    clearTimeout(flyoutHideTimer);
    flyoutHideTimer = setTimeout(() => {
      if (!flyout.querySelector('[contenteditable]')) hideFlyout();
    }, 250);
  }

  function showFlyout(tile, ws, info, handlers) {
    clearTimeout(flyoutHideTimer);
    if (flyout.querySelector('[contenteditable]')) return; // an active rename owns the flyout
    flyoutWsId = ws.id;
    flyout.innerHTML = '';

    const infoEl = elt('div', 'rail-flyout-info');
    const name = document.createElement('div');
    name.className = 'rail-flyout-name';
    name.textContent = ws.name;
    name.dataset.tip = 'Double-click to rename';
    name.addEventListener('dblclick', () => startRenameWorkspace(name, ws, handlers));
    const sub = document.createElement('div');
    sub.className = 'rail-flyout-sub';
    sub.textContent = `${info.n} agent${info.n === 1 ? '' : 's'} · ${ws.path}`;

    // a row of swatches to set this workspace's identity colour — the pick
    // repaints the rail tile dot and the swarm-map slot borders via onSetColor
    const colors = document.createElement('div');
    colors.className = 'rail-flyout-colors';
    WS_COLORS.forEach((c) => {
      const sw = document.createElement('button');
      sw.className = 'ws-swatch ws-tint' + (c === ws.color ? ' active' : '');
      sw.style.setProperty('--ws', c);
      sw.dataset.tip = 'Set workspace colour';
      sw.addEventListener('click', () => {
        ws.color = c; // keep the flyout's local copy in sync for the active ring
        colors.querySelectorAll('.ws-swatch').forEach((s) => s.classList.toggle('active', s === sw));
        handlers.onSetColor(ws.id, c);
      });
      colors.appendChild(sw);
    });
    infoEl.append(name, sub, colors);

    // pinning floats this workspace to the top of the rail — the favourites
    // stay reachable as the list grows past a screenful
    const pin = document.createElement('button');
    pin.className = 'rail-flyout-pin' + (ws.pinned ? ' on' : '');
    Icons.set(pin, 'pin');
    pin.dataset.tip = ws.pinned ? 'Unpin — back to drag order' : 'Pin to the top of the rail';
    pin.addEventListener('click', () => {
      hideFlyout();
      handlers.onSetPinned(ws.id, !ws.pinned);
    });

    // the workspace notebook — what agents started here are told to read
    const notes = document.createElement('button');
    notes.className = 'rail-flyout-notes';
    Icons.set(notes, 'note');
    notes.dataset.tip = 'Workspace notes — every agent started here is pointed at them';
    notes.addEventListener('click', (e) => {
      e.stopPropagation(); // the popover's own outside-click handler would shut it again
      hideFlyout();
      handlers.onOpenNotes(ws);
    });

    // agents started here work in a git worktree of their own instead of
    // sharing this checkout (main/worktree.js) — a workspace setting, so board
    // tasks and + Agent pick it up without either of them asking
    const isolate = document.createElement('button');
    isolate.className = 'rail-flyout-isolate' + (ws.isolate ? ' on' : '');
    Icons.set(isolate, 'branch');
    isolate.dataset.tip = ws.isolate
      ? 'Isolation on — new agents get their own branch and worktree'
      : 'Isolate new agents — each gets its own branch and worktree';
    isolate.addEventListener('click', () => {
      hideFlyout();
      handlers.onSetIsolate(ws.id, !ws.isolate);
    });

    // review what the agents changed: the full diff, commit, merge back
    const review = document.createElement('button');
    review.className = 'rail-flyout-review';
    Icons.set(review, 'diff');
    review.dataset.tip = 'Review changes — diff, commit and merge agent worktrees';
    review.addEventListener('click', (e) => {
      e.stopPropagation();
      hideFlyout();
      handlers.onReview(ws);
    });

    const x = document.createElement('button');
    x.className = 'rail-flyout-x';
    x.textContent = '✕';
    x.dataset.tip = 'Remove workspace';
    x.addEventListener('click', () => handlers.onRemove(ws.id, x)); // the button, so removal can arm on it (Confirm)

    flyout.append(infoEl, review, isolate, notes, pin, x);
    flyout.hidden = false;
    const r = tile.getBoundingClientRect();
    flyout.style.left = Math.round(r.right + 10) + 'px';
    const top = r.top + r.height / 2 - flyout.offsetHeight / 2;
    flyout.style.top = Math.round(Math.min(Math.max(8, top), window.innerHeight - flyout.offsetHeight - 8)) + 'px';
  }

  /* counts: wsId -> {n, attn} for tile badges */
  function renderWorkspaces(workspaces, selectedId, counts, handlers) {
    // a rebuild mid-rename would rip out the contentEditable name in the
    // flyout without ever committing (removal fires no blur) — skip this
    // refresh; the rename's own commit triggers a re-render that catches up
    if (flyout.querySelector('[contenteditable]')) return;
    if (flyoutWsId && !workspaces.some((w) => w.id === flyoutWsId)) hideFlyout();
    railCtx = { workspaces, counts, handlers };
    /* The rail is rebuilt from scratch here — a tile, its badges and eight
     * listeners per workspace — and app.js re-syncs the chrome on every agent
     * status flip, which with a busy swarm is several times a second, while
     * the rail itself changes almost never. Redraw only when something it
     * actually paints has moved. (railCtx is refreshed above regardless, so
     * openWorkspaceFlyout keeps working off the live objects.) */
    const sig = JSON.stringify([selectedId, workspaces.map((w) => {
      const c = counts[w.id] || { n: 0, attn: false };
      return [w.id, w.name, w.color, !!w.pinned, c.n, !!c.attn];
    })]);
    if (sig === railSig) return;
    railSig = sig;
    renderContext(workspaces.find((w) => w.id === selectedId));
    tileById.clear();
    workspacesEl.innerHTML = '';
    workspaces.forEach((ws) => {
      const info = counts[ws.id] || { n: 0, attn: false };
      const tile = document.createElement('button');
      tile.className = 'rail-tile ws-tile'
        + (ws.id === selectedId ? ' selected' : '')
        + (info.attn ? ' attn' : '');
      tile.setAttribute('aria-label', `${ws.name} · ${info.n} agent${info.n === 1 ? '' : 's'}`);

      // collapsed rail shows just the glyph; expanded shows the full name
      // instead (see .rail-tile-glyph / .rail-tile-name in app.css)
      const glyph = document.createElement('span');
      glyph.className = 'rail-tile-glyph';
      glyph.textContent = (ws.name.trim()[0] || '?').toUpperCase();
      const name = document.createElement('span');
      name.className = 'rail-tile-name';
      name.textContent = ws.name;
      tile.append(glyph, name);

      // identity-colour dot (bottom-left corner, mirrors the top-right .ws-attn)
      if (ws.color) {
        const cdot = elt('span', 'ws-color-dot ws-tint');
        cdot.style.setProperty('--ws', ws.color);
        tile.appendChild(cdot);
      }
      // pinned marker, before .ws-attn/.rail-n in the DOM so the expanded
      // rail's `~` spacing rules can trail the badges after it
      if (ws.pinned) {
        const pin = document.createElement('span');
        pin.className = 'ws-pin';
        Icons.set(pin, 'pin');
        tile.appendChild(pin);
      }
      tileById.set(ws.id, tile);

      // drag up/down to rearrange; dropping on a tile inserts before or
      // after it depending on which half the pointer is over
      tile.draggable = true;
      tile.addEventListener('dragstart', (e) => {
        hideFlyout();
        e.dataTransfer.setData(WS_DRAG, ws.id);
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => tile.classList.add('dragging'));
      });
      tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
      const inTopHalf = (e) => {
        const r = tile.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      };
      tile.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes(WS_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const before = inTopHalf(e);
        tile.classList.toggle('drop-before', before);
        tile.classList.toggle('drop-after', !before);
      });
      tile.addEventListener('dragleave', () => tile.classList.remove('drop-before', 'drop-after'));
      tile.addEventListener('drop', (e) => {
        tile.classList.remove('drop-before', 'drop-after');
        const dragId = e.dataTransfer.getData(WS_DRAG);
        if (!dragId || dragId === ws.id) return;
        e.preventDefault();
        handlers.onReorder(dragId, ws.id, inTopHalf(e));
      });

      if (info.attn) {
        const attn = document.createElement('span');
        attn.className = 'ws-attn';
        attn.dataset.tip = 'An agent here needs attention';
        tile.appendChild(attn);
      }

      // the expanded rail keeps the count column aligned by showing an em dash
      // for an empty workspace; the collapsed rail hides that placeholder
      const badge = elt('span', info.n > 0 ? 'rail-n' : 'rail-n rail-n-zero', info.n > 0 ? info.n : '–');
      if (info.n > 0) badge.dataset.tip = `${info.n} agent${info.n > 1 ? 's' : ''} in this workspace`;
      tile.appendChild(badge);

      tile.addEventListener('click', () => handlers.onSelect(ws.id));
      tile.addEventListener('mouseenter', () => showFlyout(tile, ws, info, handlers));
      tile.addEventListener('mouseleave', scheduleHideFlyout);
      workspacesEl.appendChild(tile);
    });
  }

  /* top bar centre zone: which workspace a + Agent lands in. Runs off the same
   * signature guard as the rail, so it repaints on a selection, rename or
   * colour change and never on a plain status flip. */
  function renderContext(ws) {
    ctxEl.hidden = !ws;
    if (!ws) return;
    ctxEl.querySelector('.tb-ctx-name').textContent = ws.name;
    ctxEl.dataset.tip = ws.path;
  }

  /* double-click the flyout's name to rename it, same contentEditable-swap
   * pattern as the pane title (see pane.js startRename) */
  function startRenameWorkspace(nameEl, ws, handlers) {
    if (nameEl.isContentEditable) return;
    const orig = ws.name;
    nameEl.contentEditable = 'plaintext-only';
    nameEl.focus();
    document.getSelection().selectAllChildren(nameEl);

    const commit = (keep) => {
      nameEl.removeAttribute('contenteditable');
      const name = (keep ? nameEl.textContent : orig).trim().slice(0, 40) || orig;
      nameEl.textContent = name;
      document.getSelection().removeAllRanges();
      hideFlyout();
      if (name !== orig) handlers.onRename(ws.id, name);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = orig; nameEl.blur(); }
    };
    const onDocDown = (e) => {
      if (!nameEl.isConnected) {
        document.removeEventListener('mousedown', onDocDown, true);
        return;
      }
      if (e.target !== nameEl) nameEl.blur();
    };
    document.addEventListener('mousedown', onDocDown, true);
    nameEl.addEventListener('keydown', onKey);
    nameEl.addEventListener('blur', () => {
      document.removeEventListener('mousedown', onDocDown, true);
      nameEl.removeEventListener('keydown', onKey);
      commit(true);
    }, { once: true });
  }

  /* open a workspace's flyout without a hover — used right after adding a
   * workspace so its colour can be picked immediately */
  function openWorkspaceFlyout(wsId) {
    const tile = tileById.get(wsId);
    const ws = railCtx.workspaces.find((w) => w.id === wsId);
    if (!tile || !ws || !railCtx.handlers) return;
    showFlyout(tile, ws, railCtx.counts[wsId] || { n: 0, attn: false }, railCtx.handlers);
  }

  /* notification center: 🔔 with unread badge + event-history popover */
  const notifBtn = document.getElementById('notif-btn');
  const notifBadge = document.getElementById('notif-n');
  const notifPop = document.getElementById('notif-pop');

  function fmtClock(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // "now" under a minute, then 5m / 2h / 3d — the popover's row times, with
  // the full timestamp in the tooltip; the docked panel keeps fmtFull
  function fmtAgo(t) {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h`;
    return `${Math.floor(m / 1440)}d`;
  }

  // a coalesced row says how many times it fired
  function notifText(n) {
    return n.count > 1 ? `${n.text} ×${n.count}` : n.text;
  }

  // per-row dismiss — splices exactly this row without clearing the rest
  function notifDismissButton(n, handlers) {
    const x = elt('button', 'notif-dismiss', '✕');
    x.dataset.tip = 'Dismiss this notification';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onDismiss(n);
    });
    return x;
  }

  // approve/deny buttons for a 'wait'-kind row — same quick-respond action as
  // the pane header's ✓/✕, so a permission prompt can be cleared straight
  // from the bell without switching workspace or opening the pane
  function notifRespondButtons(n, handlers) {
    const wrap = elt('span', 'notif-respond');
    const approve = document.createElement('button');
    approve.className = 'pane-btn approve';
    approve.dataset.tip = 'Approve (shift-click: always allow)';
    approve.textContent = '✓';
    approve.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onApprove(n.paneId, e.shiftKey);
    });
    const deny = document.createElement('button');
    deny.className = 'pane-btn deny';
    deny.dataset.tip = 'Deny';
    deny.textContent = '✕';
    deny.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onDeny(n.paneId);
    });
    wrap.append(approve, deny);
    return wrap;
  }

  /* the two per-notification actions: jump to the pane, or read the whole
   * conversation in the History modal. The transcript id comes from the hook
   * payload, so a pane whose hooks never reported one (an old reattached
   * session) gets a disabled button rather than a missing one. */
  function notifActionButtons(n, handlers) {
    const wrap = elt('div', 'notif-acts');

    const go = elt('button', 'notif-act', '↗ Agent');
    go.dataset.tip = 'Jump to this agent';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onOpen(n.paneId);
    });

    const script = elt('button', 'notif-act');
    script.textContent = '☰ Transcript';
    script.disabled = !n.transcriptId;
    script.dataset.tip = n.transcriptId
      ? 'Read the whole conversation'
      : 'No transcript recorded for this agent';
    script.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onTranscript(n);
    });

    wrap.append(go, script);
    return wrap;
  }

  function renderNotifications(notifs, unread, handlers) {
    notifBtn.classList.toggle('unread', unread > 0); // amber bell = something new
    notifBadge.hidden = unread === 0;
    notifBadge.textContent = unread > 99 ? '99+' : unread;

    // the badge above is what a closed popover still needs; the list below is
    // up to 50 rows with their own listeners, rebuilt on every agent event —
    // only worth building while it is on screen (app.js renders it on open).
    // Rebuilding it hidden also resets the scroll position and orphans the
    // tooltip of whatever row the cursor was resting on.
    if (notifPop.hidden) return;

    notifPop.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'notif-head';
    const title = document.createElement('div');
    title.className = 'kbd-title';
    title.textContent = 'Notifications';
    head.appendChild(title);
    const expand = elt('button', 'notif-clear', 'details ▸');
    expand.dataset.tip = 'Open the full notification panel';
    expand.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onExpand();
    });
    head.appendChild(expand);
    if (notifs.length) {
      const clear = document.createElement('button');
      clear.className = 'notif-clear';
      clear.textContent = 'clear';
      clear.dataset.tip = 'Empty this list';
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        handlers.onClear();
      });
      head.appendChild(clear);
    }
    notifPop.appendChild(head);

    if (!notifs.length) {
      const empty = document.createElement('div');
      empty.className = 'notif-empty';
      empty.textContent = 'nothing yet — agent events land here';
      notifPop.appendChild(empty);
      return;
    }

    for (const n of notifs) {
      const row = document.createElement('div');
      row.className = 'notif-row';
      row.dataset.tip = 'Jump to this agent';
      row.addEventListener('click', () => handlers.onOpen(n.paneId));

      const dot = document.createElement('span');
      dot.className = 'notif-dot ' + n.kind; // done | wait | exit | detach

      const body = document.createElement('div');
      body.className = 'notif-body';
      const who = document.createElement('div');
      who.className = 'notif-who';
      who.textContent = `${n.agent} · ${n.ws}`;
      const what = document.createElement('div');
      what.className = 'notif-what';
      what.textContent = notifText(n);
      body.append(who, what);
      if (n.cmd) {
        // same accent-bar + mono-text treatment as the pane's initial-command row
        const cmd = document.createElement('div');
        cmd.className = 'notif-cmd';
        const bar = document.createElement('span');
        bar.className = 'pane-subheader-bar';
        const cmdText = elt('span', 'notif-what', n.cmd);
        cmd.append(bar, cmdText);
        body.appendChild(cmd);
      }
      body.appendChild(notifActionButtons(n, handlers));

      const time = document.createElement('span');
      time.className = 'notif-time';
      time.textContent = fmtAgo(n.time);
      time.dataset.tip = fmtFull(n.time);

      row.append(dot, body, time);
      if (n.kind === 'wait' && n.canRespond) row.append(notifRespondButtons(n, handlers));
      row.append(notifDismissButton(n, handlers));
      notifPop.appendChild(row);
    }
  }

  /* notification panel: right-side docked view (same slot pattern as the
   * left icon rail) — full, untruncated detail for every event, no cap. */
  const notifPanel = document.getElementById('notif-panel');
  const notifPanelList = document.getElementById('notif-panel-list');

  function fmtFull(t) {
    return new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  }

  // "1d 3h", "1h 12m", "3m". Elapsed time rounds down; time remaining rounds
  // up, so a countdown never shows "0m" while it still has seconds left on it
  function fmtDur(ms, round = Math.floor) {
    const minutes = round(ms / 60000);
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const min = minutes % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${min}m`;
    return `${min}m`;
  }

  // which kinds the panel shows — a chip click re-renders off the captured
  // list, so the filter flips without waiting for the next agent event
  let notifFilter = 'all';
  let panelNotifs = [], panelHandlers = null;

  function renderNotifPanel(notifs, handlers) {
    if (notifPanel.hidden) return; // same reason as the popover above
    panelNotifs = notifs;
    panelHandlers = handlers;
    notifPanelList.innerHTML = '';
    if (!notifs.length) {
      const empty = document.createElement('div');
      empty.className = 'notif-empty';
      empty.textContent = 'nothing yet — agent events land here';
      notifPanelList.appendChild(empty);
      return;
    }

    // Exited folds 'detach' in — both mean the pane is gone
    const FILTERS = [['all', 'All'], ['wait', 'Needs input'], ['done', 'Done'], ['exit', 'Exited']];
    const chips = elt('div', 'notif-filter');
    for (const [key, label] of FILTERS) {
      const chip = elt('button', 'notif-act' + (notifFilter === key ? ' on' : ''), label);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        notifFilter = key;
        renderNotifPanel(panelNotifs, panelHandlers);
      });
      chips.appendChild(chip);
    }
    notifPanelList.appendChild(chips);

    const shown = notifs.filter((n) => notifFilter === 'all'
      || (notifFilter === 'exit' ? n.kind === 'exit' || n.kind === 'detach' : n.kind === notifFilter));
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'notif-empty';
      empty.textContent = 'nothing yet — agent events land here';
      notifPanelList.appendChild(empty);
      return;
    }

    for (const n of shown) {
      const row = document.createElement('div');
      row.className = 'notif-panel-row';
      row.dataset.tip = 'Jump to this agent';
      row.addEventListener('click', () => handlers.onOpen(n.paneId));

      const dot = document.createElement('span');
      dot.className = 'notif-dot ' + n.kind;

      const body = document.createElement('div');
      body.className = 'notif-body';
      const who = document.createElement('div');
      who.className = 'notif-panel-who';
      who.textContent = `${n.agent} · ${n.ws}`;
      const what = document.createElement('div');
      what.className = 'notif-panel-what';
      what.textContent = notifText(n);
      body.append(who, what);
      if (n.cmd) {
        const cmd = document.createElement('div');
        cmd.className = 'notif-cmd';
        const bar = document.createElement('span');
        bar.className = 'pane-subheader-bar';
        const cmdText = elt('span', 'notif-panel-what', n.cmd);
        cmd.append(bar, cmdText);
        body.appendChild(cmd);
      }

      // model / permission mode / how-long-it-had-been-running when the event
      // fired ("no start time recorded" is not the same as "0m")
      const ran = n.createdAt && n.time >= n.createdAt ? n.time - n.createdAt : null;
      const metaParts = [n.model || 'default model', n.mode ? `${n.mode} mode` : null, ran == null ? null : `running ${fmtDur(ran)}`].filter(Boolean);
      const meta = document.createElement('div');
      meta.className = 'notif-panel-meta';
      meta.textContent = metaParts.join(' · ');
      body.appendChild(meta);

      const time = document.createElement('div');
      time.className = 'notif-panel-time';
      time.textContent = fmtFull(n.time);
      body.appendChild(time);
      body.appendChild(notifActionButtons(n, handlers));

      row.append(dot, body);
      if (n.kind === 'wait' && n.canRespond) row.append(notifRespondButtons(n, handlers));
      row.append(notifDismissButton(n, handlers));
      notifPanelList.appendChild(row);
    }
  }

  /* swarm map: one slot per agent-capacity slot, across all workspaces —
   * lime = working, amber pulsing = needs attention, gray = idle, dark = free.
   * Exited panes free their slot (mirrors liveAgentCount() in app.js), and if
   * live agents ever exceed maxAgents (cap lowered mid-session) every agent
   * still gets a slot rather than being silently hidden. */
  const swarmMapGrid = document.getElementById('swarm-map-grid');
  const swarmMapFooter = document.getElementById('swarm-map-footer');
  // latest onOpen, read by the per-slot click handlers installed at creation
  let swarmMapOnOpen = null;

  function renderSwarmMap(panes, totalSlots, onOpen, wsColor = {}) {
    const live = panes.filter((p) => !p.exited);
    const busyCount = live.filter((p) => p.status === 'working').length;
    const attnCount = live.filter((p) => p.status === 'attention').length;
    const idleCount = live.filter((p) => p.status === 'idle').length;
    const slotCount = Math.max(totalSlots, live.length);

    // one row while the slots fit the rail's width at a readable size, two rows
    // past that — a fixed column count sized them to whatever was left over
    const MAX_COLS = 12; // 12 × ~14px + gaps ≈ the 208px the expanded rail gives the strip
    const cols = slotCount <= MAX_COLS ? Math.max(slotCount, 1) : Math.min(Math.ceil(slotCount / 2), MAX_COLS);
    if (swarmMapGrid.style.getPropertyValue('--swarm-cols') !== String(cols)) {
      swarmMapGrid.style.setProperty('--swarm-cols', cols);
    }

    // Reconcile slots in place rather than rebuilding from scratch: this runs on
    // every state update, and wiping innerHTML would destroy the slot node the
    // cursor is resting on — Chromium fires no mouseout for a removed node, so
    // its hover tooltip would orphan and never hide. Reusing nodes keeps the
    // hovered slot alive (and its tooltip fresh) across re-renders.
    // This runs on every chrome beat — write only on change (a same-value
    // textContent/dataset write still replaces the text node / fires attribute
    // bookkeeping), and the click handler is installed once per slot rather
    // than a fresh closure per beat.
    swarmMapOnOpen = onOpen;
    while (swarmMapGrid.children.length > slotCount) swarmMapGrid.lastChild.remove();
    while (swarmMapGrid.children.length < slotCount) {
      const span = document.createElement('span');
      span.addEventListener('click', () => {
        if (span.dataset.sid && swarmMapOnOpen) swarmMapOnOpen(span.dataset.sid);
      });
      swarmMapGrid.appendChild(span);
    }
    for (let i = 0; i < slotCount; i++) {
      const pane = live[i];
      const cls = !pane ? ''
        : pane.status === 'working' ? 'busy'
        : pane.status === 'attention' ? 'attn'
        : 'idle';
      const slot = swarmMapGrid.children[i];
      // the slot's border carries its workspace's identity colour
      const bc = pane ? (wsColor[pane.session.workspaceId] || '') : '';
      const className = 'swarm-map-slot' + (cls ? ' ' + cls : '') + (pane ? ' clickable' : '') + (bc ? ' ws-tint' : '');
      // last input the agent received — its most recently submitted command,
      // shown after a vertical rule in the hover tooltip (see tooltip.js)
      const cmd = (pane && pane.initialCommandText) || '';
      // one signature per slot: nothing below is written unless something moved
      const sig = pane ? `${className}|${pane.session.id}|${pane.session.agentName}|${cmd}|${bc}` : className;
      if (slot.dataset.sig === sig) continue;
      slot.dataset.sig = sig;
      slot.className = className;
      slot.style.setProperty('--ws', bc);
      if (pane) {
        slot.dataset.sid = pane.session.id;
        slot.dataset.tip = pane.session.agentName;
        if (cmd) slot.dataset.tipSecondary = cmd;
        else delete slot.dataset.tipSecondary;
      } else {
        delete slot.dataset.sid;
        delete slot.dataset.tip;
        delete slot.dataset.tipSecondary;
      }
    }

    // free slots are already legible as the dark ones, so the head counts only
    // what is actually running — plus the cap, which used to live in the top
    // bar's own counter beside the same numbers
    const parts = [`${live.length}/${totalSlots}`];
    if (busyCount) parts.push(`${busyCount} busy`);
    if (attnCount) parts.push(`${attnCount} waiting`);
    if (idleCount) parts.push(`${idleCount} idle`);
    const foot = parts.join(' · ');
    if (swarmMapFooter.textContent !== foot) swarmMapFooter.textContent = foot;
  }

  // the count itself reads in the rail (per-workspace badges + the swarm head);
  // all the top bar still needs from it is whether the cap is reached
  function updateAgentCap(total, max) {
    const capped = total >= max;
    if (addAgentBtn.disabled !== capped) addAgentBtn.disabled = capped;
    const tip = capped
      ? `Agent cap reached — ${total}/${max} running`
      : `Start a plain agent or a role preset in the selected workspace — ${total}/${max} running`;
    if (addAgentBtn.dataset.tip !== tip) addAgentBtn.dataset.tip = tip;
  }

  // time remaining rounds up, so a countdown never shows "0m" while it still has
  // seconds left on it. Public: app.js dates the usage popover's rows with it
  const fmtIn = (ms) => (ms <= 0 ? 'now' : fmtDur(ms, Math.ceil));

  // the expanded rail labels each bar with its level and a one-unit countdown
  // ("3h", "2d") — the collapsed rail hides that head and shows the bar alone
  function fmtCountdown(ms) {
    const min = Math.max(0, Math.ceil(ms / 60000));
    if (min >= 1440) return `${Math.floor(min / 1440)}d`;
    if (min >= 60) return `${Math.floor(min / 60)}h`;
    return `${min}m`;
  }

  function renderRow(rowId, data) {
    const fill = document.getElementById(rowId).querySelector('.u-fill');
    const pctEl = document.getElementById(rowId + '-pct');
    const inEl = document.getElementById(rowId + '-in');
    if (!data || data.usedPct == null) {
      fill.style.setProperty('--u', '0%');
      fill.classList.remove('warn', 'crit');
      pctEl.textContent = '—';
      inEl.textContent = '';
      return null;
    }
    const p = Math.max(0, Math.min(100, data.usedPct));
    fill.style.setProperty('--u', p + '%');
    pctEl.textContent = p + '%';
    inEl.textContent = data.resetsAt ? fmtCountdown(new Date(data.resetsAt) - Date.now()) : '';
    fill.classList.toggle('warn', p >= 75 && p < 90);
    fill.classList.toggle('crit', p >= 90);
    return p;
  }

  // radial-dial equivalent of renderRow, for the expanded rail's usage gauges
  const GAUGE_CIRC = 201; // 2 * PI * r(32), matches the SVGs' stroke-dasharray
  function renderGauge(gaugeId, subId, data) {
    const fill = document.getElementById(gaugeId).querySelector('.gauge-fill');
    const pctEl = document.getElementById(gaugeId).querySelector('.gauge-pct');
    const subEl = document.getElementById(subId);
    if (!data || data.usedPct == null) {
      fill.style.strokeDashoffset = String(GAUGE_CIRC);
      fill.classList.remove('warn', 'crit');
      pctEl.textContent = '—';
      subEl.textContent = '';
      return;
    }
    const p = Math.max(0, Math.min(100, data.usedPct));
    fill.style.strokeDashoffset = String(Math.round(GAUGE_CIRC * (1 - p / 100)));
    fill.classList.toggle('warn', p >= 75 && p < 90);
    fill.classList.toggle('crit', p >= 90);
    pctEl.textContent = p + '%';
    subEl.textContent = data.resetsAt ? `resets in ${fmtIn(new Date(data.resetsAt) - Date.now())}` : '';
  }

  const usageGaugesEl = document.getElementById('usage-gauges');

  function renderUsage(snapshot) {
    if (snapshot) lastUsage = snapshot;
    const s = lastUsage;
    if (!s) return;

    // the collapsed rail has no room for text — the mini bars carry the
    // levels and the full detail lives in the tooltip; the expanded rail's
    // gauges spell out the percentage and reset countdown directly
    // a degraded snapshot blanks every widget — renderRow/renderGauge already
    // treat "no data" as empty, so the failure case is just an absent window
    const u = s.ok ? s : {};
    renderRow('usage-5h', u.fiveHour);
    renderRow('usage-7d', u.weekly);
    renderGauge('gauge-5h', 'gauge-5h-sub', u.fiveHour);
    renderGauge('gauge-7d', 'gauge-7d-sub', u.weekly);
    usageEl.dataset.tip = usageGaugesEl.dataset.tip = 'click to refresh';
  }

  // keep "resets in" countdowns fresh between polls
  setInterval(() => renderUsage(null), 30000);

  /* --- OpenRouter usage: the second section under the Anthropic bars -------
   * Two rows — what today cost, as a bare figure, and a bar for what is left
   * of the credits bought. A key whose account balance is unreadable falls
   * back to that key's own spend limit; with neither, the bar stays empty and the dollar
   * figures still show. Five-minute poll — since 1.60.32 this is the app's
   * only OpenRouter spend request; main still caches it for a minute, which
   * is what keeps a click on the block from hammering the endpoint. */
  const usageTitleEl = document.getElementById('usage-title');
  const orTitleEl = document.getElementById('or-usage-title');
  const orEl = document.getElementById('usage-or');
  const fmtUsd = (v) => (v == null ? '—' : '$' + (v < 10 ? v.toFixed(2) : Math.round(v)));
  let orSectionOn = true; // ⌨ Options; see setUsageSection below

  function renderOrRow(rowId, pct, text) {
    const fill = document.getElementById(rowId).querySelector('.u-fill');
    const p = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
    fill.style.setProperty('--u', (p == null ? 0 : p) + '%');
    fill.classList.toggle('warn', p != null && p >= 75 && p < 90);
    fill.classList.toggle('crit', p != null && p >= 90);
    document.getElementById(rowId + '-pct').textContent = p == null ? '—' : p + '%';
    document.getElementById(rowId + '-in').textContent = text;
  }

  function renderOrUsage(s) {
    const total = s.credits ? s.credits.total : s.limit;
    const used = s.credits ? s.credits.used
      : (s.limit != null && s.remaining != null ? s.limit - s.remaining : null);
    const left = total != null && used != null ? total - used : s.remaining;
    const share = (v) => (total > 0 && v != null ? (v / total) * 100 : null);
    document.getElementById('usage-or-today-in').textContent = fmtUsd(s.daily);
    renderOrRow('usage-or-credits', share(used), left == null ? '—' : fmtUsd(left) + ' left');
    orEl.dataset.tip = 'OpenRouter — today ' + fmtUsd(s.daily) + ' · week ' + fmtUsd(s.weekly)
      + ' · month ' + fmtUsd(s.monthly)
      + (total != null ? ' · ' + fmtUsd(left) + ' of ' + fmtUsd(total) + ' credits left' : '')
      + ' — click to refresh';
    // a poll in flight when the section was switched off must not unhide it
    orTitleEl.hidden = orEl.hidden = !orSectionOn;
  }

  async function pollOrUsage() {
    if (!orSectionOn) return;
    const s = await window.swarm.openrouterSpend();
    if (s) { renderOrUsage(s); return; }
    // main answers null both for "no key saved" and for a failed fetch — only
    // the first should hide the section; a transient error keeps the last
    // numbers on screen rather than flickering the rail
    const st = await window.swarm.openrouterStatus();
    if (!st.configured) orTitleEl.hidden = orEl.hidden = true;
  }
  pollOrUsage();
  setInterval(pollOrUsage, 5 * 60 * 1000);
  // a key saved or forgotten in Options reaches the rail without a poll's wait
  window.addEventListener('openrouter:changed', pollOrUsage);
  orEl.addEventListener('click', pollOrUsage);

  /* ⌨ Options can switch either section out of the rail entirely — head and
   * bars, in both menu sizes. Switching the OpenRouter one off also stops its
   * poll; switching it back on re-reads rather than waiting five minutes. */
  function setUsageSection(which, on) {
    if (which === 'anthropic') {
      usageTitleEl.hidden = usageEl.hidden = usageGaugesEl.hidden = !on;
      return;
    }
    orSectionOn = on;
    if (on) pollOrUsage();
    else orTitleEl.hidden = orEl.hidden = true;
  }

  const setWorkspaceColors = (colors) => { WS_COLORS = colors || []; };

  return { renderWorkspaces, renderNotifications, renderNotifPanel, updateAgentCap, renderUsage, setUsageSection, renderSwarmMap, openWorkspaceFlyout, setWorkspaceColors, fmtIn, fmtClock };
})();

window.Topbar = Topbar;
