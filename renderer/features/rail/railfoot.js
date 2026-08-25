/* Foot grip: drag the line above "Views" down to fold the four destinations
 * into one row of icons at the bottom of the rail, up to unfold them again.
 *
 * Only the expanded rail folds — the 57px rail is icons already. State lives in
 * localStorage next to swarmeye.leftbarStyle, so the rail comes back the way it
 * was left. Installs itself; exposes nothing. */

(() => {
  const leftbar = document.getElementById('leftbar');
  const foot = document.getElementById('rail-foot');
  if (!leftbar || !foot) return;

  const KEY = 'swarmeye.railFoot';

  const grip = document.createElement('div');
  grip.className = 'rail-foot-grip';
  grip.dataset.tip = 'Drag down to fold the views into an icon bar';
  foot.parentNode.insertBefore(grip, foot);

  const isCollapsed = () => leftbar.classList.contains('foot-collapsed');
  function setCollapsed(collapsed) {
    if (collapsed === isCollapsed()) return;
    leftbar.classList.toggle('foot-collapsed', collapsed);
    localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open');
    grip.dataset.tip = collapsed
      ? 'Drag up to bring the views back'
      : 'Drag down to fold the views into an icon bar';
  }

  setCollapsed(localStorage.getItem(KEY) === 'collapsed');

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    leftbar.classList.add('foot-dragging');
    const startY = e.clientY;
    let moved = false;
    // 24px of travel, not the grip's own position: the group's height changes
    // under the pointer mid-drag, so only the direction of the pull is stable
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 3) moved = true;
      if (dy > 24) setCollapsed(true);
      else if (dy < -24) setCollapsed(false);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      leftbar.classList.remove('foot-dragging');
      if (!moved) setCollapsed(!isCollapsed()); // a click on the line just toggles
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
})();
