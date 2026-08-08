/* Resizable: the shared half of a drag-the-corner popover.
 *
 * The stylesheet does the resizing — `resize: both` plus a min/max pair, which
 * is also what keeps a restored size inside a window that has since been made
 * smaller. This is only the two things CSS cannot do: remember the size the box
 * was left at, and centre the box on whatever size it comes back as.
 *
 * Position is set here rather than by a centring transform because a
 * transform-centred box grows in both directions under the grip and the cursor
 * slides off it. Exposes window.Resizable. */

const Resizable = (() => {
  const EDGE = 8; // closest a box may sit to the window edge

  /* Call after the box is unhidden — a hidden element measures zero. With
   * nothing stored no size is set at all, so the stylesheet stays the one place
   * a popover's default size is written. */
  function place(el, key) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* junk — ignore */ }
    // one axis at a time, and an axis with nothing stored is handed back to the
    // stylesheet rather than left on whatever the last open set
    el.style.width = saved && saved.w ? saved.w + 'px' : '';
    el.style.height = saved && saved.h ? saved.h + 'px' : '';
    // measured, not assumed: min-width and max-height have their say first
    el.style.left = Math.max(EDGE, (window.innerWidth - el.offsetWidth) / 2) + 'px';
    el.style.top = Math.max(EDGE, (window.innerHeight - el.offsetHeight) / 2) + 'px';
  }

  /* Call before the box is hidden, for the same reason. Only an axis the user
   * has actually dragged is stored — a drag writes an inline width/height, and
   * a box left alone keeps whatever the stylesheet says, including an auto
   * height that has to go on following its content. */
  function remember(el, key) {
    const size = {};
    if (el.style.width) size.w = el.offsetWidth;
    if (el.style.height) size.h = el.offsetHeight;
    try {
      if (size.w || size.h) localStorage.setItem(key, JSON.stringify(size));
    } catch { /* quota — drop it */ }
  }

  return { place, remember };
})();

window.Resizable = Resizable;
