const { app } = require('electron');
const path = require('path');
const config = require('./config');
const { exec, shQuote } = require('./platform');
const { shPathVar } = require('./git');

/* One git worktree per agent, so a swarm can edit the same repo at once.
 *
 * Without this every agent in a workspace shares one checkout, which is why
 * the orchestrator's brief has to tell its lead "never give two workers the
 * same file" — a rule nothing enforces and a wave of eight can break by
 * accident. With it each agent gets its own branch and its own tree, and the
 * rule is structural rather than advisory.
 *
 * It is one option ("Isolate agents in git worktrees", ⚙ Options) and nothing
 * else: there is no per-workspace switch, no branch to name, no merge to
 * approve. Off the shelf, an agent gets a tree, its work is committed on its
 * own branch, and closing its pane lands that branch back on the branch it
 * came from.
 *
 * The registry lives in config.json (`agentWorktrees`), **not** in the session
 * metadata, because that metadata is dropped the moment an agent exits — and a
 * pane that exited by itself still owns a tree that has to be landed when the
 * user finally closes it. Keying by session id in a file of its own also means
 * a crash leaves something to reconcile against at the next boot.
 *
 * Everything here reaches a shell command line: repo paths, worktree paths and
 * branch names all go through shQuote/shPathVar, and the branch name is built
 * from a whitelist rather than passed through. */

const ROOT = () => path.join(app.getPath('userData'), 'worktrees');

/* An identity for the tidy-up commit, used only when the repo has none of its
 * own — committing with `-c user.email=...` when the user has configured an
 * identity would put the wrong name on their history. */
const IDENT = "-c user.name='SwarmEye' -c user.email='swarmeye@localhost'";

function enabled() {
  return !!config.load().worktrees;
}

function registry() {
  return config.load().agentWorktrees || {};
}

function remember(sessionId, wt) {
  config.patch({ agentWorktrees: { ...registry(), [sessionId]: wt } });
}

function forget(sessionId) {
  const all = { ...registry() };
  delete all[sessionId];
  config.patch({ agentWorktrees: all });
}

function get(sessionId) {
  return registry()[sessionId] || null;
}

const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

/* `swarmeye/<agent>-<token>` — one namespace, so `git branch --list
 * 'swarmeye/*'` is the whole answer to "what did the swarm leave behind".
 * The token is minted here rather than taken from the session id: the tree has
 * to exist before `spawn()` runs (that is what the agent chdirs into) and the
 * id does not exist until it returns. `attach()` files it under the id a
 * moment later. */
function branchFor(agentName, token) {
  const slug = String(agentName || 'agent').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
  return `swarmeye/${slug}-${token}`;
}

/* A fresh checkout has none of the files git was told to ignore, which for a
 * Node repo means the agent's first command fails on a missing `node_modules`
 * and its first run of the app fails on a missing `.env`. Both are carried
 * over as part of creating the tree: the modules by symlink (they are large,
 * and every agent wants the same ones), the env files by copy (they are small,
 * and an agent that rewrites one must not rewrite the user's).
 *
 * Only what the repo already ignores is carried, checked with `check-ignore`
 * rather than assumed — a `.env.example` that is under version control is in
 * the checkout already, and copying over it would hand the agent a file its
 * own repo disagrees with.
 *
 * The `node_modules` symlink is the exception that has to be tracked: the
 * usual `node_modules/` ignore rule matches a *directory* and not a symlink,
 * so git sees the link we just made as a new untracked file and the retire
 * below would commit it into the user's history. That is why create() reports
 * whether it made one — see `carriedModules`, which is what keeps it out of
 * the commit.
 *
 * Nothing else is carried. This is the one piece of the feature that guesses,
 * and it guesses only at the two things that stop a repo from building. */
const CARRY = 'NM=0; if [ -d "$p/node_modules" ] && [ ! -e "$w/node_modules" ] && git -C "$p" check-ignore -q node_modules; then '
  + 'ln -s "$p/node_modules" "$w/node_modules" 2>/dev/null && NM=1; fi; '
  // `find` rather than a `.env*` glob: exec runs these through the user's
  // login shell, which on macOS is zsh, and zsh treats a glob that matches
  // nothing as a fatal error — a repo without a .env would abort the whole
  // script and the agent would silently get no worktree at all
  + 'find "$p" -maxdepth 1 -type f -name ".env*" -print0 2>/dev/null | while IFS= read -r -d "" f; do '
  + 'b=$(basename "$f"); if git -C "$p" check-ignore -q "$b"; then cp "$f" "$w/$b" 2>/dev/null; fi; done; '

/* Give this session its own tree, or answer null and let it run in the
 * workspace itself. Null is the honest answer for a folder that is not a repo,
 * a repo with no commit to branch from, and a checkout sitting on a detached
 * HEAD — in each case there is no branch to come back to, and a silent
 * fallback to the shared checkout is what the old behaviour already was.
 *
 * Failure is never fatal: the agent still launches, the pane just shows the
 * workspace's branch like it always did. */
async function create(ws, agentName, debugLog = () => {}) {
  if (!enabled()) return null;
  const token = Math.random().toString(36).slice(2, 10);
  const branch = branchFor(agentName, token);
  const dir = path.join(ROOT(), safeId(ws.id), token);
  const script = shPathVar('p', ws.path) + shPathVar('w', dir)
    // `git worktree add` makes the leaf, not the workspace folder above it
    + 'mkdir -p "$(dirname "$w")" 2>/dev/null; '
    // a detached HEAD reports "HEAD", which is not a branch to merge back into
    + 'base=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null); '
    + '[ -n "$base" ] && [ "$base" != HEAD ] || exit 3; '
    + `git -C "$p" worktree add -b ${shQuote(branch)} "$w" HEAD >/dev/null 2>&1 || exit 4; `
    + CARRY
    + `printf '%s\\t%s' "$base" "$NM"`;
  const out = await exec(script, 60000);
  if (out == null) { debugLog('[worktree] shell unreachable for ' + ws.path); return null; }
  const [base, nm] = out.trim().split('\t');
  if (!base) { debugLog('[worktree] no worktree for ' + ws.path + ' (not a repo, no commits, or detached HEAD)'); return null; }
  const wt = { path: dir, branch, base, repo: ws.path, workspaceId: ws.id, carriedModules: nm === '1' };
  debugLog(`[worktree] cut ${branch} off ${base} at ${dir}`);
  return wt;
}

/* File a tree under the session that ended up running in it. Split from
 * create() because the id is minted by the spawn the tree is *for*. */
function attach(sessionId, wt) {
  if (wt) remember(sessionId, wt);
  return wt;
}

/* The launch the tree was cut for never happened (the agent cap, a dead
 * workspace folder, a pty that refused to spawn). Nothing has run in it, so
 * there is nothing to land — take it away rather than leave a branch nobody
 * can explain. */
async function discard(wt, debugLog = () => {}) {
  if (!wt) return;
  const script = shPathVar('p', wt.repo) + shPathVar('w', wt.path)
    + 'git -C "$p" worktree remove --force "$w" >/dev/null 2>&1; '
    + `git -C "$p" branch -D ${shQuote(wt.branch)} >/dev/null 2>&1; true`;
  await exec(script, 60000);
  debugLog('[worktree] discarded ' + wt.branch);
}

/* A restart keeps the tree the conversation was held in — the resumed
 * transcript is keyed by cwd (see claudeProjectDirName), and the work in
 * progress is in there. */
function inherit(oldId, newId) {
  const wt = get(oldId);
  if (!wt) return null;
  forget(oldId);
  remember(newId, wt);
  return wt;
}

/* Land the agent's work and take the tree away.
 *
 * Four outcomes, and every one of them is reported rather than assumed:
 *  - `empty`  — the agent changed nothing; tree and branch are removed.
 *  - `merged` — its commits are on the base branch; tree and branch removed.
 *  - `kept`   — the merge could not be made safely, so the branch stays and
 *               the caller says its name. Reasons: the workspace has moved to
 *               another branch since the agent started, or the merge itself
 *               refused (a conflict, or local edits in the way).
 *  - `gone`   — nothing left to retire.
 *
 * A merge is never forced and a conflict is never resolved here: `merge
 * --abort` puts the checkout back exactly as it was and the branch is left for
 * the user. Nothing is deleted while it still holds work — `branch -d` (not
 * -D) is what removes the branch after a merge, and it refuses anything
 * unmerged. */
async function retire(sessionId, debugLog = () => {}) {
  const wt = get(sessionId);
  if (!wt) return null;
  forget(sessionId);
  const br = shQuote(wt.branch);
  const script = shPathVar('p', wt.repo) + shPathVar('w', wt.path)
    + 'if [ ! -d "$w" ]; then git -C "$p" worktree prune >/dev/null 2>&1; printf gone; exit 0; fi; '
    // whatever the agent left uncommitted is its work too — commit it before
    // measuring, or a stopped agent's edits would read as "changed nothing"
    + `if [ -n "$(git -C "$w" status --porcelain -- .${wt.carriedModules ? " ':(exclude)node_modules'" : ''} 2>/dev/null)" ]; then `
    + 'if [ -n "$(git -C "$w" config user.email)" ]; then I=""; else I="' + IDENT + '"; fi; '
    // `.` plus the carried symlink excluded, never a bare `add -A`: the link
    // to the workspace's node_modules is untracked *and* unignored (see CARRY)
    // and would otherwise be committed into the user's history
    + `git -C "$w" add -A -- .${wt.carriedModules ? " ':(exclude)node_modules'" : ''} >/dev/null 2>&1; `
    + `git -C "$w" $I commit -q -m ${shQuote('SwarmEye: ' + wt.branch)} >/dev/null 2>&1; fi; `
    + `ahead=$(git -C "$p" rev-list --count ${shQuote(wt.base)}..${br} 2>/dev/null); `
    + 'if [ "$ahead" = 0 ] || [ -z "$ahead" ]; then '
    + 'git -C "$p" worktree remove --force "$w" >/dev/null 2>&1; '
    + `git -C "$p" branch -D ${br} >/dev/null 2>&1; printf empty; exit 0; fi; `
    + 'cur=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null); '
    + `if [ "$cur" != ${shQuote(wt.base)} ]; then printf 'kept\\tmoved'; exit 0; fi; `
    + `if git -C "$p" merge --no-ff -m ${shQuote('SwarmEye: merge ' + wt.branch)} ${br} >/dev/null 2>&1; then `
    + 'git -C "$p" worktree remove --force "$w" >/dev/null 2>&1; '
    + `git -C "$p" branch -d ${br} >/dev/null 2>&1; printf 'merged\\t%s' "$ahead"; `
    + `else git -C "$p" merge --abort >/dev/null 2>&1; printf 'kept\\tblocked'; fi`;
  const out = await exec(script, 120000);
  if (out == null) {
    // the shell never answered: the tree is still on disk with the work in it,
    // so put it back in the registry for the next boot to reconcile
    remember(sessionId, wt);
    debugLog('[worktree] retire unreachable for ' + wt.branch);
    return { state: 'kept', reason: 'unreachable', branch: wt.branch, base: wt.base };
  }
  const [state, detail] = out.trim().split('\t');
  debugLog(`[worktree] retire ${sessionId} ${wt.branch} -> ${state}${detail ? ' ' + detail : ''}`);
  return {
    state,
    reason: state === 'kept' ? detail : null,
    commits: state === 'merged' ? Number(detail) || 0 : 0,
    branch: wt.branch,
    base: wt.base,
  };
}

/* Boot: trees whose agent is gone. A crash, a kill from outside the app, or a
 * pane closed while SwarmEye wasn't running all leave one behind — each still
 * holding work nobody has landed. Retiring them here is the same decision the
 * pane's ✕ makes, taken late. */
async function reconcile(liveIds, debugLog = () => {}) {
  const live = new Set(liveIds || []);
  const out = [];
  for (const id of Object.keys(registry())) {
    if (live.has(id)) continue;
    const res = await retire(id, debugLog);
    if (res) out.push(res);
  }
  return out;
}

module.exports = { create, attach, discard, inherit, retire, reconcile, get, enabled };
