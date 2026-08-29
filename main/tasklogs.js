const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');

/* A completed task's transcript, one file per task, out of config.json.
 *
 * The capture is the agent's whole scrollback — up to 300KB per task — and it
 * used to be stored on the task record itself. That put every finished task's
 * transcript inside config.json, so a board with twenty completed cards made
 * every unrelated save (a session's metadata, a window drag, a priority
 * change) a multi-megabyte synchronous stringify+write on the main thread,
 * and shipped the same megabytes to the renderer on every task mutation and
 * every boot. Archived tasks were split out of the boot payload for exactly
 * this reason (main/ipc/index.js) — the live board is the other half.
 *
 * A log is written once, when its task finishes, and read only when someone
 * opens the transcript popup or exports it. `hasSessionLog` on the task record
 * is what the board draws the button from. */

const DIR = () => path.join(app.getPath('userData'), 'task-logs');

// task ids are minted here (`task_` + base36) — but they end up in a file
// path, so anything that isn't one is refused rather than trusted
const ID_RE = /^[\w-]{1,64}$/;

const fileFor = (id) => (ID_RE.test(String(id)) ? path.join(DIR(), id + '.log') : null);

function write(id, text) {
  const file = fileFor(id);
  if (!file) return false;
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return true;
  } catch {
    return false; // an unwritable log must not fail the task's completion
  }
}

function read(id) {
  const file = fileFor(id);
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function drop(id) {
  const file = fileFor(id);
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/* One-time move of the transcripts an older version wrote onto the task
 * records themselves. Runs at boot (main/ipc/tasks.js), and leaves the tasks
 * carrying `hasSessionLog` in place of the text. */
function migrate() {
  const cfg = config.load();
  const tasks = cfg.tasks || [];
  if (!tasks.some((t) => typeof t.sessionLog === 'string')) return;
  cfg.tasks = tasks.map((t) => {
    if (typeof t.sessionLog !== 'string') return t;
    const { sessionLog, ...rest } = t;
    // a log that can't be written stays on the record rather than being lost
    return write(t.id, sessionLog) ? { ...rest, hasSessionLog: true } : t;
  });
  config.save(cfg);
}

module.exports = { write, read, drop, migrate };
