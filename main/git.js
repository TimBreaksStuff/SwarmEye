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
  const printf = `printf '%s\\t%s\\t%s\\n' ${shQuote(ws.id)} "$b" "\${s:+dirty}"`;
  if (IS_WIN) {
    return `p=$(wslpath -a ${wp} 2>/dev/null); ` +
      `b=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null); ` +
      `if [ -n "$b" ]; then ` +
      `s=$($T git -C "$p" status --porcelain 2>/dev/null | head -c1); ` +
      `${printf}; fi`;
  }
  return `b=$(git -C ${wp} rev-parse --abbrev-ref HEAD 2>/dev/null); ` +
    `if [ -n "$b" ]; then ` +
    `s=$($T git -C ${wp} status --porcelain 2>/dev/null | head -c1); ` +
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
 * A quiet fetch first so branches created on GitHub/Gitea since the last
 * fetch appear; fetch failure (offline, no remote) just means the list may
 * be stale. strip=3 turns refs/remotes/origin/feature/x into feature/x. */
async function listBranches(ws) {
  const script = wsPrelude(ws) +
    'command -v timeout >/dev/null && T="timeout 10" || T=""; ' +
    '$T git -C "$p" fetch -q 2>/dev/null; ' +
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
  constructor({ onUpdate }) {
    this.onUpdate = onUpdate;
    this.timer = null;
    this.ticking = false;
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
    this.ticking = true;
    try {
      const workspaces = config.load().workspaces || [];
      if (!workspaces.length) { this.onUpdate({}); return; }

      // macOS has no GNU timeout unless coreutils is installed; degrade to
      // running git unguarded rather than failing the whole sweep
      const script = 'command -v timeout >/dev/null && T="timeout 8" || T=""; ' +
        workspaces.map(wsScript).join('; ');

      const out = await exec(script, 25000);
      if (out == null) return; // shell unreachable — keep last known state
      const info = {};
      for (const line of out.split('\n')) {
        const [id, branch, dirty] = line.split('\t');
        if (id && branch) info[id] = { branch, dirty: dirty === 'dirty' };
      }
      this.onUpdate(info);
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = { GitMonitor, listBranches, checkoutBranch };
