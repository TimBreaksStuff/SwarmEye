/* Icons — the one stroke-SVG set the whole app draws from.
 *
 * The chrome (top bar, rail, pane headers) already draws 24-box, 1.6-weight
 * `currentColor` strokes inline in index.html; the views built their buttons
 * out of emoji instead, which pick their own colour and baseline. Same markup,
 * kept here because board.js and skills.js both need the same handful. */
const Icons = (() => {
  const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + body + '</svg>';

  const PATHS = {
    archive: '<rect x="3" y="4.5" width="18" height="4.5" rx="1.2"/><path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
    trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7"/><path d="M6.5 6.5 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-12.5"/><path d="M10.4 10v6.5M13.6 10v6.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.5 4v4.5H16"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    play: '<path d="M8 5.4 18 12 8 18.6V5.4Z"/>',
    left: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
    right: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    chevron: '<path d="m6 9.5 6 6 6-6"/>',
    view: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9h9M7.5 12.5h9M7.5 16h5"/>',
    branch: '<circle cx="7" cy="5.5" r="2.2"/><circle cx="7" cy="18.5" r="2.2"/><circle cx="17" cy="12" r="2.2"/><path d="M7 7.7v8.6"/><path d="M9.2 12h5.6"/>',
    folder: '<path d="M20 19.5a1.8 1.8 0 0 0 1.8-1.8V8.8A1.8 1.8 0 0 0 20 7h-7.3a1.8 1.8 0 0 1-1.5-.8L10.3 5a1.8 1.8 0 0 0-1.5-.8H4A1.8 1.8 0 0 0 2.2 6v11.7a1.8 1.8 0 0 0 1.8 1.8Z"/>',
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
