/* renderer/lib/confirm.js — the app's one click-twice-to-confirm button behaviour,
 * shared by every destructive control (task cards and their categories, the
 * skills screen's remove buttons, archived workspaces). Exposes window.Confirm.
 *
 * The armed state lives here rather than as a CSS class alone because all
 * three screens rebuild their rows on unrelated events (git polls, agent
 * status flips, background skill-update results) — a rebuild would wipe an
 * armed button mid-confirm and turn the second click into a fresh arm. Rows
 * re-apply it after rendering with restoreArmed().
 *
 * One action is armed app-wide at a time: arming a second disarms the first,
 * so a forgotten armed ✕ on another screen can't fire from a stray click.
 * The armed button and its expiry timer are tracked with the key so that
 * disarming always clears the look as well — one element can stand for more
 * than one key, and a stale timeout must not strip `.armed` from a button
 * that is armed for something else. */
export const Confirm = (() => {
  const ARM_MS = 3000;
  let armed = { key: null, until: 0, btn: null, timer: null };

  function isArmed(key) {
    return armed.key === key && Date.now() < armed.until;
  }

  /* Drop whatever is armed: its look, its timer and its key. Callers use this
   * when the armed button changes meaning under them — switching workspace or
   * section — rather than leaving an arm that would fire on one click. */
  function disarm() {
    if (armed.timer) clearTimeout(armed.timer);
    if (armed.btn) armed.btn.classList.remove('armed');
    armed = { key: null, until: 0, btn: null, timer: null };
  }

  /* First click arms `btn` and returns false; a second click on the same key
   * within ARM_MS runs `fire` and disarms. `key` must be unique per action —
   * callers namespace it ('del:<id>', 'purge:<id>', …). */
  function armOrFire(btn, key, fire) {
    if (isArmed(key)) {
      disarm();
      fire();
      return true;
    }
    disarm();
    armed = { key, until: Date.now() + ARM_MS, btn, timer: setTimeout(disarm, ARM_MS) };
    btn.classList.add('armed');
    return false;
  }

  /* Re-apply the armed look to a freshly rendered button. */
  function restoreArmed(btn, key) {
    if (isArmed(key)) {
      armed.btn = btn; // the element the key was armed on may have been rebuilt
      btn.classList.add('armed');
    }
  }

  return { armOrFire, restoreArmed, disarm };
})();
