const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec, toShellPath } = require('./platform');
const { wsPrelude } = require('./git');

/* What the message box can put into a prompt besides typed words: a file from
 * the workspace, and an image from the clipboard.
 *
 * Both end up as a **path in the message text**, because that is what Claude
 * Code takes — it reads an image off disk when a prompt names one. And it has
 * to be the path as the *agent* sees it: on Windows the agent runs inside WSL,
 * so a `C:\...` path means nothing to it and `toShellPath` is what makes the
 * difference between a working mention and a file the agent cannot open. */

/* Files the `@` picker offers. `git ls-files` rather than a directory walk:
 * it is one process, it already knows about .gitignore, and it cannot wander
 * into node_modules. A workspace that is not a repo simply has nothing to
 * offer here rather than being crawled. */
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

/* An image pasted or dropped into the message box, written where the agent can
 * read it. Kept in the user-data dir rather than the workspace: it is not the
 * user's source, and a screenshot dropped into a prompt should not turn up in
 * their next `git status`. */
const IMAGE_DIR = () => path.join(app.getPath('userData'), 'pasted');
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/* Only the four raster types Claude Code actually reads, and only from a real
 * data URL — the renderer hands over whatever the clipboard gave it, and this
 * is the point where that stops being trusted. */
function saveImage(dataUrl) {
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { ok: false, reason: 'not an image' };
  const ext = IMAGE_TYPES[m[1]];
  if (!ext) return { ok: false, reason: 'unsupported image type' };
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { ok: false, reason: 'empty image' };
  if (buf.length > IMAGE_MAX_BYTES) return { ok: false, reason: 'image is too large' };
  try {
    fs.mkdirSync(IMAGE_DIR(), { recursive: true });
    const name = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const file = path.join(IMAGE_DIR(), name);
    fs.writeFileSync(file, buf);
    // the path the *agent* needs, which on Windows is the WSL one. Null means
    // this host path cannot be expressed there at all — better to say so than
    // to hand over a path that silently fails to open.
    const shell = toShellPath(file);
    if (!shell) return { ok: false, reason: 'cannot reach that path from the agent' };
    return { ok: true, path: shell };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { listFiles, saveImage };
