/* Icons — the one stroke-SVG set the whole app draws from.
 *
 * The chrome (top bar, rail, pane headers) already draws 24-box, 1.6-weight
 * `currentColor` strokes inline in index.html; the views built their buttons
 * out of emoji instead, which pick their own colour and baseline. Same markup,
 * kept here because board.js, skills.js, history.js and swarmview.js all need
 * the same handful. */
const Icons = (() => {
  const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + body + '</svg>';

  const PATHS = {
    archive: '<rect x="3" y="4.5" width="18" height="4.5" rx="1.2"/><path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
    trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7"/><path d="M6.5 6.5 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-12.5"/><path d="M10.4 10v6.5M13.6 10v6.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/>',
    download: '<path d="M12 3.5v11"/><path d="m7.8 10.6 4.2 4.2 4.2-4.2"/><path d="M4.5 17v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.5 4v4.5H16"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    check: '<path d="m5.5 12.5 4.2 4.4L18.5 7.5"/>',
    play: '<path d="M8 5.4 18 12 8 18.6V5.4Z"/>',
    left: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
    right: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    chevron: '<path d="m6 9.5 6 6 6-6"/>',
    panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17"/>',
    timeline: '<path d="M4 6.5h11M4 12h16M4 17.5h8"/>',
    cursor: '<path d="M6 4.2 18.5 11l-5.4 1.4L11 18 6 4.2Z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M4.9 7.5l1.9 1.1M17.2 15.4l1.9 1.1M4.9 16.5l1.9-1.1M17.2 8.6l1.9-1.1"/>',
    view: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5"/>',
    pin: '<path d="M9 3.5h6M12 3.5V9M8 9h8l1.5 5h-11L8 9Z"/><path d="M12 14v6"/>',
    note: '<path d="M6 3.5h9.5L19 7v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M15 3.5V7h4"/><path d="M8.5 12h7M8.5 15.5h5"/>',
  };

  const markup = (name) => svg(PATHS[name] || '');

  /* Sets a button's icon, and optionally the label beside it. Replaces the
   * whole content, so it is safe to call on every re-render of a toggle. */
  function set(el, name, label) {
    el.innerHTML = markup(name) + (label ? '<span>' + label + '</span>' : '');
    return el;
  }

  return { markup, set };
})();
