const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const providers = require('./providers');
const { claudeProjectDirName } = require('./sessions');
const { IS_WIN, exec, shQuote, toShellPath } = require('./platform');

/* Precise agent state via Claude Code hooks instead of output-timing guesses.
 * Every spawned claude gets `--settings <hook-settings.json>` whose hooks
 * pipe their stdin JSON into <userData>/hook-state/$SWARMEYE_SESSION.json (an
 * id plus that launch's token — see TOKEN_BYTES below), which
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

/* PostToolUse is here for the pane's activity list only: it is what gives a
 * finished call a duration and a pass/fail, which PreToolUse alone cannot. It
 * costs one more hook write per tool call and says nothing about working /
 * waiting — the renderer treats it as "still working", like PreToolUse. */
const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionStart'];

/* Every agent writes into the same hook-state dir and names its own file, so
 * the name alone proved nothing: a session's id is its tmux name, which any
 * agent can read out of `tmux ls`, and writing <victim>.json there forged that
 * victim's Stop / Notification / closing summary — which the lead agent's pane
 * then acts on. So each launch gets a random token, the file is named
 * <sessionId>-<token>.json, and a name whose token doesn't match the one this
 * launch was given is somebody else's forgery. Hex only: SWARMEYE_SESSION is
 * interpolated into a single-quoted tmux command. */
const TOKEN_BYTES = 12;
const TOKEN_RE = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

/* The token proves *who* wrote the state file; it says nothing about what is
 * inside it. `transcript_path` is one of those fields, and everything below
 * opens it — fs.read on macOS, wc -c / tail -c inside WSL on Windows — from a
 * main process that is scoped to nothing. An agent restricted to its own
 * subtree could name ~/.ssh/config there and have its size, its existence and
 * its contents come back as that pane's cost panel and closing summary, or
 * name another session's transcript and misattribute its spend. So a path is
 * used only when its name looks like a transcript and it sits in a directory
 * this session is entitled to (see safeTranscript).
 *
 * A conversation uuid, or the <sessionId>-<token> the foreign harnesses name
 * their own file after, plus the .<n> a clean-agent /clear rotation adds.
 * No dot or separator of its own, so a name that matches cannot climb out of
 * the directory it was checked against. */
const TRANSCRIPT_NAME_RE = /^[A-Za-z0-9_-]{8,64}(\.\d{1,4})?\.jsonl$/;

/* The app's own harness transcripts, written beside hook-state under userData
 * (see agent/clean.js, agent/opencode-plugin.js, agent/pi-extension.ts). */
const HARNESS_TRANSCRIPT_DIRS = ['clean-transcripts', 'opencode-transcripts', 'pi-transcripts'];

/* What a tool call is *about*, for the pane's status line and its activity
 * list: the path for anything that names one, the command for Bash, the URL for
 * a fetch. Display only. */
const TARGET_FIELDS = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'url', 'description'];

function toolTarget(payload) {
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return null;
  for (const field of TARGET_FIELDS) {
    const v = input[field];
    if (typeof v === 'string' && v) return v.slice(0, 200);
  }
  return null;
}

/* Whether a finished call failed. There is no one agreed error field across
 * tools, so this reads the three shapes Claude Code actually emits and treats
 * anything else as a pass — an activity row that wrongly reads red is worse
 * than one that misses a failure the terminal shows anyway. */
function toolFailed(payload) {
  const res = payload.tool_response;
  if (!res || typeof res !== 'object') return false;
  return res.success === false || res.is_error === true || !!(typeof res.error === 'string' && res.error);
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

/* Claude Code fires the Stop hook *before* that turn's assistant message is in
 * the transcript, so the read a Stop triggers finds the message from the turn
 * *before* it — every closing summary was one turn behind. An agent that keeps
 * going corrects itself on its next turn; a task's agent is closed the moment
 * it completes, so its card kept whatever was there. For a worker with active
 * skills that is the skill preamble ("Ready. What's the task?") — which, typed
 * back to an orchestrator's lead as the worker's report, reads as a worker that
 * did nothing, and the lead delegates the same work again. That is the wave
 * after wave the orchestrator kept starting on 2026-08-13.
 *
 * So the transcript is read once more shortly after the Stop, and those reads
 * say `settled`: a task files its summary from one of those only. Two passes,
 * because the flush is a race and not a fixed delay, and a short tail rather
 * than the whole file — only the newest message matters here, and on Windows
 * every read is a WSL round trip. */
const SUMMARY_SETTLE_MS = [700, 2500];
const SUMMARY_TAIL = 128 * 1024;

/* The newest thing the agent itself said in a slice of transcript. Same rules
 * as the usage read's own scan: assistant entries only, no sub-agent
 * (sidechain) turns, no synthetic local messages. */
function closingText(text) {
  let out = '';
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a partial first/last line
    const msg = entry && entry.message;
    if (!msg || entry.type !== 'assistant' || entry.isSidechain === true) continue;
    if (msg.model === '<synthetic>' || !Array.isArray(msg.content)) continue;
    const said = msg.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (said) out = said;
  }
  return out;
}

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
  // an OpenRouter slug ('provider/model') prices from the fetched catalog —
  // exact rates, including the published cache read/write prices (carried as
  // cacheRead/cacheWrite, which the cost formula below prefers over the
  // Anthropic multipliers). A slug the catalog doesn't know bills zero and
  // keeps counting tokens, rather than guessing a Claude-tier price that
  // would be wrong by an order of magnitude.
  if (id.includes('/')) return providers.priceFor(id) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
    this.tokensFile = path.join(app.getPath('userData'), 'hook-tokens.json');
    this.seen = new Map(); // filename -> mtimeMs already processed
    this.tokens = new Map(); // sessionId -> the token its launch was given (see claudeCmd)
    this.models = new Map(); // sessionId -> last known model id (from the transcript)
    this.usage = new Map(); // sessionId -> accumulated transcript usage (see usageState)
    // sessionId -> the conversation it is writing right now. Set from every
    // hook event, so it is known from SessionStart onwards rather than only
    // once a turn has ended (which is when `usage` first gets a path).
    this.transcripts = new Map();
    this.settleTimers = new Map(); // sessionId -> its pending summary re-reads (see settleSummary)
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
      this.hookSpec = hooks; // a scoped agent's own settings file carries these too
      fs.writeFileSync(this.settingsFile, JSON.stringify({ hooks }, null, 2), 'utf8');
      this.sweepScopedSettings();
      this.restoreTokens();
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

  /* An agent scoped to a subtree (main/scope.js) needs deny rules nobody else
   * has, so it gets a settings file of its own: the same hooks every agent
   * runs, plus its own permissions. Everyone else keeps the shared file.
   *
   * A write failure throws rather than falling back — the caller is inside
   * spawn's try, and an agent that believes it is scoped and is not is worse
   * than a launch that refuses. */
  scopedSettingsFile(sessionId, denyEdit) {
    if (!denyEdit || !denyEdit.length) return this.settingsFile;
    const file = path.join(app.getPath('userData'), `hook-settings-${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({ hooks: this.hookSpec || {}, permissions: { deny: denyEdit } }, null, 2), 'utf8');
    return file;
  }

  /* Those files outlive their launch on purpose: claude reads --settings once
   * at startup, and an agent that survived the app in tmux is reattached, not
   * relaunched. So this drops the ones whose session is gone rather than the
   * lot — unlike hook-state above, which must not replay as fresh events. */
  sweepScopedSettings() {
    const live = config.load().sessions || {};
    const dir = app.getPath('userData');
    for (const f of fs.readdirSync(dir)) {
      const m = /^hook-settings-(.+)\.json$/.exec(f);
      if (!m || live[m[1]]) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* it can stay */ }
    }
  }

  /* Wrap the claude command line so its hooks know where to report.
   * Returns baseCmd unchanged when hook paths can't be expressed safely
   * (they end up inside a single-quoted tmux command).
   *
   * `settings: false` keeps the env and drops the flag: an opencode or pi
   * launch reports through the same env vars (its adapter writes the state
   * file itself) but rejects `--settings` outright — opencode prints its
   * usage and exits 1, pi answers "Unknown option". The clean agent tolerates
   * the flag, so it still takes the default. */
  claudeCmd(sessionId, baseCmd, { settings: withSettings = true, denyEdit } = {}) {
    const stateDir = toShellPath(this.stateDir);
    const settings = toShellPath(this.scopedSettingsFile(sessionId, denyEdit));
    if (!stateDir || !settings || /'/.test(stateDir + settings)) return baseCmd;
    // one fresh token per launch, minted only once the command is actually
    // going out — a relaunch retires the old one, so a state file left by the
    // previous incarnation can't speak for this one either
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    this.tokens.set(sessionId, token);
    this.persistTokens();
    const env = `env SWARMEYE_SESSION=${sessionId}-${token} SWARMEYE_STATE_DIR="${stateDir}" `;
    return withSettings ? `${env}${baseCmd} --settings "${settings}"` : `${env}${baseCmd}`;
  }

  /* Which session a state file speaks for, or null when nothing proves it. The
   * writer names the file after its own $SWARMEYE_SESSION, which is
   * <sessionId>-<token>: an agent can read any other agent's id, but not the
   * token that launch was handed, so a name that doesn't match the token on
   * record is a forgery and never becomes an event. */
  ownerOf(filename) {
    const cut = filename.lastIndexOf('-');
    if (cut < 0) return null;
    const id = filename.slice(0, cut);
    return this.tokens.get(id) === filename.slice(cut + 1, -'.json'.length) ? id : null;
  }

  /* The transcript path a state file reported, or null when this session has
   * no business reading it — see TRANSCRIPT_NAME_RE above for why.
   *
   * Both platforms check the path in the spelling readNew will use: on Windows
   * that is the WSL one, which is also why Claude's own project dir is matched
   * by suffix rather than spelled out — that directory lives inside WSL and
   * this process cannot see the home it hangs off. The munged cwd in it is
   * this session's own, so another session's conversation is not a match
   * either. The app's harness dirs are ours, so those are exact.
   *
   * The path is normalised before it is checked and the normalised one is what
   * the caller uses, so no '..' can mean something different afterwards. */
  safeTranscript(sessionId, p) {
    if (typeof p !== 'string' || !p) return null;
    const full = path.posix.normalize(p);
    if (!TRANSCRIPT_NAME_RE.test(path.posix.basename(full))) return null;
    const dir = path.posix.dirname(full);
    const meta = (config.load().sessions || {})[sessionId];
    if (meta && meta.cwd && dir.endsWith('/.claude/projects/' + claudeProjectDirName(meta.cwd))) return full;
    const userData = app.getPath('userData');
    if (HARNESS_TRANSCRIPT_DIRS.some((d) => dir === toShellPath(path.join(userData, d)))) return full;
    this.debugLog('[hooks] dropped event for ' + sessionId + ': transcript path out of bounds');
    return null;
  }

  /* Tokens outlive the app for the same reason the totals do: closing SwarmEye
   * leaves the agent running in tmux with the SWARMEYE_SESSION it was launched
   * with, and a reattached agent that can't prove who it is would have every
   * one of its events dropped. Its own file rather than config.json — this is
   * main's bookkeeping, and nothing outside hooks needs to read it. */
  restoreTokens() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.tokensFile, 'utf8')); } catch { /* first run */ }
    for (const [id, tok] of Object.entries(saved || {})) {
      // a hand-edited or corrupt file must not seed a token that isn't hex:
      // it comes back out as a filename this process then trusts
      if (typeof tok === 'string' && TOKEN_RE.test(tok)) this.tokens.set(id, tok);
    }
  }

  persistTokens() {
    try {
      fs.writeFileSync(this.tokensFile + '.tmp', JSON.stringify(Object.fromEntries(this.tokens)));
      fs.renameSync(this.tokensFile + '.tmp', this.tokensFile);
    } catch (err) {
      this.debugLog('[hooks] token persist failed: ' + err.message);
    }
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
      // before the file is even statted: an unowned name is another agent's
      // forgery (or a leftover), and it costs nothing to say so early
      const sessionId = this.ownerOf(f);
      if (!sessionId) continue;
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
      const event = payload.hook_event_name;
      if (!HOOK_EVENTS.includes(event)) continue;
      // the one field in the payload this process acts on rather than merely
      // displays: checked once here, so every consumer below is covered by
      // that single call. A path that doesn't clear it is never opened — and
      // the event carrying it is dropped rather than half-handled.
      const tpath = payload.transcript_path ? this.safeTranscript(sessionId, payload.transcript_path) : null;
      if (payload.transcript_path && !tpath) continue;
      // /clear rotates the agent onto a fresh transcript file, and that is the
      // one thing that ends a session's tally: the totals belong to the
      // conversation, not to the pane. A restart or resume reports the same
      // path and keeps counting.
      if (event === 'SessionStart' && tpath) {
        const prev = this.usage.get(sessionId);
        if (prev && prev.path !== tpath) {
          this.usage.delete(sessionId);
          this.persistUsage();
          this.onEvent(sessionId, { event: 'UsageUpdate', tool: null, message: null, model: null, usage: null });
        }
      }
      if (event === 'Stop' && tpath) {
        this.usageState(sessionId, tpath).turns++;
        this.refreshFromTranscript(sessionId, tpath);
        this.settleSummary(sessionId, tpath);
      }
      // which Claude conversation this agent is writing — the History screen
      // takes the same id, so a notification can open the full transcript, and
      // history:delete can refuse to unlink it
      const transcript = tpath ? path.posix.basename(tpath, '.jsonl') : null;
      if (transcript) this.transcripts.set(sessionId, transcript);
      const isTool = event === 'PreToolUse' || event === 'PostToolUse';
      this.onEvent(sessionId, {
        event,
        tool: typeof payload.tool_name === 'string' ? payload.tool_name.slice(0, 40) : null,
        message: typeof payload.message === 'string' ? payload.message.slice(0, 200) : null,
        model: this.models.get(sessionId) || null,
        transcript,
        // what the call is on, and — once it has finished — whether it worked
        target: isTool ? toolTarget(payload) : null,
        failed: event === 'PostToolUse' ? toolFailed(payload) : false,
      });
    }
  }

  /* The closing message of the turn that just ended, read a beat after its Stop
   * (see SUMMARY_SETTLE_MS). Deliberately independent of the usage bookkeeping
   * above: a task closes its agent the instant it completes, which drops that
   * session's tally — and this read has to outlive it, because the message it
   * is waiting for is written after the agent is already gone. It reads a tail
   * and counts nothing, so it can neither double-bill nor disturb the totals.
   *
   * The handles are kept per session because "outlive the agent" has to stop
   * somewhere: a killed session's pair still fired seconds later and re-read a
   * path for a pane that no longer exists, so cleanup() cancels them. */
  settleSummary(sessionId, transcriptPath) {
    let timers = this.settleTimers.get(sessionId);
    if (!timers) this.settleTimers.set(sessionId, timers = new Set());
    for (const ms of SUMMARY_SETTLE_MS) {
      const timer = setTimeout(async () => {
        timers.delete(timer);
        const res = await readNew(transcriptPath, 0, SUMMARY_TAIL);
        const said = res ? closingText(res.text) : '';
        if (!said) return;
        this.onEvent(sessionId, {
          event: 'UsageUpdate',
          tool: null,
          message: null,
          model: null,
          usage: this.snapshot(sessionId),
          summary: said.slice(0, SUMMARY_MAX),
          settled: true, // the renderer files a task's summary from these only
        });
      }, ms);
      timers.add(timer);
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

  turnsOf(id) {
    return (this.usage.get(id) || {}).turns || 0;
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
      dropped = true;
    }
    if (dropped) this.persistUsage();
    // same pass for the tokens: a session that didn't survive can't come back
    // with the one it was launched with, and its entry would sit there for good
    let staleTokens = false;
    for (const id of [...this.tokens.keys()]) {
      if (live.has(id)) continue;
      this.tokens.delete(id);
      staleTokens = true;
    }
    if (staleTokens) this.persistTokens();
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
        // Anthropic prices carry only input/output and bill cache by the
        // multipliers; an OpenRouter price carries its own cacheRead /
        // cacheWrite rates (0 is a real rate there, so `!= null`, not `||`)
        const cost = (input * price.input
          + output * price.output
          + cacheRead * (price.cacheRead != null ? price.cacheRead : price.input * 0.1)
          + (price.cacheWrite != null
            ? cacheWrite * price.cacheWrite
            : write1h * price.input * 2 + (cacheWrite - write1h) * price.input * 1.25)) / 1e6;

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
    // before the name check below: those fire on a timer of their own and
    // would otherwise re-read a dead session's transcript seconds from now
    const timers = this.settleTimers.get(sessionId);
    if (timers) {
      for (const t of timers) clearTimeout(t);
      this.settleTimers.delete(sessionId);
    }
    if (!/^[A-Za-z0-9_]+$/.test(sessionId)) return;
    const token = this.tokens.get(sessionId);
    this.tokens.delete(sessionId);
    this.persistTokens();
    this.models.delete(sessionId);
    this.usage.delete(sessionId);
    this.transcripts.delete(sessionId); // otherwise one entry per killed session for the app's lifetime
    this.persistUsage();
    if (!token) return;
    const file = `${sessionId}-${token}.json`;
    this.seen.delete(file);
    try { fs.unlinkSync(path.join(this.stateDir, file)); } catch { /* ignore */ }
  }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    clearInterval(this.sweepTimer);
    if (this.persistTimer) this.flushUsage(); // the last turns must not be lost on quit
  }
}

module.exports = { HookMonitor };
