const { execFile } = require('child_process');

/* Is WSL alive? Agents live inside it — if wsl.exe stops answering, every
 * attach client dies at once and the panes flip to "detached". The renderer
 * shows a banner off this signal so that mass-death reads as "WSL is down",
 * not ten simultaneous crashes. */

const POLL_MS = 20000;
const PROBE_TIMEOUT_MS = 8000;

class HealthMonitor {
  constructor({ onUpdate, debugLog, visible }) {
    this.onUpdate = onUpdate;
    this.debugLog = debugLog;
    this.visible = visible; // the banner exists to be seen — skip probes while the window isn't
    this.timer = null;
    this.last = null;
    this.ticking = false;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    if (this.ticking) return;
    // main re-ticks on focus/restore, so the banner catches up the moment
    // the window is visible again
    if (!this.visible()) return;
    this.ticking = true;
    execFile('wsl.exe', ['-e', 'sh', '-c', 'echo ok'], { timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      this.ticking = false;
      const wsl = !err && String(stdout).includes('ok');
      // push only on change — an identical payload every 20s is a wasted
      // renderer wake (the first probe always differs from last=null)
      if (this.last !== wsl) {
        this.last = wsl;
        this.debugLog('[health] wsl ' + (wsl ? 'ok' : 'UNREACHABLE'));
        this.onUpdate({ wsl });
      }
    });
  }
}

module.exports = { HealthMonitor };
