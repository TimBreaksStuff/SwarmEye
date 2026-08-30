/* renderer/lib/keys.js — the renderer's one platform fact, and the predicate
 * that depends on it.
 *
 * Windows must not treat the Windows key as the modifier: Chromium reports it
 * as metaKey, so accepting metaKey there would make Win+N spawn an agent.
 * Every keydown listener in the app asks this rather than testing the event
 * itself, which is why it is not any one area's.
 *
 * It lived in app.js and was published as window.modHeld for the classic
 * scripts that could not import it. They are all modules now. */

export const IS_MAC = window.swarm.isMac;

export function modHeld(e) {
  return IS_MAC ? (e.metaKey || e.ctrlKey) : e.ctrlKey;
}
