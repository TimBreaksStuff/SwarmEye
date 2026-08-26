/* Left-menu grip: drag the rail's right border to switch it between the small
 * (icons only) and big (workspace names + usage gauges) layouts — the same two
 * states the "Small left menu" checkbox in the ⌨ popover owns.
 *
 * It drives that checkbox rather than the width directly, so the choice keeps
 * one owner (applyLeftbarStyle in app.js persists it) and the two controls can
 * never disagree. Installs itself; exposes nothing. */

(() => {
  const leftbar = document.getElementById('leftbar');
  const toggle = document.getElementById('leftbar-small-toggle');
  if (!leftbar || !toggle) return;

  // the rail is 57px small and 264px big — flip at the halfway mark, so either
  // end is a short pull away from wherever the border currently sits
  const THRESHOLD = 160;

  const grip = document.createElement('div');
  grip.className = 'rail-grip';
  grip.dataset.tip = 'Drag to resize the menu — small or big';
  leftbar.appendChild(grip);

  const isSmall = () => !leftbar.classList.contains('expanded');
  function setSmall(small) {
    if (small === isSmall()) return;
    toggle.checked = small;
    toggle.dispatchEvent(new Event('change'));
  }

  /* hovering the small rail previews the big layout as a floating overlay
   * (app.js) — that preview would swallow the border the pointer came for, so
   * drop it while the pointer rests on the grip and hand it back on the way
   * back into the rail */
  grip.addEventListener('mouseenter', () => leftbar.classList.remove('hover-expanded'));
  grip.addEventListener('mouseleave', (e) => {
    if (isSmall() && e.relatedTarget && leftbar.contains(e.relatedTarget)) leftbar.classList.add('hover-expanded');
  });

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    leftbar.classList.add('rail-dragging'); // the 0.16s width transition lags the pointer otherwise
    const startX = e.clientX;
    let moved = false;
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      setSmall(ev.clientX - leftbar.getBoundingClientRect().left < THRESHOLD);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      leftbar.classList.remove('rail-dragging');
      if (!moved) setSmall(!isSmall()); // a click on the border, no drag, just toggles
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
})();
