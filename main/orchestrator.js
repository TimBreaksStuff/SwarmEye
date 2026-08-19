/* main/orchestrator.js — the channel a lead agent hands work back through.
 *
 * The coordinator (coordinator.js) splits a sentence without ever seeing the
 * code. A lead agent is the other half of that idea: a real agent in a pane
 * that reads the repo, decides what the work is, and delegates each piece to
 * a worker on whatever model was picked for workers. The only thing missing
 * was a way for an agent to say "start these" — and an agent's one universal
 * capability is writing a file.
 *
 * So: the lead writes `.swarmeye/plan.json` in its workspace and this watches
 * for it. Each wave is *consumed* — read, then deleted — so writing the file
 * again is what queues the next wave, and nothing is ever started twice.
 *
 * A workspace path is a host path on both platforms (the agents chdir into
 * it), so plain `fs` is right here — see the notebook in sessions.js and
 * areas.json in scope.js, which read the same folder the same way. */

const fs = require('fs');
const path = require('path');

const PLAN_DIR = '.swarmeye';
const PLAN_NAME = 'plan.json';

// a lead that misunderstands its brief must not be able to queue fifty agents
const MAX_ROWS = 8;
const MAX_TEXT = 4000;
const MAX_ROLE = 40;

// an agent writing a few KB of JSON fires several change events, and the
// first of them can land on a half-written file — wait for the writes to stop
const SETTLE_MS = 400;
// ...and if it still doesn't parse, it may simply be a big write in progress
const PARSE_TRIES = 3;
const PARSE_RETRY_MS = 300;

const watchers = new Map(); // leadSessionId -> { fsw, wsPath, timer, onPlan }

/* Everything the model wrote is re-validated before it can reach task:create:
 * a row is {text, role}, the role is checked against the real table there
 * (roles.has), and the wave is capped whatever the file says. A malformed row
 * is dropped rather than failing the wave — the same rule readAreas uses. */
function clean(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((r) => ({
      text: String((r && r.text) || '').slice(0, MAX_TEXT).trim(),
      role: String((r && r.role) || '').slice(0, MAX_ROLE).trim(),
    }))
    .filter((r) => r.text)
    .slice(0, MAX_ROWS);
}

/* Read the plan and take it off disk in one step. The delete is what makes a
 * wave a wave: the file existing means "not started yet", so it must not
 * survive a successful read. It is removed after a failed one too — the lead
 * is told why and can write a corrected file, which a leftover would make
 * ambiguous (a rewrite of the same bytes fires no change event). */
async function consume(wsPath) {
  const file = path.join(wsPath, PLAN_DIR, PLAN_NAME);
  let text = null;
  let items = null;
  for (let attempt = 0; attempt < PARSE_TRIES; attempt++) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null; // gone already — a stray event, not a wave
    }
    try {
      items = clean(JSON.parse(text));
      if (items) break;
      items = null;
    } catch {
      items = null;
    }
    await new Promise((r) => setTimeout(r, PARSE_RETRY_MS));
  }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  if (!items) return { items: [], reason: 'not a JSON array of objects with a text field' };
  if (!items.length) return { items: [], reason: 'no row had any text' };
  return { items };
}

/* Watch for one lead's plan file. The directory is watched rather than the
 * file: `plan.json` doesn't exist yet at launch, and a writer that renames
 * over it would leave a file watch pointing at the replaced inode. */
function watch(sessionId, wsPath, onPlan) {
  unwatch(sessionId);
  const dir = path.join(wsPath, PLAN_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  // a plan left behind by a killed lead must not start this one's workers
  try { fs.unlinkSync(path.join(dir, PLAN_NAME)); } catch { /* nothing to clear */ }
  let fsw;
  try {
    fsw = fs.watch(dir, (ev, name) => {
      // some platforms report a null filename; falling through costs one read
      if (name && name !== PLAN_NAME) return;
      const entry = watchers.get(sessionId);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(async () => {
        const wave = await consume(wsPath);
        // unwatched while the read was in flight (the lead's pane closed)
        if (wave && watchers.get(sessionId) === entry) entry.onPlan(wave);
      }, SETTLE_MS);
    });
  } catch {
    return false;
  }
  watchers.set(sessionId, { fsw, wsPath, timer: null, onPlan });
  return true;
}

function unwatch(sessionId) {
  const entry = watchers.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  try { entry.fsw.close(); } catch { /* already closed */ }
  watchers.delete(sessionId);
}

module.exports = { watch, unwatch };
