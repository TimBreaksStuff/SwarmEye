const path = require('path');
const { exec, spawnShell, spawnScript } = require('./platform');

/* Dictation backend bridge. Chromium's webkitSpeechRecognition is dead in
 * Electron (its cloud backend needs Google API keys Electron doesn't ship;
 * every session ends in error:network), so the renderer captures mic audio
 * itself and streams base64 lines of 16 kHz 16-bit mono PCM here. We pipe
 * them into a Whisper (faster-whisper) recognizer — provisioned by
 * scripts/setup-stt.sh into ~/.local/share/swarmeye/stt, inside WSL on
 * Windows — and forward its partial/final text back. Fully offline; audio
 * never leaves the machine. One recognizer process at a time, matching the
 * renderer's one-dictation-app-wide invariant. */

const STT_CMD =
  'S="$HOME/.local/share/swarmeye/stt"; exec "$S/venv/bin/python" "$S/stt-stream.py" "$S/model" 16000';
const STT_CHECK =
  'test -x "$HOME/.local/share/swarmeye/stt/venv/bin/python" && test -f "$HOME/.local/share/swarmeye/stt/model/model.bin"';

class SpeechBridge {
  constructor({ send, debugLog }) {
    this.send = send; // (channel, payload) => void, no-op if window is gone
    this.debugLog = debugLog;
    this.proc = null;
    this.ready = false; // recognizer model loaded
    this.pending = []; // audio lines received before ready
    this.stopRequested = false;
    this.checked = null; // cached install check (promise)
    this.installing = false;
  }

  available() {
    if (!this.checked) {
      this.checked = exec(STT_CHECK, 10000).then((out) => out !== null);
    }
    return this.checked;
  }

  /* Runs setup-stt.sh from the ⌨ Options panel, streaming its output back so a
   * multi-minute model download isn't a frozen button. Same script the
   * `npm run setup:stt` path uses, so both routes behave identically —
   * including the prereq checks, which have to live in the script rather than
   * here (on Windows this process is on the wrong side of the WSL boundary
   * to see whether python3 exists). */
  _scriptPath() {
    // asar can't be executed from, and electron-builder unpacks scripts/ next
    // to it — see asarUnpack in package.json
    return path.join(__dirname, '..', 'scripts', 'setup-stt.sh').replace('app.asar', 'app.asar.unpacked');
  }

  install() {
    if (this.installing) return Promise.resolve({ ok: false, reason: 'busy' });
    this.installing = true;
    return new Promise((resolve) => {
      // Windows-only: a script path that can't be expressed as a WSL path.
      // Clear the flag before bailing or the Install button stays dead until
      // the app restarts.
      const proc = spawnScript(this._scriptPath());
      if (!proc) {
        this.installing = false;
        return resolve({ ok: false, reason: 'path' });
      }
      const done = (res) => {
        if (!this.installing) return;
        this.installing = false;
        // a fresh install must be visible without an app restart, and a failed
        // one must not leave a cached false behind
        this.checked = res.ok ? Promise.resolve(true) : null;
        resolve(res);
      };
      // stderr carries the prereq "fix:" lines — the most useful output there
      // is — so both streams go to the same log
      for (const stream of [proc.stdout, proc.stderr]) {
        let buf = '';
        stream.on('data', (d) => {
          buf += d.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            this.send('speech:install-progress', { line });
          }
        });
      }
      proc.on('error', (err) => {
        this.debugLog('[speech] install spawn error: ' + err.message);
        this.send('speech:install-progress', { line: 'could not run the setup script: ' + err.message });
        done({ ok: false, reason: 'spawn' });
      });
      proc.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, reason: 'failed', code }));
    });
  }

  // id: opaque renderer-chosen session tag, echoed in every event so a late
  // event from a superseded recognizer can't be mistaken for the current one
  async start(id) {
    if (!(await this.available())) return { ok: false, reason: 'not-installed' };
    this._kill(); // a stale recognizer must not answer for the new session
    this.ready = false;
    this.pending = [];
    this.stopRequested = false;

    const sid = id;
    const proc = spawnShell(STT_CMD);
    this.proc = proc;

    let buf = '';
    proc.stdout.on('data', (d) => {
      if (this.proc !== proc) return;
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) {
          this.ready = true;
          for (const b64 of this.pending) proc.stdin.write(b64 + '\n');
          this.pending = [];
          if (this.stopRequested) proc.stdin.end();
        } else if (msg.text) {
          this.send('speech:result', { id: sid, text: msg.text, isFinal: true });
        } else if (msg.partial) {
          this.send('speech:result', { id: sid, text: msg.partial, isFinal: false });
        }
      }
    });
    // drain stderr so a chatty backend can never fill the pipe and stall
    proc.stderr.on('data', (d) => this.debugLog('[speech] ' + d));
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.debugLog('[speech] spawn error: ' + err.message);
      this.proc = null;
      this.send('speech:error', { id: sid, code: 'backend' });
      this.send('speech:end', { id: sid });
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      // non-zero exit without a stop is a backend crash, not a finished phrase
      if (code !== 0 && !this.stopRequested) this.send('speech:error', { id: sid, code: 'backend' });
      this.send('speech:end', { id: sid });
    });
    return { ok: true };
  }

  feed(b64) {
    if (!this.proc || typeof b64 !== 'string') return;
    if (!this.ready) { this.pending.push(b64); return; }
    this.proc.stdin.write(b64 + '\n');
  }

  // graceful stop: EOF makes the recognizer flush the final phrase, then exit
  stop() {
    if (!this.proc || this.stopRequested) return;
    this.stopRequested = true;
    if (this.ready) this.proc.stdin.end();
  }

  _kill() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null; // detach first so its close handler stays silent
    try { proc.kill(); } catch { /* already gone */ }
  }
}

module.exports = { SpeechBridge };
