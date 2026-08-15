const fs = require('fs');
const path = require('path');
const { toShellPath } = require('./platform');

/* Confining one agent to a subtree of its workspace.
 *
 * Claude Code has no "work only in here" switch. The only boundary it offers
 * is permission rules, and deny is evaluated before allow — a deny rule
 * cannot carry an allowlist exception — so "everything except this folder"
 * has to be spelled out: one deny per entry that sits *beside* the path from
 * the workspace root down to the scope. That is what denyRules builds.
 *
 * Three rules from Claude Code's own permission docs shape the strings:
 *  - only `Edit(path)` and `Read(path)` are consulted for file changes. A
 *    `Write()`, `MultiEdit()` or `NotebookEdit()` path rule is accepted, never
 *    checked, and warns at startup — so every rule here is an Edit one, which
 *    covers writing and creating too.
 *  - a single leading slash anchors at the *settings file*, which for us is
 *    the user-data dir. An absolute path is the `//` form.
 *  - the patterns are gitignore syntax, and a rule you write yourself is not
 *    escaped for you.
 *
 * Reads are deliberately left alone: an agent scoped to one folder still has
 * to read the rest of the repo to work in it.
 */

// a scope is a relative POSIX path inside the workspace and nothing else: no
// absolute path, no `..` hop, no backslash (a spelling the workspace path
// never uses on this side of the app), nothing long enough to be a payload
const SEGMENT_RE = /^[^/\\]{1,80}$/;
const MAX_LEN = 400;

/* What a scope names, or null if it names nothing: this is what turns
 * renderer text (or a line of the areas file) into a path main will act on.
 * A folder or a single file — an area is often one of each, `board.js` beside
 * `features/board/`. */
function resolve(root, rel) {
  const raw = String(rel || '').replace(/\/+$/, '');
  if (!raw || raw.length > MAX_LEN) return null;
  const parts = raw.split('/');
  if (!parts.every((p) => SEGMENT_RE.test(p) && p !== '.' && p !== '..')) return null;
  const abs = path.resolve(root, ...parts);
  // the segments above cannot climb out, but a resolved path that left the
  // root anyway (a root that is itself relative, say) is not one to trust
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    fs.statSync(abs);
  } catch {
    return null;
  }
  return { rel: parts.join('/'), dir: abs };
}

/* A real folder called `report[2024]` would otherwise turn the pattern into a
 * character class and stop matching its own path. */
function escapePattern(name) {
  return name.replace(/[[\]*?\\]/g, '\\$&');
}

/* Every Edit deny that together mean "only inside these paths", anchored at
 * `root` — the agent's own working directory, so an isolated agent is scoped
 * inside its worktree rather than the workspace it was cut from.
 *
 * One walk down from the root. At each level an entry is either one of the
 * allowed paths (left alone, with everything under it), an ancestor of one
 * (walked into, since what is allowed sits below), or neither — and that is
 * what gets denied. A scope of one folder is this walk with one allowed path,
 * which is what 1.60.75 shipped.
 *
 * Null means the boundary cannot be expressed (an unreadable directory, or a
 * Windows path with no WSL spelling) — the caller refuses the launch rather
 * than starting an agent that believes it is scoped and is not. An empty
 * array is a real answer: allowed paths whose ancestors hold nothing else. */
function denyRules(root, rels) {
  const wanted = [];
  for (const rel of [].concat(rels || [])) {
    const at = resolve(root, rel);
    if (!at) return null;
    wanted.push(at.rel.split('/'));
  }
  if (!wanted.length) return null;
  const rules = [];
  const walk = (dir, prefix) => {
    /* what this level may hold: the next segment of every allowed path still
     * running through here, mapped to whether the path *ends* on it — one
     * area can name both `renderer/board.js` and `renderer/features/board`,
     * so a segment can be an endpoint and a waypoint at once. */
    const allowed = new Map();
    for (const parts of wanted) {
      if (parts.length <= prefix.length) continue;
      if (!prefix.every((p, i) => parts[i] === p)) continue;
      const seg = parts[prefix.length];
      allowed.set(seg, allowed.get(seg) || parts.length === prefix.length + 1);
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (allowed.get(entry.name)) continue; // an allowed path, and all of it
      if (allowed.has(entry.name)) { // on the way to one — walk into it
        if (!walk(path.join(dir, entry.name), prefix.concat(entry.name))) return false;
        continue;
      }
      const abs = toShellPath(path.join(dir, entry.name));
      if (!abs) return false;
      // a symlink is denied as the path it is, not as the tree behind it —
      // Claude Code checks both spellings of a symlinked file against deny
      // rules, and anything inside the workspace is already denied by its own
      rules.push(`Edit(/${escapePattern(abs)}${entry.isDirectory() ? '/**' : ''})`);
    }
    return true;
  };
  return walk(path.resolve(root), []) ? rules : null;
}

/* The workspace's own areas: `.swarmeye/areas.json`, beside the notebook — a
 * plain name -> paths map the repo carries, which anyone (an agent included)
 * can edit. A folder is rarely the unit work arrives in; "the task board" is
 * a view file plus a stylesheet, and only the repo knows how it is carved up.
 *
 * Anything malformed is dropped rather than rejecting the file: a typo in one
 * area should cost that area, not the list. Paths are resolved against the
 * workspace here, so the picker can never offer one that is not there. */
const AREAS_REL = path.join('.swarmeye', 'areas.json');
const MAX_AREAS = 60;

function readAreas(wsPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(wsPath, AREAS_REL), 'utf8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const areas = [];
  for (const [label, value] of Object.entries(raw)) {
    if (areas.length >= MAX_AREAS) break;
    const name = String(label).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) continue;
    const paths = [];
    for (const p of [].concat(value || [])) {
      const at = resolve(wsPath, p);
      if (at && !paths.includes(at.rel)) paths.push(at.rel);
    }
    if (paths.length) areas.push({ label: name, paths });
  }
  return areas;
}

module.exports = { resolve, denyRules, readAreas, AREAS_REL };
