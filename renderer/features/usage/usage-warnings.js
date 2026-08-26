/* One toast when the Anthropic quota crosses a threshold.
 *
 * The rail's gauges already colour themselves amber past 75% and red past 90%,
 * but that only helps while you're looking at them; with a swarm running you
 * can walk into the ceiling and only find out when agents start failing
 * mid-turn. Toast once per crossing, at the same two thresholds the gauges
 * change colour at, so the warning and the gauge always agree.
 *
 * Armed level per window: 0 none, 1 warn, 2 crit. It only ever fires on the
 * way up; dropping back below a threshold (or the window resetting, which
 * moves resetsAt) re-arms it for the next time. */

const WARN_PCT = 75;
const CRIT_PCT = 90;
const WINDOWS = [['fiveHour', '5-hour'], ['weekly', 'weekly']];
const armed = { fiveHour: { level: 0, resetsAt: null }, weekly: { level: 0, resetsAt: null } };

export function check(snapshot, toast) {
  // no data is not 0% — a degraded or stale snapshot says nothing about the
  // quota, so it must neither warn nor clear an already-armed level
  if (!snapshot || !snapshot.ok || snapshot.stale) return;
  const crossed = [];
  for (const [key, label] of WINDOWS) {
    const w = snapshot[key];
    const state = armed[key];
    if (!w || typeof w.usedPct !== 'number') continue;
    if (w.resetsAt !== state.resetsAt) { // a fresh window starts unwarned
      state.resetsAt = w.resetsAt;
      state.level = 0;
    }
    const level = w.usedPct >= CRIT_PCT ? 2 : w.usedPct >= WARN_PCT ? 1 : 0;
    if (level > state.level) {
      const resets = w.resetsAt ? ' · resets in ' + Topbar.fmtIn(new Date(w.resetsAt) - Date.now()) : '';
      crossed.push(level === 2
        ? `${label} usage ${w.usedPct}% — agents may start failing${resets}`
        : `${label} usage at ${w.usedPct}%${resets}`);
    }
    state.level = level;
  }
  // one toast at a time: both windows crossing on the same poll share it
  if (crossed.length) toast('⚠ ' + crossed.join(' · '));
}
