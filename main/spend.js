const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/* Cross-session cost rollup: what the swarm spent, per day, per workspace, per
 * model. The per-pane cost panel dies with its pane, so nothing used to
 * accumulate — close an agent and its spend was gone. This store is what the
 * Costs screen reads, and the feedback loop for CLAUDE.md's "match the model to
 * the job": routing panes onto cheaper tiers only pays off if you can see it.
 *
 * Its own file rather than config.json, for the same reason runstate.json is
 * separate (see main.js): it takes a write on every agent turn — several a
 * minute with a busy swarm — and config.json carries archived task transcripts,
 * so folding this in would rewrite megabytes at that cadence. Writes are
 * debounced and coalesced; the in-memory tree is the live copy.
 *
 * Figures are the same list-price estimates the pane panel shows (see
 * MODEL_PRICES in hooks.js), not billed amounts. */

const KEEP_DAYS = 90; // older buckets are dropped on write
const WRITE_DEBOUNCE_MS = 5000;
const FIELDS = ['cost', 'input', 'output', 'cacheRead', 'cacheWrite'];

// a turn whose session is gone from the pty manager (killed pane, agent that
// didn't survive a restart) still spent real money — file it here rather than
// dropping it, and let the renderer label it
const UNKNOWN_WS = 'unknown';

function emptyBucket() {
  return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addInto(target, src) {
  for (const f of FIELDS) target[f] += Number(src[f]) || 0;
}

class SpendStore {
  constructor({ onChange, debugLog } = {}) {
    this.onChange = onChange || (() => {});
    this.debugLog = debugLog || (() => {});
    this.days = {}; // 'YYYY-MM-DD' -> workspaceId -> modelId -> bucket
    this.writeTimer = null;
    this.load();
  }

  file() {
    return path.join(app.getPath('userData'), 'spend.json');
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (raw && typeof raw.days === 'object' && raw.days) this.days = raw.days;
    } catch { /* first run, or unreadable — start empty */ }
  }

  /* Fold one turn's delta ({ day: { model: bucket } }, from hooks.js) into the
   * tree under the workspace that agent belongs to. */
  add(workspaceId, delta) {
    const ws = workspaceId || UNKNOWN_WS;
    let touched = false;
    for (const [day, byModel] of Object.entries(delta || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; // key ends up in the tree — validate it
      const dayEntry = this.days[day] || (this.days[day] = {});
      const wsEntry = dayEntry[ws] || (dayEntry[ws] = {});
      for (const [model, bucket] of Object.entries(byModel || {})) {
        const target = wsEntry[model] || (wsEntry[model] = emptyBucket());
        addInto(target, bucket);
        touched = true;
      }
    }
    if (touched) this.schedule();
  }

  /* The whole tree, as the renderer gets it: small enough (90 days × a handful
   * of workspaces × a few models) to send whole and let the Costs screen do its
   * own range and share arithmetic. */
  all() {
    return { days: this.days };
  }

  clear() {
    this.days = {};
    this.write();
    return this.all();
  }

  schedule() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => this.write(), WRITE_DEBOUNCE_MS);
  }

  /* Called on quit so the last few turns aren't lost inside the debounce. */
  flush() {
    if (this.writeTimer) this.write();
  }

  write() {
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.prune();
    const file = this.file();
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days }), 'utf8');
      fs.renameSync(tmp, file); // same atomic tmp+rename as config.js
    } catch (err) {
      this.debugLog('[spend] write failed: ' + err.message);
    }
    this.onChange(this.all());
  }

  prune() {
    const keys = Object.keys(this.days).sort();
    for (const day of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.days[day];
  }
}

module.exports = { SpendStore, UNKNOWN_WS };
