/* GridController: auto-arranged CSS grid with draggable fr-unit dividers,
 * drag-to-swap panes (grab a pane header), per-workspace layout memory,
 * and per-pane maximize. Exposes window.GridController. */

const MIN_FR = 0.15;

class GridController {
  constructor(container) {
    this.container = container;
    this.panes = [];
    this.colFr = [1];
    this.rowFr = [1];
    this.shape = { cols: 1, rows: 1 };
    this.maximized = null;
    this.dragPane = null; // pane whose header is being dragged
    this.memoKey = null; // key (workspace id) of the current pane set
    this.memo = new Map(); // key -> {order, colFr, rowFr, cols, rows}
    this.pendingLayout = null; // saved layout to restore on next relayout
    this.autoOrganize = true; // off: column count is fixed at manualCols, not resquared every relayout
    this.manualCols = 1;
    this.rowCounts = []; // manual mode only: explicit panes-per-row, so a row that isn't full
    // (e.g. a lone trailing pane) stays put instead of being silently re-packed on the next insert
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
    if (!auto) {
      this.manualCols = this.shape.cols || 1; // carry over the current layout instead of collapsing it
      this.rowCounts = this.denseRowCounts(this.panes.length, this.manualCols); // matches the auto layout we just left
    }
    this.shape = { cols: 0, rows: 0 }; // force relayout to recompute tracks
    this.relayout();
  }

  // rows of `cols` panes each, last one holding the remainder — the packing
  // auto mode always uses, and manual mode's starting point / self-heal fallback
  denseRowCounts(n, cols) {
    const counts = [];
    for (let i = 0; i < n; i += cols) counts.push(Math.min(cols, n - i));
    return counts;
  }

  // manual mode only: re-derive rowCounts if something (a plain add(), a
  // workspace switch) moved panes without updating it
  syncRowCounts() {
    if (this.rowCounts.reduce((a, b) => a + b, 0) !== this.panes.length) {
      this.rowCounts = this.denseRowCounts(this.panes.length, Math.max(1, this.manualCols));
    }
  }

  // index positions the new pane in row-major order (e.g. right after another
  // pane, or a row below it); omitted/out-of-range means "append at the end"
  add(pane, index) {
    // pane count must change before setMaximized(null)'s relayout() runs, or
    // that relayout sees a stale count and "self-heals" rowCounts right back
    // out from under an insertSplit that already set them correctly
    if (index == null || index < 0 || index >= this.panes.length) this.panes.push(pane);
    else this.panes.splice(index, 0, pane);
    this.setMaximized(null); // a new agent must always become visible
    this.container.appendChild(pane.el);
    this.wireDrag(pane);
    this.relayout();
  }

  // places a new pane relative to refPane — 'right' extends its row (growing
  // manualCols when organizing manually), 'down' lands a genuinely new row
  // right after refPane's row (rowCounts remembers that boundary even when
  // refPane's own row isn't full). Auto mode still resquares every relayout,
  // so direction there only nudges order.
  insertSplit(pane, refPane, direction) {
    const i = this.panes.indexOf(refPane);
    if (i === -1) { this.add(pane); return; }
    if (this.autoOrganize) {
      this.add(pane, direction === 'down' ? i + this.shape.cols : i + 1);
      return;
    }
    this.syncRowCounts();
    let row = 0, start = 0;
    while (start + this.rowCounts[row] <= i) { start += this.rowCounts[row]; row++; }
    let index;
    if (direction === 'right') {
      this.rowCounts[row] += 1;
      this.manualCols = Math.max(this.manualCols, this.rowCounts[row]);
      index = i + 1;
    } else {
      index = start + this.rowCounts[row]; // first slot of a brand-new row after refPane's row
      this.rowCounts.splice(row + 1, 0, 1);
    }
    this.add(pane, index);
  }

  /* remember the current arrangement (pane order + track sizes) so it
   * survives switching to another workspace and back */
  saveLayout() {
    if (this.memoKey == null || !this.panes.length) return;
    this.memo.set(this.memoKey, {
      order: this.panes.map((p) => p.session.id),
      colFr: [...this.colFr],
      rowFr: [...this.rowFr],
      cols: this.shape.cols,
      rows: this.shape.rows,
    });
  }

  /* show a different set of panes (workspace switch) without disposing
   * the ones going off-screen — their terminals keep running hidden */
  setPanes(panes, key) {
    this.saveLayout();
    if (key !== undefined) this.memoKey = key;
    this.container.querySelectorAll('.gutter').forEach((g) => g.remove());
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
    for (const p of this.panes) {
      this.container.appendChild(p.el);
      this.wireDrag(p);
    }
    // a different pane set invalidates any remembered row boundaries
    if (!this.autoOrganize) this.rowCounts = this.denseRowCounts(this.panes.length, Math.max(1, this.manualCols));
    this.shape = { cols: 0, rows: 0 }; // force fresh track sizes
    this.relayout();
  }

  remove(pane) {
    if (!this.autoOrganize) {
      this.syncRowCounts();
      const i = this.panes.indexOf(pane);
      if (i !== -1) {
        let row = 0, start = 0;
        while (start + this.rowCounts[row] <= i) { start += this.rowCounts[row]; row++; }
        this.rowCounts[row] -= 1;
        if (this.rowCounts[row] === 0) this.rowCounts.splice(row, 1);
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
    if (i === -1) { this.add(newPane); return; }
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
      // an inline gridRow/gridColumn from the last relayout() would otherwise
      // outrank the CSS grid-area rule that puts this pane in the sole track
      pane.el.style.gridRow = '';
      pane.el.style.gridColumn = '';
      pane.el.classList.add('maximized');
      this.container.classList.add('max-mode');
    } else {
      this.container.classList.remove('max-mode');
      this.relayout(); // reassign grid positions now that the real track layout is back
    }
  }

  applyTemplate() {
    const gutter = `${this.gutter}px`;
    this.container.style.gridTemplateColumns = this.colFr.map((f) => f + 'fr').join(` ${gutter} `);
    this.container.style.gridTemplateRows = this.rowFr.map((f) => f + 'fr').join(` ${gutter} `);
  }

  relayout() {
    const n = this.panes.length;
    this.container.querySelectorAll('.gutter').forEach((g) => g.remove());
    if (n === 0) {
      this.container.style.gridTemplateColumns = '';
      this.container.style.gridTemplateRows = '';
      return;
    }

    const cols = this.autoOrganize ? Math.max(1, Math.ceil(Math.sqrt(n))) : Math.max(1, this.manualCols);
    if (!this.autoOrganize) this.syncRowCounts();
    const rows = this.autoOrganize ? Math.max(1, Math.ceil(n / cols)) : this.rowCounts.length;
    const shape = { cols, rows };
    if (shape.cols !== this.shape.cols || shape.rows !== this.shape.rows) {
      const saved = this.pendingLayout;
      if (saved && saved.cols === shape.cols && saved.rows === shape.rows
          && saved.colFr.length === shape.cols && saved.rowFr.length === shape.rows) {
        this.colFr = [...saved.colFr];
        this.rowFr = [...saved.rowFr];
      } else {
        this.colFr = Array(shape.cols).fill(1);
        this.rowFr = Array(shape.rows).fill(1);
      }
      this.shape = shape;
    }
    this.pendingLayout = null;
    this.applyTemplate();

    // place panes row-major; tracks are [pane, gutter, pane, ...] so cell
    // (r, c) lives at grid line r*2+1 / c*2+1
    if (this.autoOrganize) {
      this.panes.forEach((pane, i) => {
        const r = Math.floor(i / shape.cols);
        const c = i % shape.cols;
        const isLast = i === n - 1;
        pane.el.style.gridRow = `${r * 2 + 1} / ${r * 2 + 2}`;
        pane.el.style.gridColumn = isLast
          ? `${c * 2 + 1} / -1` // last pane stretches over any empty trailing cells
          : `${c * 2 + 1} / ${c * 2 + 2}`;
      });
    } else {
      // manual mode: rowCounts is the source of truth for row boundaries, so a
      // row a user placed a single pane in (via ↓) stays its own row instead
      // of being folded back into a "wherever it fits" dense pack
      let i = 0;
      this.rowCounts.forEach((count, r) => {
        for (let c = 0; c < count; c++, i++) {
          const pane = this.panes[i];
          const isLastInRow = c === count - 1;
          pane.el.style.gridRow = `${r * 2 + 1} / ${r * 2 + 2}`;
          pane.el.style.gridColumn = isLastInRow
            ? `${c * 2 + 1} / -1` // last pane in the row stretches over any empty trailing cells
            : `${c * 2 + 1} / ${c * 2 + 2}`;
        }
      });
    }

    for (let c = 0; c < shape.cols - 1; c++) this.makeGutter('col', c);
    for (let r = 0; r < shape.rows - 1; r++) this.makeGutter('row', r);
  }

  /* ---- drag a pane header onto another pane to swap their slots ---- */

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
      this.container.querySelectorAll('.pane.drop-target')
        .forEach((el) => el.classList.remove('drop-target'));
    });
    pane.el.addEventListener('dragover', (e) => {
      if (!this.dragPane || this.dragPane === pane) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      pane.el.classList.add('drop-target');
    });
    pane.el.addEventListener('dragleave', () => pane.el.classList.remove('drop-target'));
    pane.el.addEventListener('drop', (e) => {
      pane.el.classList.remove('drop-target');
      const src = this.dragPane;
      this.dragPane = null;
      if (!src || src === pane) return;
      e.preventDefault();
      this.swap(src, pane);
    });
  }

  swap(a, b) {
    const i = this.panes.indexOf(a);
    const j = this.panes.indexOf(b);
    if (i === -1 || j === -1) return;
    this.panes[i] = b;
    this.panes[j] = a;
    this.relayout(); // same pane count → track sizes are untouched
    this.saveLayout();
    requestAnimationFrame(() => { a.refit(); b.refit(); });
  }

  makeGutter(axis, index) {
    const g = document.createElement('div');
    g.className = 'gutter ' + (axis === 'col' ? 'gutter-v' : 'gutter-h');
    if (axis === 'col') {
      g.style.gridColumn = `${index * 2 + 2} / ${index * 2 + 3}`;
      g.style.gridRow = '1 / -1';
    } else {
      g.style.gridRow = `${index * 2 + 2} / ${index * 2 + 3}`;
      g.style.gridColumn = '1 / -1';
    }
    g.addEventListener('pointerdown', (e) => this.startDrag(e, g, axis, index));
    this.container.appendChild(g);
  }

  startDrag(e, gutter, axis, index) {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');

    const fr = axis === 'col' ? this.colFr : this.rowFr;
    const startA = fr[index];
    const startB = fr[index + 1];
    const total = startA + startB;
    const rect = this.container.getBoundingClientRect();
    const span = axis === 'col' ? rect.width : rect.height;
    const frSum = fr.reduce((a, b) => a + b, 0);
    const startPos = axis === 'col' ? e.clientX : e.clientY;

    const onMove = (ev) => {
      const pos = axis === 'col' ? ev.clientX : ev.clientY;
      const deltaFr = ((pos - startPos) / span) * frSum;
      let a = startA + deltaFr;
      let b = startB - deltaFr;
      if (a < MIN_FR) { a = MIN_FR; b = total - MIN_FR; }
      if (b < MIN_FR) { b = MIN_FR; a = total - MIN_FR; }
      fr[index] = a;
      fr[index + 1] = b;
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

window.GridController = GridController;
