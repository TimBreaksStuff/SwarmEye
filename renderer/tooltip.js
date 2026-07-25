/* renderer/tooltip.js — single shared hover tooltip for the whole app.
 * Elements opt in via data-tip="..." instead of the native title attribute,
 * so every hint renders with SwarmEye's own look instead of the OS/Chromium
 * tooltip. One delegated listener pair covers dynamically-added elements
 * (board cards, panes, skill rows, …) with no per-element wiring needed. */
(() => {
  const SHOW_DELAY = 450;
  let el = null;
  let showTimer = null;
  let anchor = null;

  function get() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'app-tooltip';
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function position(target) {
    const tip = get();
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    let top = Math.round(r.bottom + 8);
    if (top + h > window.innerHeight - 8) top = Math.round(r.top - h - 8);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }

  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    const tip = get();
    // data-tip-secondary opts an element into the split layout: the primary
    // label on the left, a vertical rule, then the secondary text on the right
    // (used by the swarm-map slots to show the agent name and its last input).
    const secondary = target.getAttribute('data-tip-secondary');
    tip.classList.toggle('split', !!secondary);
    if (secondary) {
      tip.textContent = '';
      const primary = document.createElement('span');
      primary.className = 'app-tooltip-primary';
      primary.textContent = text;
      const sep = document.createElement('span');
      sep.className = 'app-tooltip-sep';
      const sec = document.createElement('span');
      sec.className = 'app-tooltip-secondary';
      sec.textContent = secondary;
      tip.append(primary, sep, sec);
    } else {
      tip.textContent = text;
    }
    anchor = target;
    position(target);
  }

  function hide() {
    clearTimeout(showTimer);
    showTimer = null;
    anchor = null;
    if (el) el.hidden = true;
  }

  function scheduleShow(target) {
    if (anchor === target) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(target), SHOW_DELAY);
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    if (target.isContentEditable) return;
    scheduleShow(target);
  });
  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-tip]');
    if (target && (!e.relatedTarget || !target.contains(e.relatedTarget))) hide();
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);

})();
