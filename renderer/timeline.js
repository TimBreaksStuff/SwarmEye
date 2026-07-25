/* Swarm timeline: a one-hour ribbon docked under the swarm map, one lane per
 * agent, coloured by what that agent was doing — busy / waiting / idle /
 * exited — with the tool it was running on hover.
 *
 * The data comes from app.js, which appends a `{t, status, tool}` entry to a
 * per-session log whenever a pane's state changes; a segment runs from its
 * entry's timestamp to the next one's, or to now for the last. Nothing is
 * sampled on a timer: a state that doesn't change simply draws as one long
 * band, which is exactly what it was.
 *
 * Repainting is reconciled rather than rebuilt, and per lane: a lane is only
 * re-laid-out when its own signature changes. The swarm view repaints on
 * every hook event — several a second with a busy swarm — and a full
 * innerHTML swap would tear out the segment the cursor is resting on, which
 * Chromium never fires a mouseout for, orphaning its tooltip (the same
 * reason Topbar's swarm map and SwarmView patch in place). The "now" edge is
 * bucketed to TICK_MS so a lane whose agent is simply still busy doesn't
 * re-render on every paint either. Exposes the global `Timeline`.
 */

const Timeline = (() => {
  const WINDOW_MS = 60 * 60 * 1000; // the ribbon always spans exactly one hour
  const TICK_MS = 10000; // "now" is rounded to this, so idle lanes stay still
  const MARKS = 6; // minute gridlines / labels across the track

  const laneById = new Map(); // sessionId -> {row, name, track, sig}
  let headEl = null;

  function fmtClock(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtSpan(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.round(s / 60);
    return m + 'm';
  }

  /* Entry list -> drawable bands, clipped to the window. The entry that was
   * already in force when the window opened is carried in as the first band
   * rather than dropped, or every lane would start blank after an hour of
   * one unchanging state. */
  function bands(entries, from, to) {
    if (!entries || !entries.length) return [];
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const start = entries[i].t;
      const end = i + 1 < entries.length ? entries[i + 1].t : to;
      if (end <= from) continue;
      out.push({
        status: entries[i].status,
        tool: entries[i].tool,
        start: Math.max(start, from),
        end: Math.min(end, to),
      });
    }
    return out.filter((b) => b.end > b.start);
  }

  function makeLane() {
    const row = document.createElement('div');
    row.className = 'tl-lane';
    const name = document.createElement('span');
    name.className = 'tl-lane-name';
    const track = document.createElement('span');
    track.className = 'tl-track';
    row.append(name, track);
    return { row, name, track, sig: null };
  }

  function paintTrack(track, list, from, to) {
    track.textContent = '';
    const span = to - from || 1;
    for (const b of list) {
      const seg = document.createElement('i');
      seg.className = 'tl-seg tl-seg-' + b.status;
      seg.style.left = ((b.start - from) / span) * 100 + '%';
      seg.style.width = Math.max(0.25, ((b.end - b.start) / span) * 100) + '%';
      seg.dataset.tip = `${b.status}${b.tool ? ' · ' + b.tool : ''} · ${fmtClock(b.start)} for ${fmtSpan(b.end - b.start)}`;
      track.appendChild(seg);
    }
  }

  function paintHead(el, from, to) {
    if (!headEl || !headEl.isConnected) {
      headEl = document.createElement('div');
      headEl.className = 'tl-head';
      el.appendChild(headEl);
    }
    headEl.textContent = '';
    const label = document.createElement('span');
    label.className = 'tl-head-label';
    label.textContent = 'last hour';
    headEl.appendChild(label);
    const scale = document.createElement('span');
    scale.className = 'tl-head-scale';
    for (let i = 0; i <= MARKS; i++) {
      const mark = document.createElement('span');
      mark.className = 'tl-mark';
      mark.style.left = (i / MARKS) * 100 + '%';
      mark.textContent = i === MARKS ? 'now' : fmtClock(from + ((to - from) * i) / MARKS);
      scale.appendChild(mark);
    }
    headEl.appendChild(scale);
  }

  /* panes: the live Pane objects, in the order they should be listed.
   * log: sessionId -> entry array (app.js owns it). */
  function render(el, panes, log) {
    const to = Math.round(Date.now() / TICK_MS) * TICK_MS;
    const from = to - WINDOW_MS;
    paintHead(el, from, to);

    let lanesEl = el.querySelector('.tl-lanes');
    if (!lanesEl) {
      lanesEl = document.createElement('div');
      lanesEl.className = 'tl-lanes';
      el.appendChild(lanesEl);
    }

    let emptyEl = el.querySelector('.tl-empty');
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'tl-empty';
      emptyEl.textContent = 'no agents yet — a lane appears here as soon as one starts';
      el.appendChild(emptyEl);
    }
    emptyEl.hidden = panes.length > 0;

    const seen = new Set();
    panes.forEach((pane, i) => {
      const id = pane.session.id;
      seen.add(id);
      let lane = laneById.get(id);
      if (!lane) {
        lane = makeLane();
        laneById.set(id, lane);
      }
      // move into position without rebuilding — insertBefore on a node that
      // is already there is a no-op in every engine
      const at = lanesEl.children[i];
      if (at !== lane.row) lanesEl.insertBefore(lane.row, at || null);

      const entries = log.get(id) || [];
      const last = entries.length ? entries[entries.length - 1] : null;
      const sig = `${entries.length}|${last ? last.t + ':' + last.status + ':' + (last.tool || '') : ''}|${to}`;
      if (lane.sig === sig) return;
      lane.sig = sig;
      lane.name.textContent = pane.session.agentName;
      lane.name.dataset.tip = `${pane.session.agentName} · ${pane.session.workspaceName}`;
      paintTrack(lane.track, bands(entries, from, to), from, to);
    });

    for (const [id, lane] of laneById) {
      if (seen.has(id)) continue;
      lane.row.remove();
      laneById.delete(id);
    }
  }

  return { render, WINDOW_MS };
})();

window.Timeline = Timeline;
