/* Icon rail + top bar rendering: workspace tiles (drag to reorder, hover
 * flyout for rename/remove), archive popover, session counter, usage mini
 * bars. Exposes window.Topbar. */

const Topbar = (() => {
  const workspacesEl = document.getElementById('workspaces');
  const countEl = document.getElementById('session-count');
  const addAgentBtn = document.getElementById('add-agent');
  const usageEl = document.getElementById('usage');
  const archiveBtn = document.getElementById('archive-btn');
  const archivePop = document.getElementById('archive-pop');

  let lastUsage = null;
  const WS_DRAG = 'text/swarmeye-ws';

  /* the 66px rail only shows initials — hovering a tile opens a flyout with
   * the full name (double-click to rename) and the ✕ remove button */
  const flyout = document.createElement('div');
  flyout.id = 'rail-flyout';
  flyout.hidden = true;
  document.body.appendChild(flyout);
  let flyoutWsId = null;
  let flyoutHideTimer = null;
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

    const infoEl = document.createElement('div');
    infoEl.className = 'rail-flyout-info';
    const name = document.createElement('div');
    name.className = 'rail-flyout-name';
    name.textContent = ws.name;
    name.dataset.tip = 'Double-click to rename';
    name.addEventListener('dblclick', () => startRenameWorkspace(name, ws, handlers));
    const sub = document.createElement('div');
    sub.className = 'rail-flyout-sub';
    sub.textContent = `${info.n} agent${info.n === 1 ? '' : 's'} · ${ws.path}`;
    infoEl.append(name, sub);

    const x = document.createElement('button');
    x.className = 'rail-flyout-x';
    x.textContent = '✕';
    x.dataset.tip = 'Remove workspace';
    x.addEventListener('click', () => handlers.onRemove(ws.id));

    flyout.append(infoEl, x);
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

      if (info.n > 0) {
        const badge = document.createElement('span');
        badge.className = 'rail-n';
        badge.textContent = info.n;
        badge.dataset.tip = `${info.n} agent${info.n > 1 ? 's' : ''} in this workspace`;
        tile.appendChild(badge);
      }

      tile.addEventListener('click', () => handlers.onSelect(ws.id));
      tile.addEventListener('mouseenter', () => showFlyout(tile, ws, info, handlers));
      tile.addEventListener('mouseleave', scheduleHideFlyout);
      workspacesEl.appendChild(tile);
    });
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

  /* notification center: 🔔 with unread badge + event-history popover */
  const notifBtn = document.getElementById('notif-btn');
  const notifBadge = document.getElementById('notif-n');
  const notifPop = document.getElementById('notif-pop');

  function fmtClock(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderNotifications(notifs, unread, handlers) {
    notifBtn.classList.toggle('unread', unread > 0); // amber bell = something new
    notifBadge.hidden = unread === 0;
    notifBadge.textContent = unread > 99 ? '99+' : unread;

    notifPop.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'notif-head';
    const title = document.createElement('div');
    title.className = 'kbd-title';
    title.textContent = 'Notifications';
    head.appendChild(title);
    const expand = document.createElement('button');
    expand.className = 'notif-clear';
    expand.textContent = 'details ▸';
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
      what.textContent = n.text;
      body.append(who, what);
      if (n.cmd) {
        // same accent-bar + mono-text treatment as the pane's initial-command row
        const cmd = document.createElement('div');
        cmd.className = 'notif-cmd';
        const bar = document.createElement('span');
        bar.className = 'pane-subheader-bar';
        const cmdText = document.createElement('span');
        cmdText.className = 'notif-what';
        cmdText.textContent = n.cmd;
        cmd.append(bar, cmdText);
        body.appendChild(cmd);
      }

      const time = document.createElement('span');
      time.className = 'notif-time';
      time.textContent = fmtClock(n.time);

      row.append(dot, body, time);
      notifPop.appendChild(row);
    }
  }

  /* notification panel: right-side docked view (same slot pattern as the
   * left icon rail) — full, untruncated detail for every event, no cap. */
  const notifPanelList = document.getElementById('notif-panel-list');

  function fmtFull(t) {
    return new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  }

  // "1d 3h", "1h 12m", "3m"
  function fmtDur(minutes) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const min = minutes % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${min}m`;
    return `${min}m`;
  }

  // how long the agent had been running when the event fired — elapsed time
  // rounds down, and "no start time recorded" is not the same as "0m"
  function fmtRuntime(ms) {
    if (ms == null || ms < 0) return null;
    return fmtDur(Math.floor(ms / 60000));
  }

  function renderNotifPanel(notifs, handlers) {
    notifPanelList.innerHTML = '';
    if (!notifs.length) {
      const empty = document.createElement('div');
      empty.className = 'notif-empty';
      empty.textContent = 'nothing yet — agent events land here';
      notifPanelList.appendChild(empty);
      return;
    }

    for (const n of notifs) {
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
      what.textContent = n.text;
      body.append(who, what);
      if (n.cmd) {
        const cmd = document.createElement('div');
        cmd.className = 'notif-cmd';
        const bar = document.createElement('span');
        bar.className = 'pane-subheader-bar';
        const cmdText = document.createElement('span');
        cmdText.className = 'notif-panel-what';
        cmdText.textContent = n.cmd;
        cmd.append(bar, cmdText);
        body.appendChild(cmd);
      }

      // model / permission mode / how-long-it-had-been-running when the event fired
      const runtime = fmtRuntime(n.createdAt ? n.time - n.createdAt : null);
      const metaParts = [n.model || 'default model', n.mode ? `${n.mode} mode` : null, runtime ? `running ${runtime}` : null].filter(Boolean);
      const meta = document.createElement('div');
      meta.className = 'notif-panel-meta';
      meta.textContent = metaParts.join(' · ');
      body.appendChild(meta);

      const time = document.createElement('div');
      time.className = 'notif-panel-time';
      time.textContent = fmtFull(n.time);
      body.appendChild(time);

      row.append(dot, body);
      notifPanelList.appendChild(row);
    }
  }

  /* archived workspaces: 🗃 pill (hidden when empty) + restore/delete popover.
   * The ✕ arm/confirm state lives in module scope, not just a CSS class —
   * this popover is rebuilt on every agent status flip, which would wipe an
   * armed button mid-confirm and make the second click just re-arm. */
  let armedArchPurge = { id: null, until: 0 };
  function renderArchive(archived, handlers) {
    archiveBtn.style.display = archived.length ? '' : 'none';
    archiveBtn.querySelectorAll('.rail-n').forEach((el) => el.remove());
    if (archived.length) {
      const n = document.createElement('span');
      n.className = 'rail-n';
      n.textContent = archived.length;
      archiveBtn.appendChild(n);
    }
    if (!archived.length) archivePop.hidden = true;

    archivePop.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'kbd-title';
    title.textContent = 'Archived workspaces';
    archivePop.appendChild(title);

    for (const ws of archived) {
      const row = document.createElement('div');
      row.className = 'arch-row';

      const info = document.createElement('div');
      info.className = 'arch-info';
      const name = document.createElement('div');
      name.className = 'arch-name';
      name.textContent = ws.name;
      const p = document.createElement('div');
      p.className = 'arch-path';
      p.textContent = ws.path;
      p.dataset.tip = ws.path;
      info.append(name, p);

      const restore = document.createElement('button');
      restore.className = 'arch-restore';
      restore.textContent = 'restore';
      restore.dataset.tip = 'Bring this workspace back';
      restore.addEventListener('click', () => handlers.onRestore(ws.id));

      const del = document.createElement('button');
      del.className = 'arch-del';
      del.textContent = '✕';
      del.dataset.tip = 'Remove from archive (click twice)';
      del.addEventListener('click', () => {
        if (armedArchPurge.id === ws.id && Date.now() < armedArchPurge.until) {
          armedArchPurge = { id: null, until: 0 };
          handlers.onPurge(ws.id);
          return;
        }
        armedArchPurge = { id: ws.id, until: Date.now() + 3000 };
        del.classList.add('armed');
        setTimeout(() => del.classList.remove('armed'), 3000);
      });
      if (armedArchPurge.id === ws.id && Date.now() < armedArchPurge.until) del.classList.add('armed');

      row.append(info, restore, del);
      archivePop.appendChild(row);
    }
  }

  function updateSessionCount(visible, total, max, byStatus) {
    const parts = [];
    if (byStatus) {
      if (byStatus.working) parts.push(`${byStatus.working} busy`);
      if (byStatus.idle) parts.push(`${byStatus.idle} idle`);
      if (byStatus.exited) parts.push(`${byStatus.exited} exited`);
    }
    parts.push(total > visible
      ? `${visible} here · ${total}/${max} total`
      : `${total}/${max} agents`);
    countEl.textContent = parts.join(' · ');
    addAgentBtn.disabled = total >= max;
  }

  // time remaining rounds up, so a countdown never shows "0m" while it still
  // has seconds left on it
  function fmtIn(ms) {
    if (ms <= 0) return 'now';
    return fmtDur(Math.ceil(ms / 60000));
  }

  function renderRow(rowId, data) {
    const fill = document.getElementById(rowId).querySelector('.u-fill');
    if (!data || data.usedPct == null) {
      fill.style.height = '0%';
      fill.classList.remove('warn', 'crit');
      return null;
    }
    const p = Math.max(0, Math.min(100, data.usedPct));
    fill.style.height = p + '%';
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
    if (s.ok) {
      const p5 = renderRow('usage-5h', s.fiveHour);
      const p7 = renderRow('usage-7d', s.weekly);
      renderGauge('gauge-5h', 'gauge-5h-sub', s.fiveHour);
      renderGauge('gauge-7d', 'gauge-7d-sub', s.weekly);
      usageEl.dataset.tip = usageGaugesEl.dataset.tip = 'click to refresh';
    } else {
      renderRow('usage-5h', null);
      renderRow('usage-7d', null);
      renderGauge('gauge-5h', 'gauge-5h-sub', null);
      renderGauge('gauge-7d', 'gauge-7d-sub', null);
      usageEl.dataset.tip = usageGaugesEl.dataset.tip = 'click to refresh';
    }
  }

  // keep "resets in" countdowns fresh between polls
  setInterval(() => renderUsage(null), 30000);

  return { renderWorkspaces, renderArchive, renderNotifications, renderNotifPanel, updateSessionCount, renderUsage };
})();

window.Topbar = Topbar;
