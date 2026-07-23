const { execLogin } = require('./platform');

/* Auto-install of the Pi coding agent (github.com/earendil-works/pi) behind
 * the ⌨ Options "Enable Pi coding agent" toggle. Pi publishes standalone
 * per-platform binaries on its GitHub releases, so nothing else is required
 * in the agents' shell — in particular no Node/npm, which the official
 * install.sh would need and a stock WSL doesn't have.
 *
 * The managed copy lives in ~/.swarmeye/pi-agent with a symlink at
 * ~/.local/bin/pi, which login shells (how sessions.js spawns agents) have
 * on PATH. A pi the user installed some other way is detected by its path
 * and left alone. Everything here runs through execLogin so the check
 * agrees with what a spawned agent will actually find. */

/* PATH first, managed path second — the same order sessions.js piCmd() uses
 * to launch, so this reports exactly what a pane would run. The explicit
 * fallback matters on macOS, where no default PATH entry is user-writable
 * and the managed copy is only ever reachable by its full path. */
async function status() {
  const out = await execLogin(
    `p=$(command -v pi) || p=; ` +
    `if [ -z "$p" ] && [ -x "$HOME/.swarmeye/pi-agent/pi" ]; then p=$HOME/.swarmeye/pi-agent/pi; fi; ` +
    `[ -z "$p" ] && exit 0; echo "$p"; "$p" --version 2>/dev/null | head -1`
  );
  const [binPath, version] = (out || '').split('\n').map((s) => s.trim());
  if (!binPath) return { installed: false };
  return {
    installed: true,
    path: binPath,
    version: version || null,
    managed: binPath.endsWith('/.local/bin/pi') || binPath.endsWith('/.swarmeye/pi-agent/pi'),
  };
}

/* uname decides the release asset, so the one command string serves WSL
 * (linux) and macOS (darwin) alike. Extracted next to the final location and
 * swapped in only after the binary is confirmed present, so a failed
 * download can't wipe a working install. */
const INSTALL_SCRIPT =
  'plat=linux; [ "$(uname -s)" = Darwin ] && plat=darwin; ' +
  'arch=x64; case "$(uname -m)" in arm64|aarch64) arch=arm64;; esac; ' +
  'rm -rf ~/.swarmeye/pi-dl && mkdir -p ~/.swarmeye/pi-dl ~/.local/bin && ' +
  'curl -fsSL "https://github.com/earendil-works/pi/releases/latest/download/pi-$plat-$arch.tar.gz" | tar -xz -C ~/.swarmeye/pi-dl && ' +
  'test -x ~/.swarmeye/pi-dl/pi/pi && ' +
  'rm -rf ~/.swarmeye/pi-agent && mv ~/.swarmeye/pi-dl/pi ~/.swarmeye/pi-agent && rm -rf ~/.swarmeye/pi-dl && ' +
  'ln -sf ~/.swarmeye/pi-agent/pi ~/.local/bin/pi';

/* Install or update the managed copy to the latest GitHub release (~40 MB,
 * hence the generous timeout). An externally-installed pi short-circuits. */
async function ensure() {
  const before = await status();
  if (before.installed && !before.managed) return { ok: true, external: true, ...before };
  // the || marker keeps the shell exit code 0 so execLogin hands back the
  // error output instead of collapsing everything to null
  const out = await execLogin(`(${INSTALL_SCRIPT}) 2>&1 || echo SWARMEYE-PI-FAIL`, 300000);
  const lines = (out || '').trim().split('\n').filter(Boolean);
  if (out == null || lines.includes('SWARMEYE-PI-FAIL')) {
    const detail = lines.filter((l) => l !== 'SWARMEYE-PI-FAIL').slice(-2).join(' · ');
    return { ok: false, error: detail || 'download failed — is the network up and curl installed?' };
  }
  const after = await status();
  if (!after.installed) return { ok: false, error: 'download finished, but the pi binary did not land' };
  return { ok: true, updated: before.installed, ...after };
}

module.exports = { status, ensure };
