/* renderer/confirm.js — the app's one click-twice-to-confirm button behaviour,
 * shared by every destructive control (task cards and their categories, the
 * skills screen's remove buttons, archived workspaces). Exposes window.Confirm.
 *
 * The armed state lives here rather than as a CSS class alone because all
 * three screens rebuild their rows on unrelated events (git polls, agent
 * status flips, background skill-update results) — a rebuild would wipe an
 * armed button mid-confirm and turn the second click into a fresh arm. Rows
 * re-apply it after rendering with restoreArmed().
 *
 * One button is armed app-wide at a time: arming a second disarms the first,
 * so a forgotten armed ✕ on another screen can't fire from a stray click. */
const Confirm = (() => {
  const ARM_MS = 3000;
  let armed = { key: null, until: 0 };

  function isArmed(key) {
    return armed.key === key && Date.now() < armed.until;
  }

  /* First click arms `btn` and returns false; a second click on the same key
   * within ARM_MS runs `fire` and disarms. `key` must be unique per action —
   * callers namespace it ('del:<id>', 'purge:<id>', …). */
  function armOrFire(btn, key, fire) {
    if (isArmed(key)) {
      armed = { key: null, until: 0 };
      fire();
      return true;
    }
    armed = { key, until: Date.now() + ARM_MS };
    btn.classList.add('armed');
    setTimeout(() => btn.classList.remove('armed'), ARM_MS);
    return false;
  }

  /* Re-apply the armed look to a freshly rendered button. */
  function restoreArmed(btn, key) {
    if (isArmed(key)) btn.classList.add('armed');
  }

  return { armOrFire, restoreArmed };
})();
window.Confirm = Confirm;
