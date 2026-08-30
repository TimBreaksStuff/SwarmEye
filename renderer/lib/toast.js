/* renderer/lib/toast.js — the one transient message line at the bottom of the
 * window.
 *
 * It lived in app.js and was published as window.toast, because the screens
 * that call it were classic scripts and a classic script cannot import from a
 * module. They are all modules now, so it is a plain import and no area owns
 * it: the pane, the skills screen, settings and the app itself all raise the
 * same one. */

const toastEl = document.getElementById('toast');
let toastTimer = null;

export function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
