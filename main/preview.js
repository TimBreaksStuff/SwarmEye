/* Preview dock backend: find the workspace's dev server, or start one.
 *
 * Probe first — an agent that already ran `npm run dev` in its own pane owns a
 * server we must not duplicate. Only when nothing answers do we start one, in
 * its own tmux session on the swarmeye server, so it survives an app restart
 * and can be killed by name like any agent.
 * Exposes { resolve, stop }. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec, toShellPath, shQuote } = require('./platform');
// same tmux server as the agents — the socket/conf must never drift apart,
// or preview sessions stop being reconciled and killed with the rest
const { TMUX, startServer } = require('./sessions');
const PORTS = [3000, 5173, 8080, 4200, 8000, 1420];
const PROBE_MS = 400;
const START_TRIES = 30; // ~15s: a cold vite is fast, a cold next is not
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}\S*/;

const sessionName = (workspaceId) => 'swarmeye_preview_' + String(workspaceId).replace(/[^A-Za-z0-9_-]/g, '');

/* answering at all is enough — a dev server mid-compile still 500s, and that
 * is a page worth showing */
function answers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: PROBE_MS }, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function portOf(url) {
  try {
    const u = new URL(url);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return null; }
}

function devScript(dir) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  const scripts = pkg.scripts || {};
  return ['dev', 'start', 'serve'].find((s) => typeof scripts[s] === 'string') || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Bumped by stop(): the ~15s poll below is otherwise uncancellable, so closing
 * the dock left it spawning shell probes into a session that no longer exists
 * — and the renderer's `resolving` flag stayed up until it finished, blocking
 * the next workspace's preview. workspaceId -> generation. */
const generations = new Map();

async function start(dir, workspaceId) {
  const script = devScript(dir);
  if (!script) return { ok: false, reason: 'no-script' };
  const cwd = toShellPath(dir);
  if (!cwd) return { ok: false, reason: 'unreachable' };

  const gen = generations.get(workspaceId) || 0;
  const name = sessionName(workspaceId);
  // the session name is sanitised above and the script is one of three
  // literals, but the workspace path is whatever the user picked
  // startServer for the same reason every agent launch has one: a server this
  // is the first to start would otherwise keep this workspace as its working
  // directory for as long as it runs (main/sessions.js)
  await exec(`${TMUX} has-session -t '=${name}' 2>/dev/null`
    + ` || { ${startServer()} ${TMUX} new-session -d -s ${name} -c ${shQuote(cwd)}`
    + ` 'npm run ${script}'; }`);

  // a stop() that landed while the exec above was in flight killed a session
  // that didn't exist yet — the dev server just created would run (and survive
  // restarts) with nothing left pointing at it. Kill it now instead.
  if ((generations.get(workspaceId) || 0) !== gen) {
    await exec(`${TMUX} kill-session -t '=${name}' 2>/dev/null; true`);
    return { ok: false, reason: 'stopped', script };
  }

  // the server announces its own address; scraping the pane beats guessing,
  // since a taken port silently moves vite to the next one
  for (let i = 0; i < START_TRIES; i++) {
    await sleep(500);
    if ((generations.get(workspaceId) || 0) !== gen) return { ok: false, reason: 'stopped', script };
    // a pane target, so no '=' exact-match prefix here — that is session syntax
    const out = await exec(`${TMUX} capture-pane -p -t ${name} 2>/dev/null; true`);
    const m = URL_RE.exec(out || '');
    if (m) return { ok: true, url: m[0], started: true, script };
  }
  return { ok: false, reason: 'no-url', script };
}

/* preferred is whatever the dock last had up for this workspace — it gets
 * probed first so a remembered non-standard port keeps working */
async function resolve(dir, workspaceId, preferred) {
  const ports = [portOf(preferred), ...PORTS].filter((p, i, a) => p && a.indexOf(p) === i);
  for (const port of ports) {
    if (await answers(port)) return { ok: true, url: `http://localhost:${port}/` };
  }
  return start(dir, workspaceId);
}

async function stop(workspaceId) {
  generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1);
  await exec(`${TMUX} kill-session -t '=${sessionName(workspaceId)}' 2>/dev/null; true`);
}

module.exports = { resolve, stop };
