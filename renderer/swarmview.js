/* Swarm View: a bird's-eye map of every agent across every workspace.
 *
 * Fourth full view in the same slot as the Task Board, Skills and History.
 * Left is the map — each agent a node whose fill is its workspace's identity
 * colour and whose ring animation is its status; right is the dock: a live
 * terminal preview of every running agent on top (optional), then the activity
 * list.
 *
 * All state is owned by app.js and handed in on every render() — this module
 * keeps only what is purely presentational (selection, the two layout/dock
 * options, and how long each agent has been in its current state).
 *
 * Rendering reconciles in place rather than rebuilding: a full innerHTML swap
 * would restart every pulse animation on each hook tick (status flips arrive
 * several times a second with a busy swarm) and orphan the hover tooltip of
 * whatever node the cursor is resting on — the same reason Topbar's swarm map
 * patches its slots. Exposes the global `SwarmView`.
 */

const SwarmView = (() => {
  const el = document.getElementById('swarm-view');
  const canvasEl = document.getElementById('sv-canvas');
  const bodyEl = document.getElementById('sv-body');
  const sceneEl = document.getElementById('sv-scene');
  const zoomEl = document.getElementById('sv-zoom');
  const resizerEl = document.getElementById('sv-resizer');
  const dockEl = document.getElementById('sv-dock');
  const fontMinusEl = document.getElementById('sv-font-minus');
  const fontPlusEl = document.getElementById('sv-font-plus');
  const mapFontMinusEl = document.getElementById('sv-map-font-minus');
  const mapFontPlusEl = document.getElementById('sv-map-font-plus');
  const linksEl = document.getElementById('sv-links');
  const hubsEl = document.getElementById('sv-hubs');
  const nodesEl = document.getElementById('sv-nodes');
  const emptyEl = document.getElementById('sv-empty');
  const countsEl = document.getElementById('sv-counts');
  const layoutSegEl = document.getElementById('sv-layout');
  const previewBtn = document.getElementById('sv-preview-btn');
  const clickBtn = document.getElementById('sv-click-btn');
  const termsEl = document.getElementById('sv-terms');
  const menuEl = document.getElementById('sv-menu');
  const agentsListEl = document.getElementById('sv-agents-list');
  const agentsMetaEl = document.getElementById('sv-agents-meta');

  /* status here is finer-grained than Pane.status: a pane blocked on a
   * permission prompt and one that merely finished its turn are both
   * 'attention' to the grid, but on the map they are the difference between
   * "it needs you now" and "it's done". */
  const STATE_COLOR = {
    busy: 'var(--accent)',
    waiting: 'var(--amber)',
    done: 'var(--entry-dot)',
    idle: 'var(--muted2)',
    detached: 'var(--amber)',
    exited: 'var(--err)',
  };
  const STATE_SIZE = { busy: 22, waiting: 20, done: 18, idle: 14, detached: 13, exited: 12 };
  // how long an agent has to sit wanting attention before its halo is at full
  // intensity — a forgotten agent gets visually louder rather than staying flat
  const URGENCY_FULL_MS = 5 * 60 * 1000;
  const HOVER_LINES = 30; // a hovered card opens up to most of the dock
  // a preview card holds a terminal, so it should read like one: its height
  // follows the dock's width instead of being a fixed number of lines
  const PREVIEW_MIN = 6;
  const PREVIEW_MAX = 20;
  const PREVIEW_ASPECT = 2.4; // width : height of a card's body
  const STATUSES = ['busy', 'waiting', 'done', 'idle', 'detached', 'exited'];
  // arc a node gets along its orbit, in px: less than this and the labels of
  // neighbouring agents run into each other
  const LEAN_ARC = 78;
  const LEAN_HARD_ARC = 46;

  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 4;
  const FONT_MIN = 0.75;
  const FONT_MAX = 2;
  const FONT_STEP = 1.1;
  const DOCK_MIN = 300; // narrower than this and the rows start truncating
  const MAP_MIN = 360; // the map never gets dragged out of existence

  let layout = localStorage.getItem('swarmeye.svLayout') || 'clusters';
  if (layout !== 'clusters' && layout !== 'ring') layout = 'clusters';
  let showPreview = localStorage.getItem('swarmeye.svPreview') !== '0';
  let clickMode = localStorage.getItem('swarmeye.svClick') === 'jump' ? 'jump' : 'select';

  let fontScale = parseFloat(localStorage.getItem('swarmeye.svFont'));
  if (!(fontScale >= FONT_MIN && fontScale <= FONT_MAX)) fontScale = 1;
  let mapFontScale = parseFloat(localStorage.getItem('swarmeye.svMapFont'));
  if (!(mapFontScale >= FONT_MIN && mapFontScale <= FONT_MAX)) mapFontScale = 1;
  let dockW = parseInt(localStorage.getItem('swarmeye.svDockW'), 10);
  if (!Number.isFinite(dockW) || dockW <= 0) dockW = 0; // 0 = never dragged, let the stylesheet decide

  // the map's own viewport: a scale and an offset, both in canvas pixels
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // statuses the map is pinned to; empty = show everything
  let filter = new Set((localStorage.getItem('swarmeye.svFilter') || '').split(',').filter((s) => STATUSES.includes(s)));

  let selectedId = null;
  let hoveredId = null; // the agent the cursor is resting on — a node or its card
  let previewLines = 9; // recomputed from the dock's width
  let ctx = null; // last render context, so the ticker and the option pills can repaint
  let tick = null;
  // sessionId -> {status, at}: when each agent entered the state it is in now
  const stateSince = new Map();

  const nodeEls = new Map(); // sessionId -> {root, dot, name, state, yes, no}
  const hubEls = new Map(); // hub key -> element
  const lineEls = new Map(); // link key -> <line>

  /* ---- tiny DOM helpers: write only on change, so reconciling a node that
   * didn't move neither restarts its animations nor dirties layout ---- */

  function setText(node, s) {
    if (node.textContent !== s) node.textContent = s;
  }

  function setClass(node, s) {
    if (node.className !== s) node.className = s;
  }

  function setStyle(node, prop, v) {
    if (node.style[prop] !== v) node.style[prop] = v;
  }

  function setAttr(node, name, v) {
    if (node.getAttribute(name) !== v) node.setAttribute(name, v);
  }

  // custom properties don't exist on style as plain keys — they carry the
  // per-node workspace/status colours the stylesheet paints with
  function setVar(node, name, v) {
    if (node.style.getPropertyValue(name) !== v) node.style.setProperty(name, v);
  }

  /* ---- agent state ---- */

  function statusOf(pane) {
    if (pane.exited) return pane.detached ? 'detached' : 'exited';
    if (pane.awaitingPrompt) return 'waiting';
    if (pane.working) return 'busy';
    if (pane.attention) return 'done';
    return 'idle';
  }

  /* What the agent is doing, in its own words: the hooks' status text (the
   * running tool, "vibing...", the permission message, "done") when there is
   * one, else a plain description of the state. */
  function activityOf(pane, status) {
    const text = (pane.statusText || '').trim();
    if (status === 'detached') return 'detached — ↻ reattach to reconnect';
    if (status === 'exited') return 'exited';
    if (text) return text;
    if (status === 'busy') return 'working…';
    if (status === 'waiting') return 'waiting for you';
    if (status === 'done') return 'done';
    return 'idle';
  }

  /* Age of the current state. Seeded from the pane's own turn/wait clocks so
   * an agent that was already busy when the view opened doesn't read as
   * freshly started; from then on it's this module's own stopwatch, which is
   * the only clock that exists for "finished, nobody has looked yet". */
  function ageOf(pane, status) {
    const id = pane.session.id;
    const rec = stateSince.get(id);
    if (!rec || rec.status !== status) {
      const seed = status === 'busy' ? pane.turnStartedAt : status === 'waiting' ? pane.waitingSince : 0;
      const next = { status, at: seed || Date.now() };
      stateSince.set(id, next);
      return 0;
    }
    return Date.now() - rec.at;
  }

  function wsColorOf(pane) {
    const ws = (ctx.workspaces || []).find((w) => w.id === pane.session.workspaceId);
    return (ws && ws.color) || 'var(--muted2)';
  }

  // panes ordered by workspace (rail order), then by age — a stable order, so
  // nodes keep their place on the map across renders. The status filter is
  // applied here, so map, links, list and previews all narrow together.
  function orderedPanes() {
    const rank = new Map((ctx.workspaces || []).map((w, i) => [w.id, i]));
    const kept = filter.size ? ctx.panes.filter((p) => filter.has(statusOf(p))) : [...ctx.panes];
    return kept.sort((a, b) => {
      const ra = rank.has(a.session.workspaceId) ? rank.get(a.session.workspaceId) : 999;
      const rb = rank.has(b.session.workspaceId) ? rank.get(b.session.workspaceId) : 999;
      if (ra !== rb) return ra - rb;
      return (a.session.createdAt || 0) - (b.session.createdAt || 0);
    });
  }

  /* The dock is read top-down, so the agents that are doing something — or
   * want something from you — belong at the top and the quiet ones at the
   * bottom: busy, waiting, done, idle, then the dead ones. `STATUSES` is
   * already in that order (it is the order the count chips sit in), and the
   * sort is stable, so agents sharing a status keep their workspace/age order.
   * The map keeps orderedPanes() as it is: a node that re-sorted on every
   * status flip would never hold still. */
  function dockOrder(panes) {
    return [...panes].sort((a, b) => STATUSES.indexOf(statusOf(a)) - STATUSES.indexOf(statusOf(b)));
  }

  /* ---- layout ----
   * Coordinates are percentages of the canvas, but every orbit is measured in
   * pixels and converted back per axis, so an orbit is a true circle on screen
   * instead of the canvas' own aspect ratio. One radius per kind of link — no
   * alternating bands, no widening for a bigger crew — which is what makes
   * every link on the map the same length. */

  const HUB_RING = 31; // core → workspace hub
  const CLUSTER_ORBIT = 12; // hub → agent, when the swarm spans workspaces
  const SOLO_ORBIT = 34; // hub → agent, when a single hub owns the canvas

  /* The canvas only changes size when the ResizeObserver at the bottom says
   * so — measuring it inside render() forced a style+layout flush right after
   * syncChrome's DOM writes, several times a second. Same for the body and
   * dock widths below. */
  let geoCache = null;
  function geometry() {
    if (!geoCache) {
      const r = canvasEl.getBoundingClientRect();
      geoCache = { pxPerX: (r.width || 1) / 100, pxPerY: (r.height || 1) / 100 };
    }
    return geoCache;
  }

  // a point `rPct` of the canvas height from (cx, cy), at `ang`
  function orbit(cx, cy, ang, rPct, geo) {
    const rPx = rPct * geo.pxPerY;
    return {
      x: cx + ((rPx * Math.cos(ang)) / geo.pxPerX),
      y: cy + ((rPx * Math.sin(ang)) / geo.pxPerY),
    };
  }

  function ringLayout(panes, geo) {
    const n = panes.length || 1;
    const nodes = panes.map((pane, i) => {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { pane, ...orbit(50, 50, ang, SOLO_ORBIT, geo), hubKey: 'core' };
    });
    return {
      hubs: [{ key: 'core', x: 50, y: 50, label: 'swarm', count: panes.length, color: null, core: true }],
      nodes,
    };
  }

  function clusterLayout(panes, geo) {
    const groups = [];
    const byWs = new Map();
    for (const pane of panes) {
      const id = pane.session.workspaceId;
      let g = byWs.get(id);
      if (!g) {
        const ws = (ctx.workspaces || []).find((w) => w.id === id);
        g = { id, name: (ws && ws.name) || pane.session.workspaceName || 'workspace', color: (ws && ws.color) || null, panes: [] };
        byWs.set(id, g);
        groups.push(g);
      }
      g.panes.push(pane);
    }

    const hubs = [];
    const nodes = [];
    const m = groups.length;

    // a lone workspace owns the whole canvas — no point orbiting a core that
    // would sit right on top of it
    if (m === 1) {
      const g = groups[0];
      hubs.push({ key: g.id, x: 50, y: 50, label: g.name, count: g.panes.length, color: g.color, core: true });
      const n = g.panes.length || 1;
      g.panes.forEach((pane, i) => {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        nodes.push({ pane, ...orbit(50, 50, ang, SOLO_ORBIT, geo), hubKey: g.id });
      });
      return { hubs, nodes };
    }

    hubs.push({ key: 'core', x: 50, y: 50, label: 'swarm', count: panes.length, color: null, core: true });
    groups.forEach((g, k) => {
      const ang = (k / m) * Math.PI * 2 - Math.PI / 2;
      const h = orbit(50, 50, ang, HUB_RING, geo);
      hubs.push({ key: g.id, x: h.x, y: h.y, label: g.name, count: g.panes.length, color: g.color, core: false });
      const n = g.panes.length || 1;
      g.panes.forEach((pane, i) => {
        // the crew fans out from the side its hub faces, always at one radius
        const a = (i / n) * Math.PI * 2 - Math.PI / 2 + ang;
        nodes.push({ pane, ...orbit(h.x, h.y, a, CLUSTER_ORBIT, geo), hubKey: g.id });
      });
    });
    return { hubs, nodes };
  }

  /* ---- map ---- */

  function paintLinks(plan, geo) {
    const seen = new Set();
    const line = (key, x1, y1, x2, y2, color, opacity, busy) => {
      let l = lineEls.get(key);
      if (!l) {
        l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        lineEls.set(key, l);
        linksEl.appendChild(l);
      }
      setAttr(l, 'x1', x1.toFixed(2));
      setAttr(l, 'y1', y1.toFixed(2));
      setAttr(l, 'x2', x2.toFixed(2));
      setAttr(l, 'y2', y2.toFixed(2));
      setVar(l, '--ws', color);
      // the stylesheet turns this into the line's opacity, so a light chassis
      // can lift the whole ramp at once (see --ws-op-boost in chrome-clean.css)
      setVar(l, '--ws-op', String(opacity));
      // the dash only flows on a busy agent's link (see app.css) — setAttr,
      // not className, which is read-only on SVG elements
      setAttr(l, 'class', 'ws-tint' + (busy ? ' sv-link-busy' : ''));
      seen.add(key);
    };

    /* A link runs centre to centre, but a centre is under something — a hub's
     * disc, an agent's dot — so each end is pulled back by what sits there,
     * in pixels rather than in a share of the line, so the trim is the same
     * whether a link is long or short. The agent end stops *on* its dot, so
     * the line still reaches the agent; the hub end leaves a gap past the
     * disc, which is what shortens the line. */
    const trim = (x1, y1, x2, y2, px1, px2) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx * geo.pxPerX, dy * geo.pxPerY);
      if (!len) return [x1, y1, x2, y2];
      const a = Math.min(px1 / len, 0.6);
      const b = Math.min(px2 / len, 0.6 - Math.min(px1 / len, 0.6));
      return [x1 + dx * a, y1 + dy * a, x2 - dx * b, y2 - dy * b];
    };
    const HUB_R = 38; // .sv-hub is 76px across, .sv-hub-core 92px
    const CORE_R = 46;
    const HUB_GAP = 4; // just clear of the disc — any more and the link floats
    // one trim for every agent, whatever its status sizes its dot: a link that
    // varied with the dot would no longer be the same length as its neighbours
    const DOT_R = 7;

    const core = plan.hubs.find((h) => h.core);
    for (const hub of plan.hubs) {
      if (hub.core || !core) continue;
      line('hub:' + hub.key, ...trim(core.x, core.y, hub.x, hub.y, CORE_R + HUB_GAP, HUB_R + HUB_GAP), hub.color || 'var(--accent)', 0.28, false);
    }
    for (const node of plan.nodes) {
      const hub = plan.hubs.find((h) => h.key === node.hubKey) || core;
      if (!hub) continue;
      const status = statusOf(node.pane);
      const opacity = status === 'exited' ? 0.1 : status === 'detached' ? 0.16 : status === 'idle' ? 0.2 : 0.42;
      const hubR = (hub.core ? CORE_R : HUB_R) + HUB_GAP;
      line('node:' + node.pane.session.id, ...trim(hub.x, hub.y, node.x, node.y, hubR, DOT_R), wsColorOf(node.pane), opacity, status === 'busy');
    }

    for (const [key, l] of lineEls) {
      if (!seen.has(key)) { l.remove(); lineEls.delete(key); }
    }
  }

  function paintHubs(plan) {
    const seen = new Set();
    for (const hub of plan.hubs) {
      let box = hubEls.get(hub.key);
      if (!box) {
        box = document.createElement('div');
        box.className = 'sv-hub';
        const label = document.createElement('span');
        label.className = 'sv-hub-label';
        const count = document.createElement('span');
        count.className = 'sv-hub-count';
        const ring = document.createElement('i');
        ring.className = 'sv-hub-ring';
        const ring2 = document.createElement('i');
        ring2.className = 'sv-hub-ring2';
        box.append(ring, ring2, label, count);
        box._label = label;
        box._count = count;
        hubEls.set(hub.key, box);
        hubsEl.appendChild(box);
      }
      setClass(box, 'sv-hub ws-tint' + (hub.core ? ' sv-hub-core' : ''));
      setStyle(box, 'left', hub.x.toFixed(2) + '%');
      setStyle(box, 'top', hub.y.toFixed(2) + '%');
      setVar(box, '--ws', hub.color || 'var(--accent)');
      setText(box._label, hub.label);
      setText(box._count, String(hub.count));
      seen.add(hub.key);
    }
    for (const [key, box] of hubEls) {
      if (!seen.has(key)) { box.remove(); hubEls.delete(key); }
    }
  }

  function makeNode(pane) {
    const root = document.createElement('div');
    root.className = 'sv-node';
    root.dataset.id = pane.session.id;

    const dot = document.createElement('span');
    dot.className = 'sv-node-dot';
    const pulse = document.createElement('i');
    pulse.className = 'sv-node-pulse';
    const halo = document.createElement('i');
    halo.className = 'sv-node-halo';
    dot.append(halo, pulse);

    const name = document.createElement('span');
    name.className = 'sv-node-name';
    const state = document.createElement('span');
    state.className = 'sv-node-state';

    const actions = document.createElement('span');
    actions.className = 'sv-node-actions';
    const yes = document.createElement('button');
    yes.className = 'sv-yes';
    Icons.set(yes, 'check');
    yes.dataset.tip = 'Approve — shift-click to also stop asking';
    const no = document.createElement('button');
    no.className = 'sv-no';
    Icons.set(no, 'close');
    no.dataset.tip = 'Deny';
    actions.append(yes, no);

    root.append(dot, name, state, actions);
    const id = pane.session.id;
    wireAgentEl(root, id, yes, no);
    // pointing at an agent on the map is enough to read it: the dock scrolls to
    // that agent and opens its preview, no click and no selection change
    root.addEventListener('mouseenter', () => hover(id, true));
    root.addEventListener('mouseleave', () => unhover(id));
    nodesEl.appendChild(root);
    const rec = { root, dot, name, state, actions };
    nodeEls.set(pane.session.id, rec);
    return rec;
  }

  /* Both a map node and an activity row behave the same way: select or jump
   * on click depending on the mode, always jump on double-click, and answer
   * a permission prompt from the ✓/✕ without leaving the view. */
  function wireAgentEl(root, id, yes, no) {
    root.addEventListener('click', (e) => {
      if (e.target.closest('.sv-yes, .sv-no')) return;
      if (clickMode === 'jump') ctx.handlers.onOpen(id);
      else select(id);
    });
    root.addEventListener('dblclick', (e) => {
      if (e.target.closest('.sv-yes, .sv-no')) return;
      ctx.handlers.onOpen(id);
    });
    yes.addEventListener('click', (e) => { e.stopPropagation(); ctx.handlers.onApprove(id, e.shiftKey); });
    no.addEventListener('click', (e) => { e.stopPropagation(); ctx.handlers.onDeny(id); });
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(id, e.clientX, e.clientY);
    });
  }

  function paintNodes(plan) {
    const seen = new Set();
    for (const node of plan.nodes) {
      const pane = node.pane;
      const id = pane.session.id;
      const rec = nodeEls.get(id) || makeNode(pane);
      const status = statusOf(pane);
      const age = ageOf(pane, status);

      setClass(rec.root, 'sv-node ws-tint sv-node-' + status + (id === selectedId ? ' sv-node-sel' : ''));
      setStyle(rec.root, 'left', node.x.toFixed(2) + '%');
      setStyle(rec.root, 'top', node.y.toFixed(2) + '%');
      // fill carries the workspace, the pulse ring carries the status
      setVar(rec.root, '--ws', wsColorOf(pane));
      setVar(rec.root, '--sv-state', STATE_COLOR[status]);
      setVar(rec.root, '--sv-size', STATE_SIZE[status] + 'px');
      // an unanswered agent's halo swells the longer it goes unanswered
      const urgent = status === 'waiting' || status === 'done';
      setVar(rec.root, '--sv-urgency', urgent ? Math.min(1, age / URGENCY_FULL_MS).toFixed(2) : '0');

      setText(rec.name, pane.session.agentName);
      const activity = activityOf(pane, status);
      setText(rec.state, urgent && age > 20000 ? `${status} ${fmtAge(age)}` : status);
      setAttr(rec.root, 'data-tip', `${pane.session.agentName} · ${pane.session.workspaceName}`);
      setAttr(rec.root, 'data-tip-secondary', activity);
      setStyle(rec.actions, 'display', status === 'waiting' && pane.promptAnswerable ? '' : 'none');
      seen.add(id);
    }
    for (const [id, rec] of nodeEls) {
      // its stopwatch goes with it — nothing else prunes stateSince, so an
      // agent that ever appeared would otherwise stay in the map forever
      if (!seen.has(id)) { rec.root.remove(); nodeEls.delete(id); stateSince.delete(id); }
    }
  }

  /* ---- dock: activity list ---- */

  // Pane.fmtDuration — the same formatter the cost panel uses, not a copy
  const fmtAge = (ms) => Pane.fmtDuration(ms);

  function makeRow(pane) {
    const row = document.createElement('div');
    row.className = 'sv-row';
    row.dataset.id = pane.session.id;

    const dot = document.createElement('span');
    dot.className = 'sv-row-dot ws-tint';

    const main = document.createElement('div');
    main.className = 'sv-row-main';
    const top = document.createElement('div');
    top.className = 'sv-row-top';
    const ws = document.createElement('span');
    ws.className = 'sv-row-ws';
    const name = document.createElement('span');
    name.className = 'sv-row-name';
    top.append(ws, name);
    const what = document.createElement('div');
    what.className = 'sv-row-what';
    main.append(top, what);

    const meta = document.createElement('div');
    meta.className = 'sv-row-meta';
    const age = document.createElement('span');
    age.className = 'sv-row-age';
    const cost = document.createElement('span');
    cost.className = 'sv-row-cost';
    meta.append(age, cost);

    const actions = document.createElement('span');
    actions.className = 'sv-row-actions';
    const yes = document.createElement('button');
    yes.className = 'sv-yes';
    Icons.set(yes, 'check');
    yes.dataset.tip = 'Approve — shift-click to also stop asking';
    const no = document.createElement('button');
    no.className = 'sv-no';
    Icons.set(no, 'close');
    no.dataset.tip = 'Deny';
    actions.append(yes, no);

    row.append(dot, main, meta, actions);
    wireAgentEl(row, pane.session.id, yes, no);
    return { row, dot, ws, name, what, age, cost, actions };
  }

  const rowEls = new Map();
  const rowsEmptyEl = document.createElement('div');
  rowsEmptyEl.className = 'sv-notes-empty';
  rowsEmptyEl.textContent = 'no agents yet — every workspace is quiet';

  function paintRows(panes) {
    const seen = new Set();
    if (!panes.length && !rowsEmptyEl.isConnected) agentsListEl.appendChild(rowsEmptyEl);
    if (panes.length && rowsEmptyEl.isConnected) rowsEmptyEl.remove();
    panes.forEach((pane, i) => {
      const id = pane.session.id;
      const rec = rowEls.get(id) || (() => { const r = makeRow(pane); rowEls.set(id, r); return r; })();
      const status = statusOf(pane);
      const age = ageOf(pane, status);

      setClass(rec.row, 'sv-row sv-row-' + status
        + (id === selectedId ? ' sv-row-sel' : '')
        + (id === hoveredId ? ' sv-row-hot' : ''));
      setVar(rec.dot, '--ws', wsColorOf(pane));
      setVar(rec.row, '--sv-state', STATE_COLOR[status]);
      setText(rec.ws, pane.session.workspaceName || '');
      setText(rec.name, pane.session.agentName);
      setText(rec.what, activityOf(pane, status));
      setText(rec.age, status === 'idle' || status === 'exited' || status === 'detached' ? '' : fmtAge(age));
      const u = pane.usage;
      setText(rec.cost, u ? fmtCost(u.cost) + ' · ' + fmtTokens(u.context) : '');
      setAttr(rec.row, 'data-tip', clickMode === 'jump' ? 'Jump to this agent' : 'Select — double-click to jump to it');
      setStyle(rec.actions, 'display', status === 'waiting' && pane.promptAnswerable ? '' : 'none');

      // keep DOM order in sync with the sorted list without rebuilding rows
      if (agentsListEl.children[i] !== rec.row) agentsListEl.insertBefore(rec.row, agentsListEl.children[i] || null);
      seen.add(id);
    });
    for (const [id, rec] of rowEls) {
      if (!seen.has(id)) { rec.row.remove(); rowEls.delete(id); }
    }
  }

  /* ---- dock: a terminal preview per live agent ----
   * Every agent that is still running gets its own card, so the whole swarm's
   * output is readable at once rather than one agent at a time; an exited one
   * is dropped, since its last screen is frozen and the row already says so. */

  const termCards = new Map(); // sessionId -> {card, dot, ws, name, state, body, actions}

  function makeTermCard(pane) {
    const card = document.createElement('div');
    card.className = 'sv-term';

    const bar = document.createElement('div');
    bar.className = 'sv-term-bar';
    const dot = document.createElement('span');
    dot.className = 'sv-term-dot ws-tint';
    const ws = document.createElement('span');
    ws.className = 'sv-term-ws';
    const name = document.createElement('span');
    name.className = 'sv-term-name';
    const state = document.createElement('span');
    state.className = 'sv-term-state';

    const actions = document.createElement('span');
    actions.className = 'sv-row-actions';
    const yes = document.createElement('button');
    yes.className = 'sv-yes';
    Icons.set(yes, 'check');
    yes.dataset.tip = 'Approve — shift-click to also stop asking';
    const no = document.createElement('button');
    no.className = 'sv-no';
    Icons.set(no, 'close');
    no.dataset.tip = 'Deny';
    actions.append(yes, no);

    bar.append(dot, ws, name, state, actions);
    const body = document.createElement('div');
    body.className = 'sv-term-body';
    card.append(bar, body);
    wireAgentEl(card, pane.session.id, yes, no);

    /* Hovering a card opens it up to most of the dock and fills it with far
     * more of that agent's output — a glance at all of them, a read of one,
     * without leaving the map. */
    const id = pane.session.id;
    card.addEventListener('mouseenter', () => hover(id, false));
    card.addEventListener('mouseleave', () => unhover(id));
    return { card, dot, ws, name, state, body, actions };
  }

  /* the tail of the agent's own terminal, blank lines dropped so the card
   * shows output rather than the TUI's padding. Split out so hovering a card
   * can refill just that one without a whole render(). */
  function paintTermBody(rec, pane, open, flat) {
    const want = open ? HOVER_LINES : previewLines;
    // a folded card shows nothing, so don't pay to read its terminal — and an
    // unchanged buffer (pane.writeSeq) isn't re-read at all: tailLines'
    // translateToString per row is the expensive part, and this runs for every
    // live pane on every render beat. Same inputs, same lines, DOM already right.
    const sig = flat ? 'flat' : `${pane.writeSeq}:${open}:${want}`;
    if (rec.tailSig === sig) return;
    rec.tailSig = sig;
    const lines = flat ? [] : pane.tailLines(open ? 90 : 30).map((l) => l.trimEnd()).filter(Boolean).slice(-want);
    const text = lines.join('\n');
    if (rec.body.dataset.text === text) return;
    rec.body.dataset.text = text;
    rec.body.textContent = '';
    for (const line of lines) {
      const div = document.createElement('div');
      div.className = /^[●⏺✻]/.test(line) ? 'sv-term-line-run' : /^\s*[⎿│]/.test(line) ? 'sv-term-line-dim' : '';
      div.textContent = line;
      rec.body.appendChild(div);
    }
  }

  function paintPreviews(panes) {
    const live = showPreview ? panes.filter((p) => !p.exited) : [];
    termsEl.hidden = !live.length;

    const seen = new Set();
    live.forEach((pane, i) => {
      const id = pane.session.id;
      const rec = termCards.get(id) || (() => { const r = makeTermCard(pane); termCards.set(id, r); return r; })();
      const status = statusOf(pane);

      const open = id === hoveredId;
      // an idle agent has nothing to watch: its card folds down to its own
      // header until it starts working again — or until you hover it
      const flat = status === 'idle' && !open;
      setClass(rec.card, 'sv-term'
        + (id === selectedId ? ' sv-term-sel' : '')
        + (open ? ' sv-term-open' : '')
        + (flat ? ' sv-term-flat' : ''));
      setVar(rec.card, '--sv-state', STATE_COLOR[status]);
      setVar(rec.dot, '--ws', wsColorOf(pane));
      setText(rec.ws, pane.session.workspaceName || '');
      setText(rec.name, pane.session.agentName);
      setText(rec.state, status);
      setStyle(rec.actions, 'display', status === 'waiting' && pane.promptAnswerable ? '' : 'none');
      setAttr(rec.card, 'data-tip', clickMode === 'jump' ? 'Jump to this agent' : 'Select — double-click to jump to it');

      paintTermBody(rec, pane, open, flat);

      if (termsEl.children[i] !== rec.card) termsEl.insertBefore(rec.card, termsEl.children[i] || null);
      seen.add(id);
    });
    for (const [id, rec] of termCards) {
      if (!seen.has(id)) { rec.card.remove(); termCards.delete(id); }
    }
  }

  /* ---- the counts, which are also the filter ----
   * Counted over every agent, not the filtered set — a chip that vanished
   * once it was the only thing showing could never be switched off again. */

  const chipEls = new Map();
  const totalEl = document.createElement('span');
  totalEl.className = 'sv-count-total';

  function toggleFilter(status) {
    if (filter.has(status)) filter.delete(status);
    else filter.add(status);
    localStorage.setItem('swarmeye.svFilter', [...filter].join(','));
    render(ctx);
  }

  function paintCounts() {
    const counts = {};
    for (const s of STATUSES) counts[s] = 0;
    for (const pane of ctx.panes) counts[statusOf(pane)] += 1;
    const live = ctx.panes.filter((p) => !p.exited).length;

    let i = 0;
    for (const s of STATUSES) {
      const on = filter.has(s);
      if (!counts[s] && !on) {
        const stale = chipEls.get(s);
        if (stale) { stale.remove(); chipEls.delete(s); }
        continue;
      }
      let btn = chipEls.get(s);
      if (!btn) {
        btn = document.createElement('button');
        btn.dataset.status = s;
        btn.addEventListener('click', () => toggleFilter(s));
        chipEls.set(s, btn);
      }
      setClass(btn, 'sv-count' + (on ? ' sv-count-on' : ''));
      setVar(btn, '--sv-chip', STATE_COLOR[s]);
      setText(btn, counts[s] + ' ' + s);
      btn.dataset.tip = on ? `Showing ${s} — click to stop filtering by it` : `Show only ${s} agents`;
      if (countsEl.children[i] !== btn) countsEl.insertBefore(btn, countsEl.children[i] || null);
      i += 1;
    }
    setText(totalEl, `${live}/${ctx.maxAgents} agents`);
    if (countsEl.lastChild !== totalEl) countsEl.appendChild(totalEl);
  }

  /* ---- label density ----
   * Every agent sits at the same radius — that is what makes the links equal
   * — so the only room a label has is angular. Work out the arc each node
   * gets and drop the status line, then the name, when it runs out. Zoom
   * counts: magnifying the map really does give the labels more room. */

  let baseArc = Infinity; // label arc at 100%, from the last layout

  function applyLean() {
    const arc = baseArc * zoom;
    nodesEl.classList.toggle('sv-lean', arc < LEAN_ARC);
    nodesEl.classList.toggle('sv-lean-hard', arc < LEAN_HARD_ARC);
  }

  function labelArc(plan, geo) {
    const perHub = new Map();
    for (const node of plan.nodes) perHub.set(node.hubKey, (perHub.get(node.hubKey) || 0) + 1);
    let worst = Infinity;
    for (const [key, n] of perHub) {
      const hub = plan.hubs.find((h) => h.key === key);
      const node = plan.nodes.find((nd) => nd.hubKey === key);
      if (!hub || !node) continue;
      const rPx = Math.hypot((node.x - hub.x) * geo.pxPerX, (node.y - hub.y) * geo.pxPerY);
      worst = Math.min(worst, (2 * Math.PI * rPx) / n);
    }
    return worst;
  }

  function paintDensity(plan, geo) {
    baseArc = plan.nodes.length ? labelArc(plan, geo) : Infinity;
    applyLean();
  }

  /* ---- right-click menu ----
   * The actions a pane's own header carries, reachable from the map: a swarm
   * can be unblocked, interrupted, cleared, restarted or ended without ever
   * opening the pane it belongs to. */

  let menuId = null;
  let menuMic = null; // dictation wired to the new-agent form's mic, while it is open

  // the mic must never outlive the form it belongs to — a menu dismissed
  // mid-dictation would otherwise keep recording into a textarea that is gone
  function stopMenuMic() {
    if (!menuMic) return;
    menuMic.stop();
    menuMic = null;
  }

  function closeMenu() {
    stopMenuMic();
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    menuId = null;
  }

  function call(name, ...args) {
    const fn = ctx && ctx.handlers && ctx.handlers[name];
    if (fn) fn(...args);
  }

  function openMenu(id, x, y) {
    const pane = (ctx.panes || []).find((p) => p.session.id === id);
    if (!pane) return;
    const status = statusOf(pane);
    stopMenuMic(); // this menu replaces the new-agent form without closing it
    menuId = id;
    menuEl.textContent = '';

    const head = document.createElement('div');
    head.className = 'sv-menu-head';
    const name = document.createElement('span');
    name.className = 'sv-menu-name';
    name.textContent = pane.session.agentName;
    const ws = document.createElement('span');
    ws.className = 'sv-menu-ws';
    ws.textContent = pane.session.workspaceName || '';
    head.append(name, ws);
    menuEl.appendChild(head);

    const item = (label, fire, opts = {}) => {
      const btn = document.createElement('button');
      btn.className = 'sv-menu-item' + (opts.danger ? ' sv-menu-danger' : '');
      btn.textContent = label;
      btn.disabled = !!opts.disabled;
      btn.addEventListener('click', () => {
        // ending an agent is the one irreversible item — click twice, the
        // same arm-then-fire every other destructive control in the app uses
        if (opts.confirmKey) {
          const fired = Confirm.armOrFire(btn, opts.confirmKey + ':' + id, () => { closeMenu(); fire(); });
          if (!fired) btn.textContent = 'click again to end it';
          return;
        }
        closeMenu();
        fire();
      });
      menuEl.appendChild(btn);
    };
    const sep = () => {
      const d = document.createElement('div');
      d.className = 'sv-menu-sep';
      menuEl.appendChild(d);
    };

    item('Open its pane', () => call('onOpen', id));
    if (status === 'waiting') {
      item('Approve', () => call('onApprove', id, false));
      item('Approve — stop asking', () => call('onApprove', id, true));
      item('Deny', () => call('onDeny', id));
    }
    item('Message it', () => call('onMessage', id), { disabled: pane.exited });
    sep();
    item('Interrupt (Esc)', () => call('onInterrupt', id), { disabled: pane.exited });
    item('Clear context (/clear)', () => call('onClear', id), { disabled: pane.exited });
    item(status === 'detached' ? 'Reattach' : 'Restart', () => call('onRestart', id));
    sep();
    item('End agent', () => call('onEnd', id), { danger: true, confirmKey: 'sv:end' });

    placeMenu(x, y);
  }

  // measure first, then place: a menu opened near an edge folds back inside
  function placeMenu(x, y) {
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    setStyle(menuEl, 'left', Math.max(6, Math.min(x, window.innerWidth - r.width - 8)) + 'px');
    setStyle(menuEl, 'top', Math.max(6, Math.min(y, window.innerHeight - r.height - 8)) + 'px');
  }

  /* ---- right-clicking empty map: start an agent there ----
   * "There" is the point of it: the map is laid out by workspace, so where you
   * click says which workspace you mean. Whatever hub or agent is nearest the
   * cursor wins, and the picker opens on it in case the guess is wrong. */

  let lastPlan = { hubs: [], nodes: [] };

  // a map position (canvas percent) as it currently sits on screen, zoom and
  // pan included — the click to compare against arrives in screen pixels
  function toScreen(x, y) {
    const r = canvasEl.getBoundingClientRect();
    return {
      x: r.left + panX + (x / 100) * r.width * zoom,
      y: r.top + panY + (y / 100) * r.height * zoom,
    };
  }

  function nearestWorkspace(cx, cy) {
    const marks = [];
    for (const hub of lastPlan.hubs) {
      if ((ctx.workspaces || []).some((w) => w.id === hub.key)) marks.push({ id: hub.key, x: hub.x, y: hub.y });
    }
    for (const node of lastPlan.nodes) marks.push({ id: node.pane.session.workspaceId, x: node.x, y: node.y });
    let best = null;
    let bestD = Infinity;
    for (const m of marks) {
      const p = toScreen(m.x, m.y);
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < bestD) { bestD = d; best = m.id; }
    }
    return best;
  }

  function openNewMenu(x, y) {
    const workspaces = ctx.workspaces || [];
    if (!workspaces.length) return;
    stopMenuMic(); // a second right-click re-opens the form; the old mic goes with it
    menuId = null;
    menuEl.textContent = '';

    const guess = nearestWorkspace(x, y) || workspaces[0].id;

    const head = document.createElement('div');
    head.className = 'sv-menu-head';
    const title = document.createElement('span');
    title.className = 'sv-menu-name';
    title.textContent = 'New agent';
    const where = document.createElement('span');
    where.className = 'sv-menu-ws';
    where.textContent = 'nearest workspace';
    head.append(title, where);

    const pick = document.createElement('select');
    pick.className = 'sv-menu-pick';
    for (const w of workspaces) {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name;
      pick.appendChild(opt);
    }
    pick.value = guess;

    const prompt = document.createElement('textarea');
    prompt.className = 'sv-menu-prompt';
    prompt.rows = 3;
    prompt.placeholder = 'first prompt — optional';
    prompt.spellcheck = false;

    // dictate the prompt instead of typing it — the same wiring the task-board
    // form uses, including re-snapshotting what was already in the box so a
    // recognized phrase appends rather than replaces
    const row = document.createElement('div');
    row.className = 'sv-menu-row';

    const mic = document.createElement('button');
    mic.type = 'button';
    mic.className = 'sv-menu-mic';
    mic.dataset.tip = 'Dictate the prompt (click to start/stop)';
    mic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>';

    const autoLabel = document.createElement('label');
    autoLabel.className = 'sv-menu-check';
    autoLabel.dataset.tip = 'End the agent as soon as it finishes its first turn';
    const autoBox = document.createElement('input');
    autoBox.type = 'checkbox';
    autoLabel.append(autoBox, document.createTextNode('auto-close once completed'));

    row.append(mic, autoLabel);

    let micBase = '';
    menuMic = window.Speech.wire(mic, {
      interim: true,
      onStart: () => {
        micBase = prompt.value;
        if (micBase && !/\s$/.test(micBase)) micBase += ' ';
      },
      onResult: (text, isFinal) => {
        prompt.value = micBase + text;
        if (isFinal) {
          micBase = prompt.value;
          if (!/\s$/.test(micBase)) micBase += ' ';
        }
      },
    });

    const launch = document.createElement('button');
    launch.className = 'sv-menu-item sv-menu-go';
    launch.textContent = 'Launch agent';

    const fire = () => {
      // read the form before closeMenu takes it down
      const workspaceId = pick.value;
      const text = prompt.value.trim();
      const autoClose = autoBox.checked;
      closeMenu();
      call('onNewAgentAt', workspaceId, text, autoClose);
    };
    launch.addEventListener('click', fire);
    // the app's own shortcuts listen on document — typing a prompt must not
    // trigger them, but Esc still has to reach the dismisser above
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return;
      e.stopPropagation();
      // modHeld (app.js — loaded before any event fires): Windows reports the
      // Windows key as metaKey, and Win+Enter must not launch an agent
      if (e.key === 'Enter' && modHeld(e)) fire();
    });

    const hint = document.createElement('div');
    hint.className = 'sv-menu-hint';
    hint.textContent = 'Ctrl+Enter to launch · leave the prompt empty for a bare agent';

    menuEl.append(head, pick, prompt, row, launch, hint);
    placeMenu(x, y);
    prompt.focus();
  }

  /* ---- viewport: zoom, text size, dock width ----
   * Three knobs that change how the view is *looked at* rather than what it
   * shows, so none of them touch the layout maths: the map is zoomed by
   * transforming the whole scene, the type is scaled by one custom property
   * the stylesheet sizes every content rule against, and the dock's width is
   * an inline style that outranks the stylesheet's. */

  function applyView() {
    setStyle(sceneEl, 'transform', `translate(${panX.toFixed(1)}px, ${panY.toFixed(1)}px) scale(${zoom.toFixed(3)})`);
    const untouched = Math.abs(zoom - 1) < 0.005 && !Math.round(panX) && !Math.round(panY);
    zoomEl.hidden = untouched;
    if (!untouched) setText(zoomEl, Math.round(zoom * 100) + '%');
    applyLean();
  }

  // zoom about a point, so whatever is under the cursor stays under it
  function zoomAt(cx, cy, factor) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    const k = next / zoom;
    if (k === 1) return;
    panX = cx - (cx - panX) * k;
    panY = cy - (cy - panY) * k;
    zoom = next;
    applyView();
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyView();
  }

  function applyFont() {
    setVar(el, '--sv-fs', String(fontScale));
    setVar(el, '--sv-fsm', String(mapFontScale));
    fontMinusEl.disabled = fontScale <= FONT_MIN + 0.001;
    fontPlusEl.disabled = fontScale >= FONT_MAX - 0.001;
    mapFontMinusEl.disabled = mapFontScale <= FONT_MIN + 0.001;
    mapFontPlusEl.disabled = mapFontScale >= FONT_MAX - 0.001;
  }

  function step(scale, dir) {
    const raw = dir > 0 ? scale * FONT_STEP : scale / FONT_STEP;
    return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(raw * 100) / 100));
  }

  function stepFont(dir) {
    const next = step(fontScale, dir);
    if (next === fontScale) return;
    fontScale = next;
    localStorage.setItem('swarmeye.svFont', String(fontScale));
    applyFont();
    applyPreviewSize(); // bigger type, fewer lines in the same card
  }

  function stepMapFont(dir) {
    const next = step(mapFontScale, dir);
    if (next === mapFontScale) return;
    mapFontScale = next;
    localStorage.setItem('swarmeye.svMapFont', String(mapFontScale));
    applyFont();
  }

  /* Clamp against the live body width rather than the stored one — a window
   * narrowed since the drag must not push the map out. Only ever writes on a
   * real change, so the resize observer this feeds back into settles. */
  let bodyWCache = 0; // invalidated by the ResizeObserver, like geoCache
  function applyDock() {
    if (dockW) {
      const total = bodyWCache || (bodyWCache = bodyEl.clientWidth);
      if (total) {
        const max = Math.max(DOCK_MIN, total - MAP_MIN);
        dockW = Math.round(Math.min(max, Math.max(DOCK_MIN, dockW)));
        setStyle(dockEl, 'width', dockW + 'px');
      }
    }
    applyPreviewSize();
  }

  /* A preview card holds a terminal, so a wider dock should give a taller
   * window, not just a wider one: the card keeps roughly a terminal's
   * proportions and the line count follows, both while dragging and after. */
  let dockWCache = 0; // invalidated by the ResizeObserver, like geoCache
  function applyPreviewSize() {
    // dockW (set by the drag / clamp above) already *is* the width — only the
    // CSS-default case needs a measurement, and that is cached
    const w = dockW || dockWCache || (dockWCache = dockEl.getBoundingClientRect().width);
    if (!w) return;
    const lineH = 1.55 * 11 * fontScale;
    const lines = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, Math.round(((w - 26) / PREVIEW_ASPECT) / lineH)));
    if (lines === previewLines) return;
    previewLines = lines;
    setVar(termsEl, '--sv-term-lines', String(lines));
  }

  /* ---- chrome ---- */

  function paintOptions() {
    for (const btn of layoutSegEl.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.layout === layout);
    }
    previewBtn.classList.toggle('active', showPreview);
    clickBtn.classList.toggle('active', clickMode === 'jump');
    clickBtn.textContent = clickMode === 'jump' ? '⤳ Click jumps' : '⤳ Click selects';
  }

  /* Hover focuses, click selects: resting on an agent highlights it in the dock
   * and opens its preview, but leaves the selection where it was. `reveal` is
   * for hovers that come from the map — the dock has to scroll to the agent,
   * whereas a card you are already pointing at is by definition in view.
   *
   * Only one agent's row and preview card change, so they are painted directly:
   * a full render() re-lays-out the whole map and re-reads every live agent's
   * terminal, and a sweep across the map fires two of those per node. */
  function paintHoverOn(id, on) {
    const row = rowEls.get(id);
    if (row) row.row.classList.toggle('sv-row-hot', on);
    const rec = termCards.get(id);
    if (!rec) return;
    const pane = ((ctx && ctx.panes) || []).find((p) => p.session.id === id);
    if (!pane) return;
    const flat = statusOf(pane) === 'idle' && !on;
    rec.card.classList.toggle('sv-term-open', on);
    rec.card.classList.toggle('sv-term-flat', flat);
    paintTermBody(rec, pane, on, flat);
  }

  function hover(id, reveal) {
    if (hoveredId === id) return;
    if (hoveredId) paintHoverOn(hoveredId, false); // a node and its card can overlap
    hoveredId = id;
    paintHoverOn(id, true);
    // dragging the map sweeps the cursor over nodes it isn't aiming at — the
    // dock yanking about mid-pan is worse than not following at all
    if (reveal && !canvasEl.classList.contains('sv-panning')) revealInDock(id);
  }

  function unhover(id) {
    if (hoveredId !== id) return;
    hoveredId = null;
    paintHoverOn(id, false);
  }

  function revealInDock(id) {
    const card = termCards.get(id);
    if (card) card.card.scrollIntoView({ block: 'nearest' });
    const row = rowEls.get(id);
    if (row) row.row.scrollIntoView({ block: 'nearest' });
  }

  function select(id) {
    selectedId = id;
    render(ctx);
    // the picked agent's preview may be well down the stack — only scroll on a
    // real selection, never from the one-second repaint
    const rec = termCards.get(id);
    if (rec) rec.card.scrollIntoView({ block: 'nearest' });
  }

  function render(next) {
    if (!next) return;
    ctx = next;
    if (el.hidden) return;

    applyDock(); // the dock's width can only be clamped while the view is laid out

    const panes = orderedPanes();
    if (!panes.some((p) => p.session.id === selectedId)) selectedId = panes.length ? panes[0].session.id : null;

    paintCounts();
    setText(agentsMetaEl, panes.length ? `${panes.length} shown` : '');

    const filtered = filter.size && ctx.panes.length;
    emptyEl.hidden = panes.length > 0;
    setText(emptyEl, filtered
      ? 'no ' + [...filter].join(' or ') + ' agents right now — the filter is in the header'
      : 'no agents running — right-click the map to start one');
    setText(rowsEmptyEl, filtered ? 'nothing matches the filter' : 'no agents yet — every workspace is quiet');

    const geo = geometry();
    const plan = panes.length
      ? (layout === 'ring' ? ringLayout(panes, geo) : clusterLayout(panes, geo))
      : { hubs: [], nodes: [] };
    lastPlan = plan; // what nearestWorkspace() measures the click against
    paintLinks(plan, geo);
    paintHubs(plan);
    paintNodes(plan);
    paintDensity(plan, geo);
    const docked = dockOrder(panes);
    paintPreviews(docked);
    paintRows(docked);
    paintOptions();
  }

  /* The map is a clock as much as a map — ages, urgency halos and the
   * preview's tail all move without any state change to react to. Ticking
   * only while the view is up keeps it free when it isn't. */
  function setActive(on) {
    clearInterval(tick);
    tick = null;
    closeMenu();
    if (on) tick = setInterval(() => render(ctx), 1000);
  }

  for (const btn of layoutSegEl.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      layout = btn.dataset.layout;
      localStorage.setItem('swarmeye.svLayout', layout);
      render(ctx);
    });
  }
  previewBtn.addEventListener('click', () => {
    showPreview = !showPreview;
    localStorage.setItem('swarmeye.svPreview', showPreview ? '1' : '0');
    render(ctx);
  });
  clickBtn.addEventListener('click', () => {
    clickMode = clickMode === 'jump' ? 'select' : 'jump';
    localStorage.setItem('swarmeye.svClick', clickMode);
    render(ctx);
  });

  fontMinusEl.addEventListener('click', () => stepFont(-1));
  fontPlusEl.addEventListener('click', () => stepFont(1));
  mapFontMinusEl.addEventListener('click', () => stepMapFont(-1));
  mapFontPlusEl.addEventListener('click', () => stepMapFont(1));

  /* Wheel over the map zooms it. Deltas are normalised because the same
   * gesture arrives in pixels from a trackpad and in lines from a mouse. */
  canvasEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeMenu();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvasEl.clientHeight : 1;
    const r = canvasEl.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * 0.0016));
  }, { passive: false });

  /* Drag anywhere on the map to pan it. The left button skips agent nodes and
   * the badge, which own their clicks; the middle button grabs from anywhere,
   * nodes included. preventDefault stops the browser starting a text selection
   * on the labels instead, which otherwise swallows the drag. */
  canvasEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0 && e.target.closest('.sv-node, #sv-zoom')) return;
    e.preventDefault();
    closeMenu();
    canvasEl.setPointerCapture(e.pointerId);
    canvasEl.classList.add('sv-panning');
    const startX = e.clientX - panX;
    const startY = e.clientY - panY;
    const onMove = (ev) => {
      panX = ev.clientX - startX;
      panY = ev.clientY - startY;
      applyView();
    };
    const onUp = () => {
      canvasEl.classList.remove('sv-panning');
      canvasEl.removeEventListener('pointermove', onMove);
      canvasEl.removeEventListener('pointerup', onUp);
      canvasEl.removeEventListener('pointercancel', onUp);
    };
    canvasEl.addEventListener('pointermove', onMove);
    canvasEl.addEventListener('pointerup', onUp);
    canvasEl.addEventListener('pointercancel', onUp);
  });

  canvasEl.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.sv-node')) resetView();
  });

  canvasEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.sv-node')) return; // its own menu, wired in wireAgentEl
    e.preventDefault();
    openNewMenu(e.clientX, e.clientY);
  });

  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
  });
  // capture, so Esc dismisses the menu instead of closing the whole view
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menuEl.hidden) return;
    e.stopPropagation();
    e.preventDefault();
    closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  zoomEl.addEventListener('click', resetView);

  // drag the dock's left edge to trade map width for dock width
  resizerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizerEl.setPointerCapture(e.pointerId);
    resizerEl.classList.add('dragging');
    const startX = e.clientX;
    const startW = dockEl.getBoundingClientRect().width;
    const onMove = (ev) => {
      dockW = startW - (ev.clientX - startX);
      applyDock(); // clamps dockW in place, so dragging back out doesn't lag
    };
    const onUp = () => {
      resizerEl.classList.remove('dragging');
      resizerEl.removeEventListener('pointermove', onMove);
      resizerEl.removeEventListener('pointerup', onUp);
      resizerEl.removeEventListener('pointercancel', onUp);
      if (dockW) localStorage.setItem('swarmeye.svDockW', String(dockW));
    };
    resizerEl.addEventListener('pointermove', onMove);
    resizerEl.addEventListener('pointerup', onUp);
    resizerEl.addEventListener('pointercancel', onUp);
  });

  applyFont();
  applyView();

  // orbits are sized against the canvas, so a resized window (or a toggled
  // preview card) has to re-place every node — and the cached measurements
  // above are only ever refreshed here
  const sizeObserver = new ResizeObserver(() => {
    geoCache = null;
    bodyWCache = 0;
    dockWCache = 0;
    if (!el.hidden) render(ctx);
  });
  sizeObserver.observe(canvasEl);
  sizeObserver.observe(bodyEl);

  return { render, setActive };
})();

window.SwarmView = SwarmView;
