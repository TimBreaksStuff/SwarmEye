const path = require('path');
const { exec, shQuote } = require('./platform');
const { wsPrelude } = require('./git');

/* Per-agent git worktrees.
 *
 * Agents sharing a workspace share one checkout: two of them editing the same
 * tree clobber each other. An isolated agent gets `<workspace>/.swarmeye/wt/<agent>` on a branch of its
 * own, which is what node-pty chdirs into — a host path on both platforms,
 * exactly like the workspace itself.
 *
 * Everything here runs through the shell for the same reason git.js does: on
 * Windows the repo may live behind a \\wsl$ share that only wslpath can
 * resolve (wsPrelude leaves the translated repo in $p, empty = unreachable).
 *
 * A nested worktree is *not* ignored by git, so the workspace would show its
 * agents' checkouts as untracked junk. The pattern goes in `.git/info/exclude`
 * — per-clone and untracked, so the user's own .gitignore is left alone.
 *
 * Records are separated by \036 rather than newlines: git messages are
 * multi-line, so a newline separator could not be parsed back apart. */

const WT_DIR = '.swarmeye/wt'; // shell-side; the host form is built with path.join
const RS = '\x1e';

/* A worktree directory name, and the tail of its branch. Agent names come from
 * names.js (one capitalised word), but a renamed session or a hand-made
 * directory can be anything — and this lands in a shell command line and a git
 * ref, so it is reduced rather than trusted. */
function slugify(agentName) {
  const s = String(agentName || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ? s : 'agent';
}

/* The host path of a worktree — what node-pty is given as its cwd, and what
 * every later call addresses it by. */
function worktreePath(ws, name) {
  return path.join(ws.path, '.swarmeye', 'wt', name);
}

function splitRecords(out, n) {
  const parts = String(out).split(RS);
  while (parts.length < n) parts.push('');
  return parts;
}

/* Add a worktree for one agent. The name is uniquified against both the
 * directory and the branch — an agent killed earlier leaves its worktree
 * behind on purpose, and names.js will hand the same name out again. */
async function create(ws, agentName) {
  const base = slugify(agentName);
  const q = shQuote(base);
  const script = wsPrelude(ws)
    + 'command -v git >/dev/null || { printf "E\\036no git in this shell"; exit 0; }; '
    // the common dir, not the git dir: in a repo that is itself a linked
    // worktree the two differ, and info/exclude lives with the common one
    + 'd=$(cd "$p" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null); '
    + '[ -n "$d" ] || { printf "E\\036not a git repository"; exit 0; }; '
    + 'case "$d" in /*) ;; *) d="$p/$d";; esac; '
    // a pattern containing a slash is anchored to the repo root, so a workspace
    // that is a subdirectory of its repo needs that prefix in front of it
    + 'pre=$(git -C "$p" rev-parse --show-prefix 2>/dev/null); '
    + `pat="\${pre}${WT_DIR}/"; `
    + 'mkdir -p "$d/info"; '
    + 'grep -qxF "$pat" "$d/info/exclude" 2>/dev/null || printf "%s\\n" "$pat" >> "$d/info/exclude"; '
    + `n=${q}; i=1; `
    + `while [ -e "$p/${WT_DIR}/$n" ] || git -C "$p" show-ref --verify --quiet "refs/heads/swarmeye/$n"; do `
    + `i=$((i+1)); n=${q}-$i; `
    + '[ $i -gt 20 ] && { printf "E\\036too many worktrees with that name"; exit 0; }; done; '
    + `m=$(git -C "$p" worktree add -b "swarmeye/$n" "${WT_DIR}/$n" 2>&1); `
    + 'if [ $? = 0 ]; then printf "OK\\036%s" "$n"; else printf "E\\036%s" "$m"; fi';
  const out = await exec(script, 60000);
  if (out == null) return { ok: false, error: 'shell unreachable' };
  const [tag, rest] = splitRecords(out, 2);
  if (tag.trim() !== 'OK') return { ok: false, error: rest.trim() || 'could not create the worktree' };
  const name = rest.trim();
  return { ok: true, name, branch: 'swarmeye/' + name, path: worktreePath(ws, name) };
}

module.exports = { create, worktreePath };
