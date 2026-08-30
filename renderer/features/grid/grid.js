/* GridController: two ways to arrange agent panes, plus drag-to-swap panes
 * (grab a pane header), per-workspace layout memory and per-pane maximize.
 * Exposes window.GridController.
 *
 * Auto-organize on: rows of panes with draggable fr-unit dividers. Each row is
 * its own nested grid, so a column divider only ever moves the two panes it
 * sits between — a single CSS grid shares its columns down the whole grid,
 * which made the right edge of one row drag the pane in the row below.
 *
 * Auto-organize off: a free canvas. Every pane owns a rectangle of its own,
 * kept as fractions of the grid so the arrangement scales with the window, and
 * resizing, moving or closing one pane never touches another. That is the only
 * way to get it: a grid track is shared by definition, so a pane growing past
 * its row always came out of the rows below. Gaps and overlaps are the price,
 * and they are the user's to arrange. */

/* how small a divider drag, or a pane's own resize handle, may squeeze what it
 * moves. A flat fr floor is worth a different number of pixels in every row —
 * 0.15fr of a two-pane row is ~120px, of a five-pane row ~48px — so a drag
 * stopped well short of what the window had room for. These are pixels, so a
 * pane can be dragged down to a sliver and back whatever it sits in. */
const MIN_COL_PX = 48;
const MIN_ROW_PX = 40;

const sameCounts = (a, b) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

export class GridController {
  constructor(container) {
    this.container = container;
    this.panes = [];
    this.colFr = [[1]]; // one array of pane widths per row
    this.rowFr = [1];
    this.tailColFr = [0]; // free space right of each row's last pane
    this.tailFr = 0; // free space under the last row, dragged out from the grid's bottom edge
    this.rowEls = [];
    // organizing manually, one {x, y, w, h} per pane, in fractions of the grid
    this.rects = [];
    this.frameEls = []; // manual mode: one resize frame per pane, laid over it
    this.counts = []; // panes per row, as last laid out
    this.shape = { cols: 1, rows: 1 };
    this.maximized = null;
    this.dragPane = null; // pane whose header is being dragged
    this.memoKey = null; // key (workspace id) of the current pane set
    this.memo = new Map(); // key -> {order, colFr, rowFr, counts, rects, ...}
    this.pendingLayout = null; // saved layout to restore on next relayout
    this.autoOrganize = true;
    this.gutter = 12; // px gap between panes; the whole track doubles as the resize handle
  }

  // 0 collapses panes flush together (still resizable via the zero-width track)
  setGutter(px) {
    if (px === this.gutter) return;
    this.gutter = px;
    if (this.panes.length) this.applyTemplate();
  }

  setAutoOrganize(auto) {
    if (auto === this.autoOrganize) return;
    this.autoOrganize = auto;
    // leaving auto-organize, every pane keeps the rectangle it has on screen,
    // so the layout doesn't jump the moment it becomes editable by hand
    if (!auto) this.seedRects();
    else this.evenTracks();
    this.relayout();
  }

  /* switching auto-organize back on is the user asking for the grid to be tidy
   * again: every pane gets an equal share of its row and of the window, and the
   * free space manual placement leaves behind — a closed pane's slot, a bottom
   * edge dragged up — goes back into the panes, so the grid fills the window.
   * The memo is evened out too, or switching workspace hands the dead space
   * straight back. */
  evenTracks() {
    const even = (m) => {
      m.colFr = m.colFr.map((fr) => fr.map(() => 1));
      m.rowFr = m.rowFr.map(() => 1);
      m.tailColFr = m.tailColFr.map(() => 0);
      m.tailFr = 0;
      m.rects = [];
    };
    even(this);
    if (this.pendingLayout) even(this.pendingLayout);
    for (const saved of this.memo.values()) even(saved);
  }

  // rows of `cols` panes each, last one holding the remainder
  denseRowCounts(n, cols) {
    const counts = [];
    for (let i = 0; i < n; i += cols) counts.push(Math.min(cols, n - i));
    return counts;
  }

  /* ---- the free canvas: one rectangle per pane ---- */

  // the grid's own box, which every rectangle is a fraction of
  box() { return this.container.getBoundingClientRect(); }

  // `px` along one axis as a fraction of the grid; 0 while it has no size
  frac(axis, px) {
    const b = this.box();
    const span = axis === 'col' ? b.width : b.height;
    return span > 0 ? px / span : 0;
  }

  // a rectangle keeps its size and is pulled back inside the canvas
  clampRect(r) {
    const w = Math.min(1, Math.max(this.frac('col', MIN_COL_PX), r.w));
    const h = Math.min(1, Math.max(this.frac('row', MIN_ROW_PX), r.h));
    return {
      x: Math.min(Math.max(0, r.x), 1 - w),
      y: Math.min(Math.max(0, r.y), 1 - h),
      w,
      h,
    };
  }

  /* where a pane goes when it arrives beside `ref`: snug against that edge and
   * the same size, out of the free space the canvas has there. Only when there
   * is none does `ref` give up half of its own rectangle — an arriving agent
   * has to come from somewhere, and taking it from the one pane the user
   * pointed at beats resizing the layout. `ref` is a live entry of `rects`, so
   * that half is taken by writing to it. */
  placeBeside(ref, dir) {
    const after = dir === 'right' || dir === 'down';
    const col = dir === 'right' || dir === 'left';
    const pos = col ? 'x' : 'y';
    const len = col ? 'w' : 'h';
    const gap = this.frac(col ? 'col' : 'row', this.gutter);
    const min = this.frac(col ? 'col' : 'row', col ? MIN_COL_PX : MIN_ROW_PX);
    const r = { ...ref };

    const room = after ? 1 - (ref[pos] + ref[len] + gap) : ref[pos] - gap;
    if (room >= min) {
      r[len] = Math.min(ref[len], room);
      r[pos] = after ? ref[pos] + ref[len] + gap : ref[pos] - gap - r[len];
      return this.clampRect(r);
    }
    const half = (ref[len] - gap) / 2;
    if (half < min) return this.clampRect(r); // nothing left to split: overlap
    r[len] = half;
    ref[len] = half;
    if (after) r[pos] = ref[pos] + half + gap;
    else ref[pos] = r[pos] + half + gap;
    return this.clampRect(r);
  }

  /* nothing on screen to measure (the grid is behind another view), or a pane
   * set the memo doesn't cover: even rows, the shape auto-organize would give */
  packRects() {
    const n = this.panes.length;
    const counts = this.denseRowCounts(n, Math.max(1, Math.ceil(Math.sqrt(n))));
    const gx = this.frac('col', this.gutter);
    const gy = this.frac('row', this.gutter);
    const h = (1 - gy * (counts.length - 1)) / counts.length;
    this.rects = [];
    counts.forEach((count, r) => {
      const w = (1 - gx * (count - 1)) / count;
      for (let c = 0; c < count; c++) {
        this.rects.push({ x: c * (w + gx), y: r * (h + gy), w, h });
      }
    });
  }

  // every pane keeps exactly the rectangle it occupies right now
  seedRects() {
    const b = this.box();
    if (!(b.width > 0) || !(b.height > 0)) { this.packRects(); return; }
    this.rects = this.panes.map((p) => {
      const r = p.el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: (r.left - b.left) / b.width,
        y: (r.top - b.top) / b.height,
        w: r.width / b.width,
        h: r.height / b.height,
      };
    });
    if (this.rects.some((r) => !r)) this.packRects();
  }

  // self-heal: one rectangle per pane, whatever moved panes without telling us
  fitRects() {
    if (this.rects.length === this.panes.length && this.rects.every(Boolean)) return;
    const known = this.rects;
    this.packRects();
    known.forEach((r, i) => { if (r && i < this.rects.length) this.rects[i] = r; });
  }

  // index positions the new pane in row-major order (e.g. right after another
  // pane); omitted/out-of-range means "append at the end". `rect` is the slot
  // insertSplit has already worked out on the free canvas.
  add(pane, index, rect) {
    // pane count must change before setMaximized(null)'s relayout() runs, or
    // that relayout sees a stale count and repacks the canvas underneath a
    // rectangle that was already placed correctly
    const at = index == null || index < 0 || index >= this.panes.length
      ? this.panes.length
      : index;
    if (!this.autoOrganize) {
      // an agent that arrives without a → / ↓ of its own goes to the right of
      // the one before it
      const ref = this.rects[at - 1] || this.rects[at];
      this.rects.splice(at, 0,
        rect || (ref ? this.placeBeside(ref, 'right') : { x: 0, y: 0, w: 1, h: 1 }));
    }
    this.panes.splice(at, 0, pane);
    this.setMaximized(null); // a new agent must always become visible
    this.wireDrag(pane);
    this.relayout();
  }

  // places a new pane relative to refPane — 'right' beside it, 'down' under it.
  // Auto mode resquares every relayout, so direction there only nudges order.
  insertSplit(pane, refPane, direction) {
    const i = this.panes.indexOf(refPane);
    if (i === -1) { this.add(pane); return; }
    if (this.autoOrganize) {
      this.add(pane, direction === 'down' ? i + this.shape.cols : i + 1);
      return;
    }
    this.add(pane, i + 1, this.placeBeside(this.rects[i], direction === 'down' ? 'down' : 'right'));
  }

  /* remember the current arrangement (pane order + track sizes) so it
   * survives switching to another workspace and back */
  saveLayout() {
    // null is a key like any other: it is the view with no workspace selected,
    // which is where the app starts and where most agents are opened
    if (!this.panes.length) return;
    this.memo.set(this.memoKey, {
      order: this.panes.map((p) => p.session.id),
      colFr: this.colFr.map((fr) => [...fr]),
      rowFr: [...this.rowFr],
      tailColFr: [...this.tailColFr],
      tailFr: this.tailFr,
      counts: [...this.counts],
      rects: this.rects.map((r) => (r ? { ...r } : null)),
    });
  }

  /* show a different set of panes (workspace switch) without disposing
   * the ones going off-screen — their terminals keep running hidden */
  setPanes(panes, key) {
    this.saveLayout();
    if (key !== undefined) this.memoKey = key;
    for (const p of this.panes) p.el.remove();

    const saved = this.memo.get(this.memoKey);
    const list = [...panes];
    if (saved) {
      const pos = new Map(saved.order.map((id, i) => [id, i]));
      list.sort((a, b) =>
        (pos.get(a.session.id) ?? Infinity) - (pos.get(b.session.id) ?? Infinity));
    }
    this.panes = list;
    this.pendingLayout = saved || null;
    if (this.maximized && !this.panes.includes(this.maximized)) this.setMaximized(null);
    for (const p of this.panes) this.wireDrag(p);
    // the rectangles this pane set was last laid out with, so a workspace
    // switch — or the syncGrid() that follows every close — hands the canvas
    // back exactly as the user built it. Only a set the memo doesn't cover
    // (crew panes hidden, agents started elsewhere) falls back to packing.
    if (!this.autoOrganize) {
      const byId = new Map();
      if (saved?.rects) saved.order.forEach((id, i) => { if (saved.rects[i]) byId.set(id, saved.rects[i]); });
      this.packRects();
      this.panes.forEach((p, i) => {
        const r = byId.get(p.session.id);
        if (r) this.rects[i] = { ...r };
      });
    }
    this.relayout();
  }

  remove(pane) {
    const i = this.panes.indexOf(pane);
    if (i !== -1) {
      if (this.autoOrganize) {
        const p = this.posOf(i);
        this.colFr[p.row]?.splice(p.col, 1);
      } else {
        // the canvas keeps the hole: every pane that stays is exactly where the
        // user put it, which is the whole point of arranging it by hand
        this.rects.splice(i, 1);
      }
    }
    this.panes = this.panes.filter((p) => p !== pane);
    if (this.maximized === pane) this.setMaximized(null);
    try { pane.dispose(); } catch { pane.el.remove(); }
    this.relayout();
  }

  /* swap a pane for a new one in the same grid slot (used by restart) */
  replace(oldPane, newPane) {
    const i = this.panes.indexOf(oldPane);
    // the old pane isn't on screen: it belongs to another workspace, so the
    // new one must not be appended into the grid this one is showing. Dispose
    // the old (nothing else will — its terminal, WebGL context, observer and
    // timers would leak) and leave the new pane to the next syncGrid(), which
    // mounts it from state.panes when its workspace is selected.
    if (i === -1) { try { oldPane.dispose(); } catch { /* already gone */ } return; }
    const wasMax = this.maximized === oldPane;
    this.panes[i] = newPane;
    oldPane.el.replaceWith(newPane.el);
    try { oldPane.dispose(); } catch { /* already out of the DOM */ }
    this.wireDrag(newPane);
    if (wasMax) this.setMaximized(newPane);
    this.relayout();
  }

  toggleMax(pane) {
    if (this.panes.length < 2) {
      this.setMaximized(null); // maximizing a lone pane is a no-op, don't latch the mode
      return;
    }
    this.setMaximized(this.maximized === pane ? null : pane);
  }

  setMaximized(pane) {
    if (this.maximized) this.maximized.el.classList.remove('maximized');
    this.maximized = pane;
    if (pane) {
      // out of its row and into the grid itself: the row it lived in is one of
      // the row tracks max-mode hides, and its inline placement — a grid area
      // organizing automatically, a rectangle on the free canvas — would
      // outrank the rule that gives this pane the whole grid
      this.clearPlacement(pane.el);
      this.container.appendChild(pane.el);
      pane.el.classList.add('maximized');
      this.container.classList.add('max-mode');
    } else {
      this.container.classList.remove('max-mode');
      this.relayout(); // puts the pane back where it was, tracks and all
    }
  }

  // everything either layout writes on a pane's own style attribute
  clearPlacement(el) {
    for (const k of ['gridRow', 'gridColumn', 'position', 'left', 'top', 'width', 'height', 'alignSelf']) {
      el.style[k] = '';
    }
  }

  // a row's own columns: [pane, gutter, pane, ... , gutter, free space]
  rowTemplate(r) {
    const gutter = `${this.gutter}px`;
    return this.colFr[r].map((f) => f + 'fr').join(` ${gutter} `) + ` ${gutter} ${this.tailColFr[r]}fr`;
  }

  applyTemplate() {
    if (!this.autoOrganize) { this.applyRects(); return; }
    const gutter = `${this.gutter}px`;
    // one extra gutter + track past the last row and past each row's last
    // pane: panes side by side have no divider between rows to drag, and a
    // single column of them none between columns, so each far edge is a handle
    // too and what it drags out is empty space
    this.container.style.gridTemplateColumns = '1fr';
    this.container.style.gridTemplateRows =
      this.rowFr.map((f) => f + 'fr').join(` ${gutter} `) + ` ${gutter} ${this.tailFr}fr`;
    this.rowEls.forEach((el, r) => { el.style.gridTemplateColumns = this.rowTemplate(r); });
  }

  // free canvas: each pane, and the frame carrying its handles, sits where its
  // own rectangle says and nowhere else
  applyRects() {
    this.panes.forEach((p, i) => {
      const r = this.rects[i];
      if (!r || p === this.maximized) return;
      const at = {
        left: `${r.x * 100}%`,
        top: `${r.y * 100}%`,
        width: `${r.w * 100}%`,
        height: `${r.h * 100}%`,
      };
      Object.assign(p.el.style, at, { position: 'absolute' });
      const frame = this.frameEls[i];
      if (frame) Object.assign(frame.style, at);
    });
  }

  /* keep one width per pane and one height per row, padding anything new with
   * a full share and dropping what the layout no longer has */
  fitTracks(counts) {
    this.rowFr = counts.map((_, r) => this.rowFr[r] ?? 1);
    this.tailColFr = counts.map((_, r) => this.tailColFr[r] ?? 0);
    this.colFr = counts.map((count, r) => {
      const fr = this.colFr[r] ? [...this.colFr[r]] : [];
      while (fr.length < count) fr.push(1);
      fr.length = count;
      return fr;
    });
  }

  relayout() {
    const n = this.panes.length;
    this.container.querySelectorAll('.gutter, .pane-frame').forEach((g) => g.remove());
    this.frameEls = [];
    if (n === 0) {
      this.rowEls.forEach((el) => el.remove());
      this.rowEls = [];
      this.counts = [];
      this.container.classList.remove('single', 'free');
      this.container.style.gridTemplateColumns = '';
      this.container.style.gridTemplateRows = '';
      return;
    }
    this.container.classList.toggle('single', n === 1);
    if (!this.autoOrganize) { this.relayoutFree(); return; }

    this.container.classList.remove('free');
    const counts = this.denseRowCounts(n, Math.max(1, Math.ceil(Math.sqrt(n))));

    const saved = this.pendingLayout;
    this.pendingLayout = null;
    if (saved && sameCounts(saved.counts, counts)) {
      this.colFr = saved.colFr.map((fr) => [...fr]);
      this.rowFr = [...saved.rowFr];
      this.tailColFr = [...saved.tailColFr];
      this.tailFr = saved.tailFr || 0;
    }
    this.fitTracks(counts);
    this.counts = counts;
    this.shape = { cols: Math.max(1, ...counts), rows: counts.length };

    // rows are grid tracks of the container, panes grid tracks of their row;
    // tracks are [pane, gutter, pane, ...], so slot k lives at line k*2+1
    let i = 0;
    counts.forEach((count, r) => {
      let row = this.rowEls[r];
      if (!row) {
        row = document.createElement('div');
        row.className = 'grid-row';
        this.rowEls[r] = row;
      }
      if (row.parentElement !== this.container) this.container.appendChild(row);
      row.style.gridRow = `${r * 2 + 1} / ${r * 2 + 2}`;
      row.style.gridColumn = '1 / 2';
      for (let c = 0; c < count; c++, i++) {
        const pane = this.panes[i];
        this.clearPlacement(pane.el); // the canvas may have left a rectangle on it
        pane.el.style.gridRow = '1 / 2';
        pane.el.style.gridColumn = `${c * 2 + 1} / ${c * 2 + 2}`;
        // only ever re-parent a pane that really moved: re-appending one
        // rebuilds its terminal's WebGL context for nothing
        if (pane.el.parentElement !== row && pane !== this.maximized) row.appendChild(pane.el);
        this.makeGutter('col', r, c);
      }
    });
    this.rowEls.slice(counts.length).forEach((el) => el.remove());
    this.rowEls.length = counts.length;

    // the last gutter on each axis is the grid's own edge, not a divider
    for (let r = 0; r < counts.length; r++) this.makeGutter('row', r, r);
    this.applyTemplate();
  }

  /* the free canvas has no rows: the panes are positioned children of the grid
   * itself, each carrying its own resize frame */
  relayoutFree() {
    this.pendingLayout = null; // the rectangles came from the memo in setPanes
    this.rowEls.forEach((el) => el.remove());
    this.rowEls = [];
    this.counts = [];
    this.shape = { cols: this.panes.length, rows: 1 };
    this.container.classList.add('free');
    this.container.style.gridTemplateColumns = '';
    this.container.style.gridTemplateRows = '';
    this.fitRects();
    this.panes.forEach((pane, i) => {
      if (pane.el.parentElement !== this.container && pane !== this.maximized) {
        this.container.appendChild(pane.el);
      }
      this.makeFrame(i);
    });
    this.applyRects();
  }

  /* ---- drag a pane header onto another pane: its middle swaps the two, an
   * edge moves the dragged pane to that side of the target ---- */

  // which quarter of `pane` the pointer is over — the outer fifth of each edge
  // moves, the middle swaps
  dropZone(pane, e) {
    const r = pane.el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edges = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
    const [zone, d] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
    return d < 0.2 ? zone : 'swap';
  }

  clearDropMarks() {
    this.container.querySelectorAll('.pane.drop-target').forEach((el) => {
      el.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-up', 'drop-down');
    });
  }

  /* move `src` next to `target` instead of swapping with it — how a column of
   * panes becomes a row. Auto-organize computes the shape itself, so there a
   * drop can only reorder; on the free canvas the dragged pane takes a
   * rectangle beside the target and the target itself is not touched. */
  movePane(src, target, zone) {
    if (src === target) return;
    const from = this.panes.indexOf(src);
    if (from === -1 || this.panes.indexOf(target) === -1) return;

    if (this.autoOrganize) {
      this.panes.splice(from, 1);
      const to = this.panes.indexOf(target);
      this.panes.splice(zone === 'left' || zone === 'up' ? to : to + 1, 0, src);
    } else {
      const rect = this.placeBeside(this.rects[this.panes.indexOf(target)], zone);
      this.panes.splice(from, 1);
      this.rects.splice(from, 1);
      const to = this.panes.indexOf(target);
      const at = zone === 'left' || zone === 'up' ? to : to + 1;
      this.panes.splice(at, 0, src);
      this.rects.splice(at, 0, rect);
    }
    this.relayout();
    this.saveLayout();
    requestAnimationFrame(() => this.panes.forEach((p) => p.refit()));
  }

  wireDrag(pane) {
    if (pane.dragWired) return;
    pane.dragWired = true;
    const header = pane.el.querySelector('.pane-header');
    if (!header) return;
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      // controls keep their click behavior; a maximized pane has no slot to swap
      if (this.maximized || e.target.closest('button, select, input') || e.target.isContentEditable) {
        e.preventDefault();
        return;
      }
      this.dragPane = pane;
      e.dataTransfer.setData('text/swarmeye-pane', pane.session.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => pane.el.classList.add('drag-src'));
    });
    header.addEventListener('dragend', () => {
      this.dragPane = null;
      pane.el.classList.remove('drag-src');
      this.clearDropMarks();
    });
    pane.el.addEventListener('dragover', (e) => {
      if (!this.dragPane || this.dragPane === pane) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const zone = this.dropZone(pane, e);
      pane.el.classList.remove('drop-left', 'drop-right', 'drop-up', 'drop-down');
      pane.el.classList.add('drop-target');
      if (zone !== 'swap') pane.el.classList.add('drop-' + zone);
    });
    pane.el.addEventListener('dragleave', () => {
      pane.el.classList.remove('drop-target', 'drop-left', 'drop-right', 'drop-up', 'drop-down');
    });
    pane.el.addEventListener('drop', (e) => {
      const zone = this.dropZone(pane, e);
      this.clearDropMarks();
      const src = this.dragPane;
      this.dragPane = null;
      if (!src || src === pane) return;
      e.preventDefault();
      if (zone === 'swap') this.swap(src, pane);
      else this.movePane(src, pane, zone);
    });
  }

  // where the pane at `index` sits in the auto-organized grid
  posOf(index) {
    const cols = Math.max(1, this.shape.cols);
    return { row: Math.floor(index / cols), col: index % cols };
  }

  swap(a, b) {
    const i = this.panes.indexOf(a);
    const j = this.panes.indexOf(b);
    if (i === -1 || j === -1) return;
    // each pane keeps its own size: the sizes travel with the slots
    if (this.autoOrganize) {
      const pa = this.posOf(i);
      const pb = this.posOf(j);
      const wa = this.colFr[pa.row]?.[pa.col];
      const wb = this.colFr[pb.row]?.[pb.col];
      if (wa != null && wb != null) {
        this.colFr[pa.row][pa.col] = wb;
        this.colFr[pb.row][pb.col] = wa;
      }
      if (this.rowFr[pa.row] != null && this.rowFr[pb.row] != null) {
        [this.rowFr[pa.row], this.rowFr[pb.row]] = [this.rowFr[pb.row], this.rowFr[pa.row]];
      }
    } else {
      [this.rects[i], this.rects[j]] = [this.rects[j], this.rects[i]];
    }
    this.panes[i] = b;
    this.panes[j] = a;
    this.relayout(); // same pane count → the shape, and so the tracks, hold
    this.saveLayout();
    requestAnimationFrame(() => { a.refit(); b.refit(); });
  }

  // column gutters belong to their row, row gutters to the grid itself
  makeGutter(axis, row, index) {
    const g = document.createElement('div');
    g.className = 'gutter ' + (axis === 'col' ? 'gutter-v' : 'gutter-h');
    if (axis === 'col') {
      g.style.gridColumn = `${index * 2 + 2} / ${index * 2 + 3}`;
      g.style.gridRow = '1 / 2';
      this.rowEls[row].appendChild(g);
    } else {
      g.style.gridRow = `${index * 2 + 2} / ${index * 2 + 3}`;
      g.style.gridColumn = '1 / 2';
      this.container.appendChild(g);
    }
    g.addEventListener('pointerdown', (e) => this.startDrag(e, g, axis, row, index));
  }

  /* one pane's resize handles — all four edges and all four corners — on a
   * frame laid over that pane rather than inside it, so nothing the pane draws
   * has to make room for them and the pane itself stays a plain box. The frame
   * takes no pointer events; only the strips do, and they straddle the pane's
   * edge so there is still something to grab with the pane gap turned off. */
  makeFrame(i) {
    const frame = document.createElement('div');
    frame.className = 'pane-frame';
    for (const dir of ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']) {
      const h = document.createElement('div');
      h.className = 'pane-handle handle-' + dir;
      h.addEventListener('pointerdown', (e) => this.startResize(e, h, i, dir));
      frame.appendChild(h);
    }
    this.container.appendChild(frame);
    this.frameEls[i] = frame;
  }

  /* drag any of one pane's edges or corners. It changes that pane's rectangle
   * and nothing else — no track is shared with any other pane, so none of them
   * moves or resizes. The pane stops at the canvas edge and at the pixel
   * floor; free space beside it, and any pane sitting in that space, are
   * simply grown over. A left or top edge moves the pane's own origin, so the
   * opposite edge stays where it is. */
  startResize(e, handle, i, dir) {
    e.preventDefault();
    const pane = this.panes[i];
    const start = this.rects[i];
    if (!pane || !start) return;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');

    const b = this.box();
    const minW = this.frac('col', MIN_COL_PX);
    const minH = this.frac('row', MIN_ROW_PX);
    const x0 = e.clientX;
    const y0 = e.clientY;

    const onMove = (ev) => {
      const r = { ...start };
      if (dir.includes('e') && b.width > 0) {
        r.w = Math.min(1 - start.x, Math.max(minW, start.w + (ev.clientX - x0) / b.width));
      }
      if (dir.includes('w') && b.width > 0) {
        // the right edge is fixed, so what the drag sets is the left one
        const right = start.x + start.w;
        r.x = Math.min(right - minW, Math.max(0, start.x + (ev.clientX - x0) / b.width));
        r.w = right - r.x;
      }
      if (dir.includes('s') && b.height > 0) {
        r.h = Math.min(1 - start.y, Math.max(minH, start.h + (ev.clientY - y0) / b.height));
      }
      if (dir.includes('n') && b.height > 0) {
        const bottom = start.y + start.h;
        r.y = Math.min(bottom - minH, Math.max(0, start.y + (ev.clientY - y0) / b.height));
        r.h = bottom - r.y;
      }
      this.rects[i] = r;
      this.applyRects();
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      this.saveLayout();
      requestAnimationFrame(() => pane.refit());
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  /* Drag a divider. What it moves is the track on its left (above it): the
   * pane grows over everything on the other side of the divider in turn — the
   * free space at that edge first, then each track beyond it, each stopping at
   * the pixel floor — rather than only over its one neighbour. That is the
   * difference between a pane that can be dragged out to fill its row and one
   * that stops at whatever share the pane beside it happened to hold. */
  startDrag(e, gutter, axis, row, index) {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');

    const fr = axis === 'col' ? this.colFr[row] : this.rowFr;
    const tailFr = axis === 'col' ? this.tailColFr[row] : this.tailFr;
    const rect = (axis === 'col' ? this.rowEls[row] : this.container).getBoundingClientRect();
    const span = axis === 'col' ? rect.width : rect.height;
    const frSum = fr.reduce((a, b) => a + b, 0) + tailFr;
    // the pixel floor in this row's own fr units. A track already thinner than
    // the floor is left alone rather than pushed back up to it
    const px = axis === 'col' ? MIN_COL_PX : MIN_ROW_PX;
    const minFr = span > 0 && frSum > 0 ? (px / span) * frSum : 0;

    const start = [...fr];
    const startTail = tailFr;
    const startA = start[index];
    // how far this pane can still be dragged out: the free space at that edge,
    // plus what every track past the divider can give up before its own floor
    const room = startTail + start.slice(index + 1)
      .reduce((sum, f) => sum + Math.max(0, f - minFr), 0);
    const floorA = Math.min(minFr, startA);
    const setTail = (v) => {
      if (axis === 'col') this.tailColFr[row] = v; else this.tailFr = v;
    };
    const startPos = axis === 'col' ? e.clientX : e.clientY;

    const onMove = (ev) => {
      const pos = axis === 'col' ? ev.clientX : ev.clientY;
      const deltaFr = span > 0 ? ((pos - startPos) / span) * frSum : 0;
      const a = Math.min(Math.max(startA + deltaFr, floorA), startA + room);
      fr[index] = a;
      let need = a - startA;
      if (need >= 0) {
        // growing: spend the free space at the edge before squeezing anything,
        // then take from each track past the divider, nearest one first
        const fromTail = Math.min(need, startTail);
        setTail(startTail - fromTail);
        need -= fromTail;
        for (let k = index + 1; k < fr.length; k++) {
          const give = Math.min(need, Math.max(0, start[k] - minFr));
          fr[k] = start[k] - give;
          need -= give;
        }
      } else {
        // shrinking: the room goes to the one track on the other side of the
        // divider (the free space, if the divider is the grid's own edge), so
        // dragging back the way you came retraces the sizes you came from
        for (let k = index + 1; k < fr.length; k++) fr[k] = start[k];
        if (index + 1 < fr.length) { setTail(startTail); fr[index + 1] = start[index + 1] - need; }
        else setTail(startTail - need);
      }
      this.applyTemplate();
    };
    const onUp = () => {
      gutter.classList.remove('dragging');
      gutter.removeEventListener('pointermove', onMove);
      gutter.removeEventListener('pointerup', onUp);
      gutter.removeEventListener('pointercancel', onUp);
      this.saveLayout();
    };
    gutter.addEventListener('pointermove', onMove);
    gutter.addEventListener('pointerup', onUp);
    gutter.addEventListener('pointercancel', onUp);
  }
}
