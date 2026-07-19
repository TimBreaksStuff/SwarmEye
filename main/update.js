/* Update check: read package.json from the Gitea repo and compare versions.
 * Purely informational — on a newer version the renderer shows a pill that
 * links to the repo. Any network/TLS failure (homelab certs…) stays silent. */

const REPO_URL = 'https://gitea.homelabproxy.duckdns.org/root/SwarmEye';
const RAW_PKG_URL = REPO_URL + '/raw/branch/main/package.json';
const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;

/* numeric collation compares 0.10 above 0.9, which a plain string compare
 * gets backwards and a hand-rolled split/parse loop needs a dozen lines to
 * get right */
function isNewer(remote, local) {
  return String(remote).localeCompare(String(local), undefined, { numeric: true }) > 0;
}

class UpdateChecker {
  constructor({ current, onAvailable, debugLog }) {
    this.current = current;
    this.onAvailable = onAvailable;
    this.debugLog = debugLog;
    this.firstTimer = null;
    this.timer = null;
  }

  start() {
    this.firstTimer = setTimeout(() => this.tick(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.tick(), CHECK_MS);
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  async tick() {
    try {
      const res = await fetch(RAW_PKG_URL, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const pkg = await res.json();
      if (pkg && typeof pkg.version === 'string' && isNewer(pkg.version, this.current)) {
        this.debugLog('[update] ' + pkg.version + ' available (running ' + this.current + ')');
        this.onAvailable({ version: pkg.version, url: REPO_URL });
      }
    } catch { /* unreachable/self-signed — never bother the user */ }
  }
}

module.exports = { UpdateChecker };
