const path = require('path');
const { exec, shQuote } = require('./platform');
const { wsPrelude } = require('./git');

/* Per-agent git worktrees, and the merge path back.
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
 * Records are separated by \036 rather than newlines: git messages and patches
 * are multi-line, so a newline separator could not be parsed back apart. */

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

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_RE = /^[A-Za-z0-9][\w./-]*$/; // same shape checkoutBranch accepts

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

/* Every worktree under this workspace, with what is in it: the branch, whether
 * it is dirty, and how many commits it holds that the workspace's own HEAD does
 * not — which is what the merge button acts on. One shell call for all of them. */
async function list(ws) {
  const script = wsPrelude(ws)
    + `r="$p/${WT_DIR}"; [ -d "$r" ] || exit 0; `
    + 'h=$(git -C "$p" rev-parse HEAD 2>/dev/null); '
    + 'for w in "$r"/*/; do '
    + 'n=$(basename "$w"); '
    + 'b=$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null) || continue; '
    + '[ -n "$b" ] || continue; '
    + 's=$(git -C "$w" status --porcelain 2>/dev/null | head -c1); '
    // no HEAD in the workspace (a repo with no commits) means nothing to
    // compare against — report 0 rather than a git error
    + 'c=0; [ -n "$h" ] && c=$(git -C "$w" rev-list --count "$h"..HEAD 2>/dev/null); '
    + 'printf "%s\\t%s\\t%s\\t%s\\n" "$n" "$b" "$s" "${c:-0}"; '
    + 'done';
  const out = await exec(script, 30000);
  if (out == null) return null;
  const entries = [];
  for (const line of out.split('\n')) {
    const [name, branch, dirty, ahead] = line.split('\t');
    if (!name || !branch) continue;
    entries.push({ name, branch, dirty: !!dirty, ahead: parseInt(ahead, 10) || 0 });
  }
  return entries;
}

/* Remove a worktree and its directory. --force because the whole point of
 * keeping it past its agent's death is that it may still hold uncommitted
 * work; the caller arms this behind Confirm. The branch is left alone — it may
 * carry commits nothing else has. */
async function remove(ws, name) {
  if (!NAME_RE.test(String(name || ''))) return { ok: false, error: 'invalid worktree name' };
  const script = wsPrelude(ws)
    + `m=$(git -C "$p" worktree remove --force ${shQuote(WT_DIR + '/' + name)} 2>&1); rc=$?; `
    + 'git -C "$p" worktree prune 2>/dev/null; '
    + 'printf "%s\\036%s" "$rc" "$m"';
  const out = await exec(script, 30000);
  if (out == null) return { ok: false, error: 'shell unreachable' };
  const [rc, msg] = splitRecords(out, 2);
  return rc.trim() === '0' ? { ok: true } : { ok: false, error: msg.trim() || 'could not remove the worktree' };
}

/* The full patch of a target's working tree against HEAD, for the review
 * popover, plus the untracked files no diff ever reports. Capped twice over: a
 * generated-file commit can run to megabytes, which would outgrow exec's buffer
 * (failing as "no changes") and then choke the renderer painting it. */
const PATCH_MAX = 400000;
const UNTRACKED_MAX = 200;

async function patch(target) {
  const script = wsPrelude(target)
    + 'command -v timeout >/dev/null && T="timeout 20" || T=""; '
    + '$T git -C "$p" diff HEAD 2>/dev/null; '
    + `printf '\\036'; `
    + `$T git -C "$p" ls-files --others --exclude-standard 2>/dev/null | head -n ${UNTRACKED_MAX}`;
  const out = await exec(script, 45000, { maxBuffer: 16 * 1024 * 1024 });
  if (out == null) return null;
  const [raw, untracked] = splitRecords(out, 2);
  const truncated = raw.length > PATCH_MAX;
  return {
    patch: truncated ? raw.slice(0, PATCH_MAX) : raw,
    truncated,
    untracked: untracked.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

/* Stage everything and commit. `add -A` is safe here in a way it would not be
 * in a shared checkout: an isolated worktree has exactly one agent in it. */
async function commit(target, message) {
  const msg = String(message || '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 500);
  if (!msg) return { ok: false, error: 'a commit needs a message' };
  const script = wsPrelude(target)
    + `m=$(git -C "$p" add -A 2>&1 && git -C "$p" commit -m ${shQuote(msg)} 2>&1); `
    + 'printf "%s\\036%s" "$?" "$m"';
  const out = await exec(script, 60000);
  if (out == null) return { ok: false, error: 'shell unreachable' };
  const [rc, text] = splitRecords(out, 2);
  return rc.trim() === '0' ? { ok: true, message: text.trim() } : { ok: false, error: text.trim() || 'commit failed' };
}

/* Merge an agent's branch into whatever the workspace has checked out.
 *
 * --no-ff so the agent's work stays a visible unit. A conflict is aborted
 * rather than left in the tree: a half-merged workspace is a state every other
 * feature in the app would then have to tolerate, and the conflicting paths are
 * more useful to hand back than a MERGE_HEAD nobody asked for. A dirty
 * workspace is refused up front, where the message can say why. */
async function merge(ws, branch) {
  if (!BRANCH_RE.test(String(branch || ''))) return { ok: false, error: 'invalid branch name' };
  const script = wsPrelude(ws)
    + 's=$(git -C "$p" status --porcelain 2>/dev/null | head -c1); '
    + '[ -n "$s" ] && { printf "2\\036%s\\036" "the workspace has uncommitted changes - commit or stash them first"; exit 0; }; '
    + `m=$(git -C "$p" merge --no-ff --no-edit ${shQuote(branch)} 2>&1); rc=$?; `
    + 'if [ $rc = 0 ]; then printf "0\\036%s\\036" "$m"; else '
    + 'u=$(git -C "$p" diff --name-only --diff-filter=U 2>/dev/null | head -n 50); '
    + 'git -C "$p" merge --abort 2>/dev/null; '
    + 'printf "1\\036%s\\036%s" "$m" "$u"; fi';
  const out = await exec(script, 60000);
  if (out == null) return { ok: false, error: 'shell unreachable' };
  const [rc, msg, conflicts] = splitRecords(out, 3);
  if (rc.trim() === '0') return { ok: true, message: msg.trim() };
  return {
    ok: false,
    error: msg.trim() || 'merge failed',
    conflicts: conflicts.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

module.exports = { create, list, remove, patch, commit, merge, worktreePath, slugify };
