const config = require('./config');
const { IS_WIN, exec, shQuote } = require('./platform');

/* Per-workspace git context (branch + dirty flag) for the pane chips.
 * One shell call per poll covers every workspace. `git status` can be slow
 * (a huge repo, or a Windows folder reached across /mnt/c) — a `timeout`
 * keeps one repo from stalling the whole sweep; the branch still shows and
 * dirtiness reads unknown. */

const POLL_MS = 15000;

/* Windows workspaces are stored as Windows paths and translated inside WSL
 * by wslpath, which handles \\wsl$\... shares that a regex would not. On
 * macOS the app and the shell share one filesystem, so the path is used
 * as-is. */
function wsScript(ws) {
  const wp = shQuote(ws.path);
  const printf = `printf '%s\\t%s\\t%s\\n' ${shQuote(ws.id)} "$b" "$d"`;
  /* A `status` that hit the timeout prints nothing, which is indistinguishable
   * from a clean tree by output alone — so the exit status decides, and a
   * timeout reports `unknown` rather than lying about a clean worktree.
   * `pipefail` (set once for the whole sweep) is what makes $? here the
   * *git* status and not head's. */
  const dirt = (dir) =>
    `s=$($T git -C ${dir} status --porcelain 2>/dev/null | head -c1); rc=$?; ` +
    `if [ -n "$s" ]; then d=dirty; elif [ "$rc" = 0 ]; then d=clean; else d=unknown; fi; `;
  if (IS_WIN) {
    return `p=$(wslpath -a ${wp} 2>/dev/null); ` +
      `b=$($T git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null); ` +
      `if [ -n "$b" ]; then ` + dirt('"$p"') +
      `${printf}; fi`;
  }
  return `b=$($T git -C ${wp} rev-parse --abbrev-ref HEAD 2>/dev/null); ` +
    `if [ -n "$b" ]; then ` + dirt(wp) +
    `${printf}; fi`;
}

/* Same wslpath dance as wsScript, for the one-shot helpers below: leaves the
 * repo path in $p (empty = unreachable, guarded by the callers' git -C). */
function wsPrelude(ws) {
  const wp = shQuote(ws.path);
  return IS_WIN
    ? `p=$(wslpath -a ${wp} 2>/dev/null); [ -n "$p" ] || exit 9; `
    : `p=${wp}; `;
}

/* Every branch a checkout could reach: local heads plus remote branches.
 * A quiet fetch first so branches created on the remote since the last
 * fetch appear; fetch failure (offline, no remote) just means the list may
 * be stale. strip=3 turns refs/remotes/origin/feature/x into feature/x. */
const FETCH_TTL_MS = 60000;
const lastFetch = new Map(); // workspace id -> when we last fetched it

async function listBranches(ws) {
  // every open of the chip's popover fetched, so four panes on one workspace
  // ran four concurrent fetches into one .git and each click waited on the
  // network. One fetch a minute is plenty for a new remote branch to appear.
  const fresh = Date.now() - (lastFetch.get(ws.id) || 0) < FETCH_TTL_MS;
  if (!fresh) lastFetch.set(ws.id, Date.now());
  const script = wsPrelude(ws) +
    'command -v timeout >/dev/null && T="timeout 10" || T=""; ' +
    (fresh ? '' : '$T git -C "$p" fetch -q 2>/dev/null; ') +
    `git -C "$p" for-each-ref --format='%(refname:short)' refs/heads; ` +
    `git -C "$p" for-each-ref --format='%(refname:strip=3)' refs/remotes`;
  const out = await exec(script, 25000);
  if (out == null) return null;
  const names = new Set();
  for (const line of out.split('\n')) {
    const b = line.trim();
    if (b && b !== 'HEAD') names.add(b); // origin/HEAD is a pointer, not a branch
  }
  return [...names].sort();
}

/* What the workspace has changed since HEAD, for the pane git chip's popover:
 * `git diff --stat` (staged and unstaged together, which is what "dirty" on
 * the chip actually means) plus a count of untracked files, which no diff
 * ever reports. The two answers are separated by a record separator rather
 * than a newline, since the stat itself is multi-line.
 *
 * A repo with no commits yet has no HEAD to diff against — git prints
 * nothing and the caller shows "no changes", which is close enough. */
async function diffStat(ws) {
  const script = wsPrelude(ws) +
    'command -v timeout >/dev/null && T="timeout 10" || T=""; ' +
    '$T git -C "$p" diff HEAD --stat=110,70 2>/dev/null; ' +
    "printf '\\036'; " +
    '$T git -C "$p" ls-files --others --exclude-standard 2>/dev/null | wc -l';
  // one --stat line per changed file outgrows exec's 1MB default on exactly
  // the repos this popover is most wanted on, and that failure reads as
  // "no changes"
  const out = await exec(script, 25000, { maxBuffer: 8 * 1024 * 1024 });
  if (out == null) return null;
  const sep = out.indexOf('\x1e');
  const stat = (sep === -1 ? out : out.slice(0, sep)).trim();
  const untracked = sep === -1 ? 0 : parseInt(out.slice(sep + 1).trim(), 10) || 0;
  return { stat, untracked };
}

/* git's own DWIM handles the remote case: checking out a name that only
 * exists as origin/<name> creates the local tracking branch. With create,
 * `checkout -b` starts a brand-new branch off the current HEAD instead. */
async function checkoutBranch(ws, branch, { create = false } = {}) {
  // renderer input crosses into a shell command line — re-validate here.
  // Leading alnum also blocks names that would parse as git options.
  if (!/^[A-Za-z0-9][\w./-]*$/.test(branch)) return { ok: false, error: 'invalid branch name' };
  const script = wsPrelude(ws) +
    `m=$(git -C "$p" checkout ${create ? '-b ' : ''}${shQuote(branch)} 2>&1); printf '%s\\n%s' "$?" "$m"`;
  const out = await exec(script, 25000);
  if (out == null) return { ok: false, error: 'shell unreachable' };
  const nl = out.indexOf('\n');
  const rc = out.slice(0, nl).trim();
  const msg = out.slice(nl + 1).trim();
  return rc === '0' ? { ok: true } : { ok: false, error: msg || 'checkout failed' };
}

class GitMonitor {
  constructor({ onUpdate, visible }) {
    this.onUpdate = onUpdate;
    this.visible = visible; // the chips exist to be looked at — skip the sweep while the window can't be seen
    this.timer = null;
    this.ticking = false;
    this.lastSig = null;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.ticking) return;
    // a poll sweep spawns a shell (wsl.exe on Windows) and runs git status
    // across every workspace, purely to paint chips — pointless while hidden.
    // main re-ticks on focus/restore so the chips catch up immediately.
    if (!this.visible()) return;
    this.ticking = true;
    try {
      const cfg = config.load();
      /* An isolated agent works in its own worktree (main/worktree.js), so its
       * pane must report that branch rather than the workspace's checkout —
       * same script, keyed by session id, which is what the renderer prefers
       * when the sweep carries one. Two more lines in the one script, not a
       * second poll. */
      const targets = (cfg.workspaces || []).concat(
        Object.values(cfg.sessions || {})
          .filter((m) => m.worktree && m.cwd)
          .map((m) => ({ id: m.id, path: m.cwd }))
      );
      const info = {};
      if (targets.length) {
        // macOS has no GNU timeout unless coreutils is installed; degrade to
        // running git unguarded rather than failing the whole sweep
        const script = 'set -o pipefail 2>/dev/null; ' +
          'command -v timeout >/dev/null && T="timeout 8" || T=""; ' +
          targets.map(wsScript).join('; ');

        const out = await exec(script, 25000);
        if (out == null) return; // shell unreachable — keep last known state
        for (const line of out.split('\n')) {
          const [id, branch, dirty] = line.split('\t');
          // null = the status timed out, so we genuinely don't know
          if (id && branch) info[id] = { branch, dirty: dirty === 'unknown' ? null : dirty === 'dirty' };
        }
      }
      // most sweeps find nothing changed — don't wake the renderer for a
      // payload identical to the last one
      const sig = JSON.stringify(info);
      if (sig !== this.lastSig) {
        this.lastSig = sig;
        this.onUpdate(info);
      }
    } finally {
      this.ticking = false;
    }
  }
}

// wsPrelude is shared with worktree.js rather than copied: the wslpath dance
// is the one piece of this file that is easy to get subtly wrong on Windows
module.exports = { GitMonitor, listBranches, checkoutBranch, diffStat, wsPrelude };
