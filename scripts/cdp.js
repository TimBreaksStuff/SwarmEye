/* scripts/cdp.js — the two things every dev script here needs: an instance of
 * the app nobody else is using, and a CDP connection to its window.
 *
 * The throwaway --user-data-dir matters twice. It keeps the real config, its
 * workspaces and its single-instance lock out of the way, so a script can run
 * while SwarmEye is open; and it means every run starts from the same blank
 * state, which is what makes two runs comparable at all. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Boots Electron on a throwaway profile and resolves once its window has a
 * CDP target. Resolves to { cdp, stop } — call stop() when done, always. */
async function launchApp({ port = 9333, env = {}, onStderr, seedConfig } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmeye-dev-'));
  /* A blank profile is not the app anyone runs. An empty rail is
   * indistinguishable from a rail that threw on its first workspace tile —
   * which is exactly the bug that shipped in 3.0.0 — so a caller can drop a
   * config in and get an app with something in it. */
  if (seedConfig) fs.copyFileSync(seedConfig, path.join(userData, 'config.json'));
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (b) => { if (onStderr) onStderr(String(b)); });

  const stop = async () => {
    child.kill('SIGTERM');
    await sleep(600);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(userData, { recursive: true, force: true });
  };

  try {
    const wsUrl = await findTarget(port);
    const cdp = await connect(wsUrl);
    return { cdp, stop, child };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function findTarget(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error('the app never exposed a CDP page target on port ' + port);
}

/* A minimal CDP client: send(method, params) for commands, on(method, fn) for
 * events. Node's global WebSocket, so no dependency. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    const handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        for (const fn of handlers.get(msg.method) || []) fn(msg.params);
        return;
      }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const n = ++id;
        return new Promise((res, rej) => {
          waiting.set(n, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: n, method, params }));
        });
      },
      on(method, fn) {
        if (!handlers.has(method)) handlers.set(method, []);
        handlers.get(method).push(fn);
      },
      close() { ws.close(); },
    }));
  });
}

/* Runs an expression in the page and throws with the page's own message if it
 * threw there — an uncaught error inside the page is a failure of the script
 * that asked for it, not something to return as a value. */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.text + ' — ' + ((d.exception && d.exception.description) || ''));
  }
  return r.result.value;
}

module.exports = { ROOT, sleep, launchApp, connect, evaluate };
