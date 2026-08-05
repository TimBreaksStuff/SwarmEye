const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
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
 * boundary) we read that file and pull the latest one.
 *
 * Those same entries carry `message.usage`, which is where the pane's cost
 * and context panel comes from: tokens, the cache read/write split, and the
 * size of the prompt the newest turn actually sent (= the live context). The
 * read is incremental — only the bytes appended since the previous turn — so
 * the per-turn cost of all of this is one small read. */

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionStart'];

/* ---- two agents editing one file ----
 *
 * The tools that change a file, and the `tool_input` field each keeps its path
 * in. Read/Grep/Glob are deliberately absent: two agents reading one file
 * collide over nothing, and recording every read would make the map below
 * enormous for no signal.
 *
 * PreToolUse fires *before* the write lands, so the second agent is flagged
 * while its edit is still being made rather than after both have written.
 * Observability only — nothing is blocked and no lock is taken; the pane says
 * who else is in the file and leaves the decision to the user. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/* How long another agent's write stays interesting. Long enough to catch "we
 * are both working on this right now", short enough that a file two agents
 * touched hours apart stops being reported. */
const COLLISION_WINDOW_MS = 30 * 60 * 1000;

/* Distinct paths remembered before stale ones get swept. A busy swarm writes a
 * few hundred files an hour; this only has to stay bounded, not be exact. */
const TOUCH_PATHS_MAX = 2000;

function writeTarget(payload) {
  if (!WRITE_TOOLS.has(payload.tool_name)) return null;
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return null;
  const p = input.file_path || input.notebook_path;
  return typeof p === 'string' && p ? p.slice(0, 300) : null;
}

/* Shaped like every other hook event so the renderer's one handler can take it
 * — a bookkeeping event, like UsageUpdate, that says nothing about the agent's
 * own working/waiting state. */
function collisionEvent(file, others) {
  return { event: 'Collision', tool: null, message: null, model: null, collision: { file, others } };
}

/* How much transcript to parse in one go. Only bytes appended since the last
 * turn are read, so this cap only bites on the first read of a long session
 * reattached from a previous run: its oldest turns then fall outside the
 * totals, which is what the `partial` flag tells the renderer. */
const USAGE_MAX_READ = 4 * 1024 * 1024;
const USAGE_SERIES_MAX = 60; // burn-sparkline points kept per session

/* How many already-counted message ids to remember per session. A message's
 * repeated lines are adjacent, so a small window is plenty — this only has to
 * outlive the handful of lines one assistant turn writes. */
const USAGE_SEEN_MAX = 400;

/* Coalescing window for writing the totals back to config.json. */
const USAGE_PERSIST_MS = 3000;

/* How much of an agent's closing message rides along to the task card. Long
 * enough for a real "here's what I changed", short enough that config.json
 * (where completed tasks live) doesn't grow by a page per task. */
const SUMMARY_MAX = 600;

/* List price per million tokens, matched against the model id. Cache reads
 * bill at 0.1x input; cache writes at 1.25x (5-minute TTL) or 2x (1-hour) —
 * the transcript reports that split per entry, so the cost is exact rather
 * than an average. An id that matches nothing falls back to Sonnet-tier
 * instead of guessing high. (Sonnet 5's introductory rate is lower than the
 * list price used here, which makes its cost an upper bound until that
 * promotion ends.) */
const MODEL_PRICES = [
  [/fable|mythos/, { input: 10, output: 50 }],
  [/opus/, { input: 5, output: 25 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku/, { input: 1, output: 5 }],
];
const FALLBACK_PRICE = { input: 3, output: 15 };

function priceFor(model) {
  const id = String(model || '');
  for (const [re, price] of MODEL_PRICES) if (re.test(id)) return price;
  return FALLBACK_PRICE;
}

/* The transcript bytes appended since `offset`, plus the file's current size.
 *
 * Windows reads it through the shell: the transcript belongs to the copy of
 * Claude Code running inside WSL, so its path is a WSL path that the Windows
 * fs APIs cannot open. Size and payload come back from a single round trip —
 * first line is the size, everything after it is the data.
 *
 * A file that grew by more than `maxBytes` yields only its tail, and says so
 * with `truncated` — the caller's running totals are a lower bound from then
 * on rather than silently wrong. */
function readNew(filePath, offset, maxBytes) {
  if (IS_WIN) {
    const q = shQuote(filePath);
    const cmd = `sz=$(wc -c < ${q} 2>/dev/null || echo 0); echo "$sz"; ` +
      `if [ "$sz" -gt "$((${offset} + ${maxBytes}))" ]; then tail -c ${maxBytes} ${q}; ` +
      `else tail -c "+$((${offset} + 1))" ${q}; fi`;
    return exec(cmd, 30000, { maxBuffer: maxBytes + 1024 * 1024 }).then((out) => {
      if (out == null) return null;
      const nl = out.indexOf('\n');
      if (nl < 0) return null;
      const size = Number(out.slice(0, nl).trim());
      if (!Number.isFinite(size)) return null;
      return { text: out.slice(nl + 1), size, truncated: size > offset + maxBytes };
    });
  }
  return new Promise((resolve) => {
    fs.stat(filePath, (err, stats) => {
      if (err) return resolve(null);
      const size = stats.size;
      const truncated = size > offset + maxBytes;
      const start = truncated ? size - maxBytes : Math.min(offset, size);
      const length = Math.max(0, size - start);
      if (length === 0) return resolve({ text: '', size, truncated: false });
      fs.open(filePath, 'r', (err2, fd) => {
        if (err2) return resolve(null);
        const buf = Buffer.alloc(length);
        fs.read(fd, buf, 0, length, start, (err3) => {
          fs.close(fd, () => {});
          resolve(err3 ? null : { text: buf.toString('utf8'), size, truncated });
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
    this.usageFile = path.join(app.getPath('userData'), 'usage.json');
    this.seen = new Map(); // filename -> mtimeMs already processed
    this.models = new Map(); // sessionId -> last known model id (from the transcript)
    this.usage = new Map(); // sessionId -> accumulated transcript usage (see usageState)
    // sessionId -> the conversation it is writing right now. Set from every
    // hook event, so it is known from SessionStart onwards rather than only
    // once a turn has ended (which is when `usage` first gets a path).
    this.transcripts = new Map();
    // absolute file path -> Map(sessionId -> ts of its last write to it)
    this.touches = new Map();
    this.watcher = null;
    this.sweepTimer = null;
    this.persistTimer = null; // coalesces the usage writes (see persistUsage)
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
      this.restoreUsage();
    } catch (err) {
      this.debugLog('[hooks] init FAILED — falling back to heuristics: ' + err.message);
      return;
    }

    // fs.watch for instant reaction, plus a slow sweep in case events get lost
    try {
      this.watcher = fs.watch(this.stateDir, (_type, filename) => this.sweep(filename));
      // an EventEmitter 'error' with no listener is thrown, and this one would
      // land outside the try above (it is emitted later, not at setup) and take
      // the whole main process down — the sweep below carries on regardless
      this.watcher.on('error', () => { /* sweep alone still works */ });
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

  /* Just the file fs.watch named, or the whole directory when it named none.
   * A busy swarm fires the watcher several times a second, and re-statting
   * every agent's state file for one file's worth of news is O(agents) per
   * event — the `.tmp` half of each atomic write included, which then matches
   * nothing. The 3s timer passes no name and still does the full pass, so an
   * event that arrived unnamed or not at all is late rather than lost. */
  sweep(only) {
    let files;
    if (only) files = [only];
    else {
      // gone (cleaned temp dir, manual delete): recreate it, or every running
      // agent's hook writes keep failing for the rest of the session
      try { files = fs.readdirSync(this.stateDir); } catch {
        try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch { /* ignore */ }
        return;
      }
    }
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
      // /clear rotates the agent onto a fresh transcript file, and that is the
      // one thing that ends a session's tally: the totals belong to the
      // conversation, not to the pane. A restart or resume reports the same
      // path and keeps counting.
      if (event === 'SessionStart' && payload.transcript_path) {
        const prev = this.usage.get(sessionId);
        if (prev && prev.path !== payload.transcript_path) {
          this.usage.delete(sessionId);
          this.persistUsage();
          this.onEvent(sessionId, { event: 'UsageUpdate', tool: null, message: null, model: null, usage: null });
        }
      }
      if (event === 'Stop' && payload.transcript_path) {
        this.usageState(sessionId, payload.transcript_path).turns++;
        this.refreshFromTranscript(sessionId, payload.transcript_path);
      }
      // which Claude conversation this agent is writing — the History screen
      // takes the same id, so a notification can open the full transcript, and
      // history:delete can refuse to unlink it
      const transcript = typeof payload.transcript_path === 'string'
        ? path.basename(payload.transcript_path, '.jsonl')
        : null;
      if (transcript) this.transcripts.set(sessionId, transcript);
      this.onEvent(sessionId, {
        event,
        tool: typeof payload.tool_name === 'string' ? payload.tool_name.slice(0, 40) : null,
        message: typeof payload.message === 'string' ? payload.message.slice(0, 200) : null,
        model: this.models.get(sessionId) || null,
        transcript,
      });
      // after the event above, so the pane has already put the tool on its
      // status line before the collision badge lands beside it
      const target = event === 'PreToolUse' ? writeTarget(payload) : null;
      if (target) this.reportCollision(sessionId, target);
    }
  }

  /* Record a write, and tell everyone involved if somebody else wrote the same
   * file inside the window. Both sides are notified: a collision that only the
   * second agent's pane knew about would be half a warning. */
  reportCollision(sessionId, file) {
    const now = Date.now();
    let bySession = this.touches.get(file);
    if (!bySession) {
      if (this.touches.size >= TOUCH_PATHS_MAX) this.sweepTouches(now);
      bySession = new Map();
      this.touches.set(file, bySession);
    }
    bySession.set(sessionId, now);

    const others = [];
    for (const [id, ts] of bySession) {
      if (id === sessionId) continue;
      if (now - ts > COLLISION_WINDOW_MS) bySession.delete(id);
      else others.push(id);
    }
    if (!others.length) return;

    this.debugLog(`[hooks] collision on ${file}: ${sessionId} + ${others.join(', ')}`);
    // the newcomer hears about everyone; each incumbent hears about the newcomer
    this.onEvent(sessionId, collisionEvent(file, others));
    for (const other of others) this.onEvent(other, collisionEvent(file, [sessionId]));
  }

  /* Drop paths nobody has written inside the window. Only runs when the map
   * hits its cap, which a normal session never reaches. */
  sweepTouches(now) {
    for (const [file, bySession] of this.touches) {
      for (const [id, ts] of bySession) if (now - ts > COLLISION_WINDOW_MS) bySession.delete(id);
      if (!bySession.size) this.touches.delete(file);
    }
  }

  /* A closed session must stop being named as the other half of a collision. */
  forgetTouches(sessionId) {
    for (const [file, bySession] of this.touches) {
      if (!bySession.delete(sessionId)) continue;
      if (!bySession.size) this.touches.delete(file);
    }
  }

  /* Running per-session totals, keyed to the transcript they were read from:
   * a different file is a different conversation, so the tally starts over
   * rather than continuing on top of somebody else's numbers. */
  usageState(sessionId, transcriptPath) {
    let st = this.usage.get(sessionId);
    if (!st || st.path !== transcriptPath) {
      st = {
        path: transcriptPath,
        offset: 0,
        busy: false,
        rearm: null, // pending re-read for a Stop that arrived mid-read (see refreshFromTranscript)
        partial: false, // true once a read had to skip bytes: totals are a lower bound
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        cost: 0,
        context: 0,
        turns: 0,
        series: [],
        seen: new Set(), // message ids already billed (see refreshFromTranscript)
        seenOrder: [],
      };
      this.usage.set(sessionId, st);
    }
    return st;
  }

  /* Has this message already been counted? Claude Code writes one JSONL line
   * per content block and repeats the *whole* message's usage on every one of
   * them, so a thinking + text + tool_use turn appears three times with
   * identical numbers. Billing each line inflates the totals several-fold. */
  countedAlready(st, id) {
    if (!id) return false; // no id to dedupe on — count it rather than lose it
    if (st.seen.has(id)) return true;
    st.seen.add(id);
    st.seenOrder.push(id);
    if (st.seenOrder.length > USAGE_SEEN_MAX) st.seen.delete(st.seenOrder.shift());
    return false;
  }

  /* What the renderer draws in the cost & context panel — also exactly what
   * gets persisted, so a restart can hand it straight back. */
  snapshot(sessionId) {
    const st = this.usage.get(sessionId);
    if (!st) return null;
    return {
      input: st.input,
      output: st.output,
      cacheRead: st.cacheRead,
      cacheWrite: st.cacheWrite,
      cost: st.cost,
      context: st.context,
      turns: st.turns,
      partial: st.partial,
      model: this.models.get(sessionId) || null,
      series: st.series.slice(),
    };
  }

  /* Totals outlive the app: closing SwarmEye leaves the agent running in tmux,
   * so its spend so far is still true when the window comes back. The
   * transcript offset rides along, which is what lets the next Stop pick up
   * from where this run stopped reading instead of re-counting the file. */
  persistUsage() {
    // a turn boundary for every agent is still too often to write on, so the
    // writes are coalesced (and flushed on quit — see stop()).
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushUsage(), USAGE_PERSIST_MS);
  }

  /* Its own file, not config.json — the runstate.json split in main.js, for the
   * same reason. These totals are a few hundred bytes and change every few
   * seconds, while config.json carries the 200 archived task logs and is six
   * figures of bytes: writing them there sized every save by the archive. */
  flushUsage() {
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const out = {};
    for (const [id, st] of this.usage) {
      out[id] = { ...this.snapshot(id), path: st.path, offset: st.offset };
    }
    // tmp+rename like config.js: this fires every few seconds, and a torn file
    // fails to parse at boot, which resets every agent's transcript offset to 0
    // (a multi-MB re-read each) and loses its spend history
    try {
      fs.writeFileSync(this.usageFile + '.tmp', JSON.stringify(out));
      fs.renameSync(this.usageFile + '.tmp', this.usageFile);
    } catch (err) {
      this.debugLog('[hooks] usage persist failed: ' + err.message);
    }
  }

  restoreUsage() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.usageFile, 'utf8')); } catch { /* first run */ }
    // totals written by a version that still kept them in config.json: taken
    // over once, so upgrading doesn't blank a running agent's cost panel
    if (!saved) saved = config.load().usage || {};
    for (const [id, s] of Object.entries(saved)) {
      if (!s || typeof s.path !== 'string') continue;
      this.usage.set(id, {
        path: s.path,
        // must be a number: on Windows the offset is interpolated into shell
        // arithmetic (readNew), so a corrupt/hand-edited usage.json with a
        // string here would land text on a command line
        offset: Number.isFinite(s.offset) ? s.offset : 0,
        busy: false,
        rearm: null,
        partial: !!s.partial,
        input: s.input || 0,
        output: s.output || 0,
        cacheRead: s.cacheRead || 0,
        cacheWrite: s.cacheWrite || 0,
        cost: s.cost || 0,
        context: s.context || 0,
        turns: s.turns || 0,
        series: Array.isArray(s.series) ? s.series : [],
        seen: new Set(),
        seenOrder: [],
      });
      if (s.model) this.models.set(id, s.model);
    }
  }

  /* Sessions that didn't survive the restart (tmux gone) leave their totals
   * behind — drop them once the reconciled list of live ids is known. */
  pruneUsage(liveIds) {
    const live = new Set(liveIds);
    let dropped = false;
    for (const id of [...this.usage.keys()]) {
      if (live.has(id)) continue;
      this.usage.delete(id);
      this.models.delete(id);
      this.transcripts.delete(id);
      this.forgetTouches(id);
      dropped = true;
    }
    if (dropped) this.persistUsage();
  }

  /* The conversation each of these sessions is writing right now. history:delete
   * asks before removing transcripts, so a running agent never loses the file
   * it is appending to. */
  transcriptIds(sessionIds) {
    return sessionIds.map((id) => this.transcripts.get(id)).filter(Boolean);
  }

  /* Read whatever the transcript gained since the last turn, and fold it into
   * this session's totals: tokens, cost, the live context size, and one burn
   * sample per turn. Fires once per Stop event (turn boundary), not per tool
   * call. Both follow-up events are pushed after the Stop that triggered them
   * — the renderer's model chip and cost panel catch up a beat later. */
  async refreshFromTranscript(sessionId, transcriptPath) {
    const st = this.usageState(sessionId, transcriptPath);
    // two turns landing together must not read the same bytes twice — but the
    // second one is re-armed rather than dropped: when it is the *last* Stop of
    // a turn (a sidechain's Stop and the final one inside one slow read),
    // dropping it loses that turn's tokens and its closing summary for good.
    // One pending re-arm per session, and only while the session still exists.
    if (st.busy) {
      if (!st.rearm) {
        st.rearm = setTimeout(() => {
          st.rearm = null;
          if (this.usage.get(sessionId) === st) this.refreshFromTranscript(sessionId, transcriptPath);
        }, 1000);
      }
      return;
    }
    st.busy = true;
    try {
      const res = await readNew(transcriptPath, st.offset, USAGE_MAX_READ);
      if (!res) return;
      if (res.truncated) st.partial = true;
      // A turn can land mid-write, leaving a half-written final line that
      // won't parse. Leave its bytes unconsumed so the next read sees the line
      // whole, rather than advancing past it and losing that turn entirely.
      const lastNl = res.text.lastIndexOf('\n');
      const pending = lastNl < 0 ? res.text : res.text.slice(lastNl + 1);
      st.offset = res.size - Buffer.byteLength(pending, 'utf8');

      let model = null;
      let turnTokens = 0;
      let summary = ''; // the newest assistant text block — what the agent said last
      for (const line of res.text.split('\n')) {
        if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
        let entry;
        // a truncated read starts mid-line, and the last line can be a
        // half-written one — both simply fail to parse and are skipped
        try { entry = JSON.parse(line); } catch { continue; }
        const msg = entry && entry.message;
        const u = msg && msg.usage;
        if (!u || entry.type !== 'assistant') continue;
        // synthetic entries are Claude Code's own local messages (API errors,
        // interrupts): all-zero usage, never billed — and letting one through
        // would blank the context reading until the next real turn
        if (msg.model === '<synthetic>') continue;
        // What the agent actually said, for the completed task's card. Read
        // before the dedupe below, not after: Claude Code writes one line per
        // content block and repeats the message's usage on each, so a turn
        // whose thinking block comes first would have its text line skipped as
        // "already counted". Sub-agent turns are somebody else's answer.
        if (entry.isSidechain !== true && Array.isArray(msg.content)) {
          const text = msg.content
            .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text.trim())
            .filter(Boolean)
            .join('\n\n');
          if (text) summary = text;
        }
        if (this.countedAlready(st, msg.id)) continue;

        const input = u.input_tokens || 0;
        const output = u.output_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        const write1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
        const write5m = (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0;
        // older entries only carry the flat total — bill those at the 5m rate
        const cacheWrite = (write1h + write5m) || u.cache_creation_input_tokens || 0;
        const price = priceFor(msg.model);
        const cost = (input * price.input
          + output * price.output
          + cacheRead * price.input * 0.1
          + write1h * price.input * 2
          + (cacheWrite - write1h) * price.input * 1.25) / 1e6;

        st.input += input;
        st.output += output;
        st.cacheRead += cacheRead;
        st.cacheWrite += cacheWrite;
        st.cost += cost;
        turnTokens += input + output + cacheRead + cacheWrite;

        if (msg.model) model = msg.model;
        // the newest main-chain prompt IS the live context size; sub-agent
        // (sidechain) turns run in their own window and must not stomp it
        if (entry.isSidechain !== true) st.context = input + cacheRead + cacheWrite;
      }

      if (turnTokens > 0) {
        st.series.push({ t: Date.now(), tokens: turnTokens });
        if (st.series.length > USAGE_SERIES_MAX) st.series.shift();
      }
      if (model && this.models.get(sessionId) !== model) {
        this.models.set(sessionId, model);
        this.onEvent(sessionId, { event: 'ModelUpdate', tool: null, message: null, model });
      }
      this.persistUsage();
      this.onEvent(sessionId, {
        event: 'UsageUpdate',
        tool: null,
        message: null,
        model: null, // the chip's model rides ModelUpdate only (see applyHookEvent)
        usage: this.snapshot(sessionId),
        // rides along rather than getting its own event: this read is the only
        // place the transcript is opened, and the renderer wants both at once
        summary: summary ? summary.slice(0, SUMMARY_MAX) : null,
      });
    } finally {
      st.busy = false;
    }
  }

  /* A killed/exited session must not leave a state file behind. */
  cleanup(sessionId) {
    if (!/^[A-Za-z0-9_]+$/.test(sessionId)) return;
    this.seen.delete(sessionId + '.json');
    this.models.delete(sessionId);
    this.usage.delete(sessionId);
    this.transcripts.delete(sessionId); // otherwise one entry per killed session for the app's lifetime
    this.forgetTouches(sessionId);
    this.persistUsage();
    try { fs.unlinkSync(path.join(this.stateDir, sessionId + '.json')); } catch { /* ignore */ }
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    clearInterval(this.sweepTimer);
    if (this.persistTimer) this.flushUsage(); // the last turns must not be lost on quit
  }
}

module.exports = { HookMonitor };
