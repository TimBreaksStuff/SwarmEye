const { exec } = require('./platform');
const { wsPrelude } = require('./git');

/* Files the workspace `@` picker offers. `git ls-files` rather than a directory
 * walk: it is one process, it already knows about .gitignore, and it cannot
 * wander into node_modules. A workspace that is not a repo simply has nothing
 * to offer here rather than being crawled.
 *
 * Paths come back repo-relative, which is what a prompt naming a file wants —
 * the agent resolves them against its own working directory, so nothing here
 * has to know whether that directory lives on the host or inside WSL. */
const FILES_MAX = 4000;
const FILES_TTL_MS = 30000;
const cache = new Map(); // workspace id -> { at, files }

async function listFiles(ws) {
  const hit = cache.get(ws.id);
  if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.files;
  const script = wsPrelude(ws)
    + `cd "$p" 2>/dev/null || exit 9; git ls-files --cached --others --exclude-standard 2>/dev/null | head -n ${FILES_MAX}`;
  const out = await exec(script, 15000);
  const files = String(out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  cache.set(ws.id, { at: Date.now(), files });
  return files;
}

module.exports = { listFiles };
