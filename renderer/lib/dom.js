/* The things every screen in this renderer was writing out by hand.
 *
 * A plain classic script loaded before all of them, in the same shape as
 * tooltip.js and confirm.js: the names land on the global scope, which the
 * feature ES modules can read by bare name as well. */

/* One element in one call — `elt('div', 'card', 'Name')` — instead of the
 * createElement / className / textContent run it replaces. Both trailing
 * arguments are optional, and a null text is left off rather than written out
 * as the string "null", so `elt('span', 'x', maybeMissing)` is safe. */
function elt(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---- floating popovers ----
 * Ten of them hang off a button in this app — the branch menu, the model and
 * scope pickers, the + Agent menu, the bell, the gear, the messenger, the
 * board's categories, the global search — and every one of them was writing
 * out the same two blocks: measure the anchor and clamp the box inside the
 * window, then listen for the click that closes it again. */

const POP_GAP = 6;  // between the anchor's bottom edge and the box
const POP_EDGE = 8; // closest the box may sit to a window edge

/* Put `el` under `anchor`, inside the window.
 *
 * `align: 'left'` pins the box's left edge to the anchor's and pulls it back
 * off the right window edge — that measures the box, so it must already be in
 * the DOM. `align: 'right'` pins its right edge to the anchor's instead, which
 * needs no measurement and is what the top bar's own popovers want.
 *
 * `flip` moves the box above the anchor when it would otherwise run off the
 * bottom. `cap` also limits its height to the room on whichever side it lands,
 * which is what lets a 60vh model catalog open from a chip at the bottom of
 * the grid; a box with no cap has nothing to limit it, so it flips whatever is
 * above it and pins to the top edge — showing the head of a list beats leaving
 * it hanging off the bottom. */
function placePop(el, anchor, { align = 'left', gap = POP_GAP, flip = false, cap = false } = {}) {
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.round(r.bottom + gap) + 'px';
  if (align === 'right') {
    el.style.left = '';
    el.style.right = Math.max(POP_EDGE, Math.round(window.innerWidth - r.right)) + 'px';
  } else {
    el.style.right = '';
    el.style.left = Math.round(Math.max(POP_EDGE,
      Math.min(r.left, window.innerWidth - el.offsetWidth - POP_EDGE))) + 'px';
  }
  if (!flip) return;
  const below = window.innerHeight - r.bottom - gap - POP_EDGE;
  if (el.offsetHeight <= below) return;
  const above = r.top - gap - POP_EDGE;
  const up = cap ? above > below : true;
  if (cap) el.style.maxHeight = Math.round(Math.max(0, up ? above : below)) + 'px';
  if (up) el.style.top = Math.round(Math.max(POP_EDGE, r.top - gap - el.offsetHeight)) + 'px';
}

/* Close `el` on the first interaction outside it — a mousedown anywhere else,
 * and with `esc` the Escape key, swallowed so it doesn't also close whatever
 * sits underneath. `keep` names elements a press inside must not count as
 * outside (the button that opened the box, above all).
 *
 * Returns the teardown. The caller runs it from its own close(), which is the
 * bookkeeping half every one of these popovers used to repeat. */
function dismissPop(el, close, { esc = false, keep = [] } = {}) {
  const inside = (target) => el.contains(target)
    || keep.some((k) => k && (k === target || k.contains(target)));
  const onDown = (e) => { if (!inside(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('mousedown', onDown, true);
  if (esc) document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('mousedown', onDown, true);
    if (esc) document.removeEventListener('keydown', onKey, true);
  };
}

/* ---- drag one edge to resize ----
 * The preview dock and the notification panel are the same box in two places:
 * a strip on the left edge, a width in pixels, and that width remembered. */
function dragWidth(handle, el, { key, min, minRest = 360 }) {
  const saved = Number(localStorage.getItem(key));
  if (saved >= min) el.style.width = saved + 'px';
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const onMove = (ev) => {
      const w = Math.max(min, Math.min(window.innerWidth - minRest, startW + (startX - ev.clientX)));
      el.style.width = Math.round(w) + 'px';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      localStorage.setItem(key, String(Math.round(el.getBoundingClientRect().width)));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}
