/* The two things every screen in this renderer was writing out by hand.
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

/* A screen's filter box. Esc clears the filter rather than closing the whole
 * screen, as long as there is something to clear; every other key is kept off
 * the document-level shortcut handler, since a bare Tab there would move focus
 * into a terminal mid-typing. `onQuery` is handed the trimmed, lower-cased
 * text on every change, and '' when the box is cleared. */
function wireSearch(inputEl, onQuery) {
  inputEl.addEventListener('input', () => onQuery(inputEl.value.trim().toLowerCase()));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Escape' && inputEl.value) {
      inputEl.value = '';
      onQuery('');
      e.stopPropagation();
    }
  });
}
