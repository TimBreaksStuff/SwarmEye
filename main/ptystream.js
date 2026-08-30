/* main/ptystream.js — pty output on its way to the renderer.
 *
 * node-pty emits bursts of small chunks under fast output and each one
 * forwarded is a renderer wake, so output is coalesced per session before it
 * crosses IPC. Two beats, because an agent in a workspace nobody is looking at
 * streams exactly as hard as one on screen.
 *
 * This lived in main.js, which owns the window and the monitors and is a file
 * agents are told not to touch. It is its own concern: a queue, two timers and
 * the rule for which sessions are on screen.
 *
 * `create({ send })` returns the three things main.js wires up — `onData` for
 * the PtyManager, `flush(id)` for the paths that must not let a session's last
 * output arrive after its exit event, and `setVisibleSessions` for the IPC
 * channel the renderer reports the grid on.
 */

module.exports = function create({ send }) {
  /* pty output is coalesced per session before crossing IPC: node-pty emits
   * bursts of small chunks under fast output, and forwarding each one wakes
   * the renderer per chunk. One ~16ms batch per session keeps scrolling
   * smooth while cutting IPC message count by an order of magnitude when
   * several agents stream at once. */
  const ptyBuffers = new Map(); // sessionId -> queued output
  let ptyFlushTimer = null;
  /* An agent in a workspace nobody is looking at streams just as hard as one on
   * screen, and every batch is a renderer wake — ten of them at 16ms is over
   * six hundred IPC messages a second for panes xterm is not even drawing (it
   * pauses rendering for a terminal that is off screen). They batch at 250ms
   * instead: the same bytes, a fifteenth of the wake-ups, and nothing to see
   * either way. The renderer says which sessions are on screen (syncRendererReclaim
   * in app.js); before it has said anything, every session is treated as visible. */
  const SLOW_FLUSH_MS = 250;
  let visibleSessions = null; // null = the renderer hasn't reported yet
  let ptySlowFlushTimer = null;
  const isVisibleSession = (id) => !visibleSessions || visibleSessions.has(id);
  /* With an id, drain only that session — hook events land several times a
   * second on a busy swarm, and a swarm-wide flush per event would chop every
   * other session's batch into per-event IPC messages, exactly the churn the
   * 16ms batch exists to prevent. The shared timer keeps running for the rest. */
  function flushPtyBuffers(id) {
    if (id !== undefined) {
      const data = ptyBuffers.get(id);
      if (data !== undefined) {
        ptyBuffers.delete(id);
        send('session:data', { id, data });
      }
      return;
    }
    clearTimeout(ptyFlushTimer);
    ptyFlushTimer = null;
    // the slow beat drains its own sessions; this one leaves them queued
    for (const [sid, data] of ptyBuffers) {
      if (!isVisibleSession(sid)) continue;
      ptyBuffers.delete(sid);
      send('session:data', { id: sid, data });
    }
    armSlowFlush();
  }
  /* Anything still queued belongs to an off-screen session — a pane hidden
   * between its last chunk and this flush has output nobody has armed a timer
   * for, and an agent that then goes quiet would sit on it indefinitely. */
  function armSlowFlush() {
    if (!ptySlowFlushTimer && ptyBuffers.size) {
      ptySlowFlushTimer = setTimeout(flushSlowPtyBuffers, SLOW_FLUSH_MS);
    }
  }
  function flushSlowPtyBuffers() {
    ptySlowFlushTimer = null;
    for (const [sid, data] of ptyBuffers) {
      ptyBuffers.delete(sid);
      send('session:data', { id: sid, data });
    }
  }
  function queuePtyData(id, data) {
    ptyBuffers.set(id, (ptyBuffers.get(id) || '') + data);
    if (isVisibleSession(id)) {
      if (!ptyFlushTimer) ptyFlushTimer = setTimeout(flushPtyBuffers, 16);
    } else if (!ptySlowFlushTimer) {
      ptySlowFlushTimer = setTimeout(flushSlowPtyBuffers, SLOW_FLUSH_MS);
    }
  }
  /* The grid changed: whatever a newly-shown session has queued is up to a
   * quarter-second old, so hand it over now rather than letting the pane paint
   * that late. */
  function setVisibleSessions(ids) {
    visibleSessions = new Set(Array.isArray(ids) ? ids : []);
    for (const sid of [...ptyBuffers.keys()]) {
      if (visibleSessions.has(sid)) flushPtyBuffers(sid);
    }
    armSlowFlush();
  }

  return { onData: queuePtyData, flush: flushPtyBuffers, setVisibleSessions };
};
