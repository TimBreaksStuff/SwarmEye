const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { IS_WIN, exec, shQuote, toShellPath } = require('./platform');

/* Precise agent state via Claude Code hooks instead of output-timing guesses.
 * Every spawned claude gets `--settings <hook-settings.json>` whose hooks
 * pipe their stdin JSON into <userData>/hook-state/<sessionId>.json, which
 * the main process watches. On Windows that dir lives on the Windows side
 * and is reachable from WSL as /mnt/..., so fs.watch still works natively. Last event wins: UserPromptSubmit / PreToolUse =
 * working, Notification = waiting on the user, Stop = turn finished.
 *
 * The model in use is NOT part of the common hook payload (verified against
 * a real session — SessionStart's schema has a `model` field but it comes
 * through empty in practice). The reliable source is each session's own
 * transcript JSONL, whose assistant entries carry `message.model` — every
 * hook event already includes `transcript_path`, so on every Stop (turn
 * boundary) we tail that file and pull the latest one. */

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionStart'];
const TRANSCRIPT_TAIL_BYTES = 60000;

/* Read only the last N bytes of the transcript — these files can grow to
 * several MB, and we only need the newest assistant message.model.
 *
 * Windows reads it through the shell: the transcript belongs to the copy of
 * Claude Code running inside WSL, so its path is a WSL path that the Windows
 * fs APIs cannot open. One round trip per turn boundary is cheap. */
function tailFile(filePath, maxBytes) {
  if (IS_WIN) return exec(`tail -c ${maxBytes} ${shQuote(filePath)} 2>/dev/null`, 15000);
  return new Promise((resolve) => {
    fs.open(filePath, 'r', (err, fd) => {
      if (err) return resolve(null);
      fs.fstat(fd, (err2, stats) => {
        if (err2) { fs.close(fd, () => {}); return resolve(null); }
        const start = Math.max(0, stats.size - maxBytes);
        const length = stats.size - start;
        const buf = Buffer.alloc(length);
        fs.read(fd, buf, 0, length, start, (err3) => {
          fs.close(fd, () => {});
          resolve(err3 ? null : buf.toString('utf8'));
        });
      });
    });
  });
}

class HookMonitor {
  constructor({ onEvent, debugLog }) {
    this.onEvent = onEvent;
    this.debugLog = debugLog;
    this.stateDir = path.join(app.getPath('userData'), 'hook-state');
    this.settingsFile = path.join(app.getPath('userData'), 'hook-settings.json');
    this.seen = new Map(); // filename -> mtimeMs already processed
    this.models = new Map(); // sessionId -> last known model id (from the transcript)
    this.watcher = null;
    this.sweepTimer = null;
  }

  init() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      // stale state from the previous run must not replay as fresh events
      for (const f of fs.readdirSync(this.stateDir)) {
        try { fs.unlinkSync(path.join(this.stateDir, f)); } catch { /* ignore */ }
      }
      const command =
        'cat > "$SWARMEYE_STATE_DIR/$SWARMEYE_SESSION.json.tmp" && ' +
        'mv -f "$SWARMEYE_STATE_DIR/$SWARMEYE_SESSION.json.tmp" "$SWARMEYE_STATE_DIR/$SWARMEYE_SESSION.json"';
      const hooks = {};
      for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command }] }];
      fs.writeFileSync(this.settingsFile, JSON.stringify({ hooks }, null, 2), 'utf8');
    } catch (err) {
      this.debugLog('[hooks] init FAILED — falling back to heuristics: ' + err.message);
      return;
    }

    // fs.watch for instant reaction, plus a slow sweep in case events get lost
    try {
      this.watcher = fs.watch(this.stateDir, () => this.sweep());
    } catch { /* sweep alone still works */ }
    this.sweepTimer = setInterval(() => this.sweep(), 3000);
    this.debugLog('[hooks] watching ' + this.stateDir);
  }

  /* Wrap the claude command line so its hooks know where to report.
   * Returns baseCmd unchanged when hook paths can't be expressed safely
   * (they end up inside a single-quoted tmux command). */
  claudeCmd(sessionId, baseCmd) {
    const stateDir = toShellPath(this.stateDir);
    const settings = toShellPath(this.settingsFile);
    if (!stateDir || !settings || /'/.test(stateDir + settings)) return baseCmd;
    return `env SWARMEYE_SESSION=${sessionId} SWARMEYE_STATE_DIR="${stateDir}" ` +
           `${baseCmd} --settings "${settings}"`;
  }

  sweep() {
    let files;
    try { files = fs.readdirSync(this.stateDir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue; // skip .tmp mid-write files
      const full = path.join(this.stateDir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      // mtimeMs alone is too coarse on some filesystems (e.g. WSL's 9p mount
      // for /mnt/c) — two writes landing in the same tick would otherwise
      // look identical and the second event gets dropped forever. Size is a
      // cheap second signal that catches most of those same-tick cases.
      const stamp = st.mtimeMs + ':' + st.size;
      if (this.seen.get(f) === stamp) continue;
      let payload;
      // only mark the stamp as seen once the file actually parsed — a read
      // that races the hook's write would otherwise drop that event forever
      // instead of retrying on the next sweep
      try { payload = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      this.seen.set(f, stamp);
      const sessionId = f.slice(0, -'.json'.length);
      const event = payload.hook_event_name;
      if (!HOOK_EVENTS.includes(event)) continue;
      if (event === 'Stop' && payload.transcript_path) {
        this.refreshModelFromTranscript(sessionId, payload.transcript_path);
      }
      this.onEvent(sessionId, {
        event,
        tool: typeof payload.tool_name === 'string' ? payload.tool_name.slice(0, 40) : null,
        message: typeof payload.message === 'string' ? payload.message.slice(0, 200) : null,
        model: this.models.get(sessionId) || null,
      });
    }
  }

  /* Tail the transcript and pull the newest assistant `message.model`. Fires
   * once per Stop event (turn boundary), not per tool call. On success,
   * pushes a follow-up event so the renderer's chip catches up even though
   * this resolves after the Stop event itself was emitted. */
  async refreshModelFromTranscript(sessionId, transcriptPath) {
    const text = await tailFile(transcriptPath, TRANSCRIPT_TAIL_BYTES);
    if (!text) return;
    const matches = [...text.matchAll(/"model":"([^"]*)"/g)].map((m) => m[1]);
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i] && matches[i] !== '<synthetic>') {
        if (this.models.get(sessionId) === matches[i]) return; // unchanged
        this.models.set(sessionId, matches[i]);
        this.onEvent(sessionId, { event: 'ModelUpdate', tool: null, message: null, model: matches[i] });
        return;
      }
    }
  }

  /* A killed/exited session must not leave a state file behind. */
  cleanup(sessionId) {
    if (!/^[A-Za-z0-9_]+$/.test(sessionId)) return;
    this.seen.delete(sessionId + '.json');
    this.models.delete(sessionId);
    try { fs.unlinkSync(path.join(this.stateDir, sessionId + '.json')); } catch { /* ignore */ }
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    clearInterval(this.sweepTimer);
  }
}

module.exports = { HookMonitor };
