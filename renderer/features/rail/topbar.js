/* Icon rail + top bar rendering: workspace tiles (drag to reorder, right-click
 * menu to start agents there / rename / remove), the top bar's
 * active-workspace context, usage mini bars. Exposes window.Topbar. */

const Topbar = (() => {
  const workspacesEl = document.getElementById('workspaces');
  const addAgentBtn = document.getElementById('add-agent');
  const usageEl = document.getElementById('usage');
  const ctxEl = document.getElementById('topbar-ctx');

  let lastUsage = null;
  const WS_DRAG = 'text/swarmeye-ws';

  /* the 57px rail only shows initials, so a tile's own controls have nowhere
   * to live — right-clicking one opens this menu instead */
  const ADD_CHIPS = 5; // how many agents the menu offers to start at once
  const menu = document.createElement('div');
  menu.id = 'rail-menu';
  menu.hidden = true;
  document.body.appendChild(menu);
  let menuWsId = null;
  // what the rail last drew — see the guard in renderWorkspaces
  let railSig = null;
  // the last updateAgentCap figures: how many chips the menu may still offer
  let capLive = 0;
  let capMax = 0;

  function hideMenu() {
    menu.hidden = true;
    menuWsId = null;
  }

  /* a context menu closes the way one does: a click anywhere outside it,
   * Escape, or a right-click on another tile (which re-opens it there) */
  document.addEventListener('mousedown', (e) => {
    if (menu.hidden || menu.contains(e.target)) return;
    hideMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) hideMenu();
  });

  function showMenu(tile, ws, handlers) {
    menuWsId = ws.id;
    menu.innerHTML = '';

    /* start agents in the workspace under the cursor rather than the selected
     * one — onAddAgents switches to it first, because a launch always lands in
     * the selected workspace. Chips past the free slots are disabled; the row
     * carries the reason, since a disabled button fires no hover event of its
     * own and the tooltip falls through to it. */
    const free = Math.max(0, capMax - capLive);
    menu.appendChild(elt('div', 'rail-menu-label', 'Add agents'));
    const chips = elt('div', 'rail-menu-chips');
    if (free < ADD_CHIPS) chips.dataset.tip = free
      ? `Only ${free} slot${free === 1 ? '' : 's'} left under the agent cap`
      : 'Agent cap reached';
    for (let n = 1; n <= ADD_CHIPS; n++) {
      const chip = elt('button', 'rail-menu-chip', String(n));
      chip.disabled = n > free;
      if (!chip.disabled) chip.dataset.tip = `Start ${n} agent${n === 1 ? '' : 's'} in ${ws.name}`;
      chip.addEventListener('click', () => {
        hideMenu();
        handlers.onAddAgents(ws.id, n);
      });
      chips.appendChild(chip);
    }
    menu.append(chips, elt('div', 'rail-menu-sep'));

    const rename = elt('button', 'rail-menu-item', 'Rename');
    rename.addEventListener('click', () => {
      hideMenu();
      startRenameWorkspace(tile, ws, handlers);
    });

    // removal is armed through the app-wide Confirm, so the menu stays open
    // for the second click (app.js removeWorkspace arms on this button)
    const remove = elt('button', 'rail-menu-item rail-menu-danger', 'Remove');
    remove.addEventListener('click', () => handlers.onRemove(ws.id, remove));

    menu.append(rename, remove);
    menu.hidden = false;
    const r = tile.getBoundingClientRect();
    menu.style.left = Math.round(r.right + 10) + 'px';
    menu.style.top = Math.round(Math.min(r.top, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }

  /* counts: wsId -> {n, attn} for tile badges */
  function renderWorkspaces(workspaces, selectedId, counts, handlers) {
    if (menuWsId && !workspaces.some((w) => w.id === menuWsId)) hideMenu();
    /* The rail is rebuilt from scratch here — a tile, its badges and eight
     * listeners per workspace — and app.js re-syncs the chrome on every agent
     * status flip, which with a busy swarm is several times a second, while
     * the rail itself changes almost never. Redraw only when something it
     * actually paints has moved. */
    const sig = JSON.stringify([selectedId, workspaces.map((w) => {
      const c = counts[w.id] || { n: 0, attn: false };
      return [w.id, w.name, c.n, !!c.attn];
    })]);
    if (sig !== railSig) {
      railSig = sig;
      buildRail(workspaces, selectedId, counts, handlers);
    }
    // the nested agent rows move on every status flip, so they are reconciled
    // on every beat — outside the signature guard above (features/rail/wsagents)
    workspaces.forEach((ws) => {
      WsAgents.sync(ws.id, (counts[ws.id] || {}).panes || [], handlers.onOpenAgent);
    });
  }

  function buildRail(workspaces, selectedId, counts, handlers) {
    renderContext(workspaces.find((w) => w.id === selectedId));
    WsAgents.reset();
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

      // drag up/down to rearrange; dropping on a tile inserts before or
      // after it depending on which half the pointer is over
      tile.draggable = true;
      tile.addEventListener('dragstart', (e) => {
        hideMenu();
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
      // right-click a workspace for its menu (rename, remove) — hovering must
      // stay quiet, the rail folds agents open
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenu(tile, ws, handlers);
      });
      workspacesEl.appendChild(tile);
      // the fold-out list of this workspace's agents, filled by WsAgents.sync
      workspacesEl.appendChild(WsAgents.attach(tile, ws.id));
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

  /* Rename edits the workspace in place: an input laid over its rail tile.
   * An overlay rather than the tile's own <span> — the tile is a <button>,
   * where contentEditable is unreliable, and the collapsed rail hides the name
   * altogether. Enter or a click away commits, Escape cancels. */
  function startRenameWorkspace(tile, ws, handlers) {
    const input = document.createElement('input');
    input.className = 'ws-rename';
    input.value = ws.name;
    input.maxLength = 40;
    document.body.appendChild(input);
    /* re-anchored every frame rather than placed once: clicking Rename takes
     * the pointer off the rail, so a collapsed rail slides shut underneath the
     * input while it is open, and the tile it belongs to moves with it */
    let raf = 0;
    const anchor = () => {
      // a rail rebuild swaps the tile out; the input keeps its last position
      if (!tile.isConnected) { raf = requestAnimationFrame(anchor); return; }
      const r = tile.getBoundingClientRect();
      input.style.left = Math.round(r.left) + 'px';
      input.style.top = Math.round(r.top) + 'px';
      input.style.height = Math.round(r.height) + 'px';
      input.style.width = Math.round(Math.max(r.width, 200)) + 'px';
      raf = requestAnimationFrame(anchor);
    };
    anchor();
    input.focus();
    input.select();

    let done = false;
    const close = (keep) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      const name = input.value.trim().slice(0, 40);
      input.remove();
      if (keep && name && name !== ws.name) handlers.onRename(ws.id, name);
    };
    // the rail's own shortcuts must not fire while a name is being typed
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  /* notification center: 🔔 with unread badge + event-history popover */
  const notifBtn = document.getElementById('notif-btn');
  const notifBadge = document.getElementById('notif-n');
  const notifPop = document.getElementById('notif-pop');

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

  /* the one per-notification action: jump to the pane it came from. */
  function notifActionButtons(n, handlers) {
    const wrap = elt('div', 'notif-acts');

    const go = elt('button', 'notif-act', '↗ Agent');
    go.dataset.tip = 'Jump to this agent';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onOpen(n.paneId);
    });

    wrap.append(go);
    return wrap;
  }

  const notifEmpty = () => elt('div', 'notif-empty', 'nothing yet — agent events land here');

  /* One row, for either list that shows notifications: the bell's popover
   * (compact — a relative time on the right) and the docked panel (`full`:
   * model, permission mode and runtime under the text, with an absolute
   * timestamp). Same skeleton either way, so a change to a row is one edit. */
  function notifRow(n, handlers, full) {
    const cls = full ? 'notif-panel-' : 'notif-';
    const row = elt('div', full ? 'notif-panel-row' : 'notif-row');
    row.dataset.tip = 'Jump to this agent';
    row.addEventListener('click', () => handlers.onOpen(n.paneId));

    const dot = elt('span', 'notif-dot ' + n.kind); // done | wait | exit | detach
    const body = elt('div', 'notif-body');
    body.append(elt('div', cls + 'who', `${n.agent} · ${n.ws}`),
      elt('div', cls + 'what', notifText(n)));
    if (n.cmd) {
      // same accent-bar + mono-text treatment as the pane's initial-command row
      const cmd = elt('div', 'notif-cmd');
      cmd.append(elt('span', 'pane-subheader-bar'), elt('span', cls + 'what', n.cmd));
      body.appendChild(cmd);
    }
    if (full) {
      // model / permission mode / how-long-it-had-been-running when the event
      // fired ("no start time recorded" is not the same as "0m")
      const ran = n.createdAt && n.time >= n.createdAt ? n.time - n.createdAt : null;
      const meta = [n.model || 'default model', n.mode ? `${n.mode} mode` : null,
        ran == null ? null : `running ${fmtDur(ran)}`].filter(Boolean);
      body.append(elt('div', 'notif-panel-meta', meta.join(' · ')),
        elt('div', 'notif-panel-time', fmtFull(n.time)));
    }
    body.appendChild(notifActionButtons(n, handlers));
    row.append(dot, body);
    if (!full) {
      const time = elt('span', 'notif-time', fmtAgo(n.time));
      time.dataset.tip = fmtFull(n.time);
      row.appendChild(time);
    }
    if (n.kind === 'wait' && n.canRespond) row.append(notifRespondButtons(n, handlers));
    row.append(notifDismissButton(n, handlers));
    return row;
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
      notifPop.appendChild(notifEmpty());
      return;
    }

    for (const n of notifs) notifPop.appendChild(notifRow(n, handlers, false));
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
      notifPanelList.appendChild(notifEmpty());
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
      notifPanelList.appendChild(notifEmpty());
      return;
    }

    for (const n of shown) notifPanelList.appendChild(notifRow(n, handlers, true));
  }

  // the count itself reads in the rail (per-workspace badges); all the top bar
  // still needs from it is whether the cap is reached
  function updateAgentCap(total, max) {
    capLive = total;
    capMax = max;
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

  return { renderWorkspaces, renderNotifications, renderNotifPanel, updateAgentCap, renderUsage, setUsageSection, fmtIn };
})();

window.Topbar = Topbar;
