/* ---- Pane: status, attention, prompts and the hook stream ----
 *
 * Split out of the one 2416-line pane.js. Everything that answers 'what is this agent doing' — the status dot, the
 * wait/subagent chips, the yes/no prompt buttons, the open-tool-call ledger,
 * and applyHookEvent, which is where main/hooks.js's events land.
 */

/* Claude Code's idle nudge, the one Notification that carries no menu. */
const IDLE_NUDGE_RE = /waiting for (your|user) input/i;

Object.assign(Pane.prototype, {
  syncStatus() {
    const status = this.status;
    this.dot.classList.toggle('idle', status === 'idle');
    this.dot.classList.toggle('attn', status === 'attention');
    this.el.classList.toggle('attn', status === 'attention');
    this.busyEl.style.display = status === 'working' ? '' : 'none';
    // /clear appears once the agent is done working and free (not mid-turn, not
    // blocked on a permission prompt, not exited)
    const canClear = !this.exited && !this.working && !this.awaitingPrompt;
    this.btnClear.style.display = canClear ? '' : 'none';
    this.syncWaitChip();
    this.syncSubagents();
  },

  flagAttention() {
    if (this.exited) return;
    // no attention for output the user is already looking at — which requires
    // the pane to actually be on screen (isConnected), not focused-but-hidden
    // in a non-selected workspace
    if (this.el.isConnected && this.el.classList.contains('focused') && document.hasFocus()) return;
    const was = this.attention;
    this.attention = true;
    this.syncStatus();
    if (!was) this.handlers.onStatusChange(this, 'attention');
  },

  clearAttention() {
    if (!this.attention) return;
    this.attention = false;
    this.syncStatus();
    this.handlers.onStatusChange(this, 'cleared');
  },

  noteActivity() {
    // once hook events flow they own the working/idle state — output timing
    // would only second-guess them (long thinking looks idle, redraws look busy)
    if (this.exited || this.hookAlive) return;
    if (Date.now() - this.lastInputAt < INPUT_ECHO_MS) return;
    if (!this.working) {
      this.workStart = Date.now();
      this.working = true;
      this.syncStatus();
      this.handlers.onStatusChange(this, 'working');
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.working = false;
      this.syncStatus();
      this.handlers.onStatusChange(this, 'idle');
      // sustained output that stops = the agent finished its turn or is
      // waiting on a prompt — surface it like a bell
      if (Date.now() - this.workStart >= FINISHED_MIN_WORK_MS + IDLE_AFTER_MS) {
        this.flagAttention();
      }
    }, IDLE_AFTER_MS);
  },

  /* ---- precise state from Claude Code hooks ---- */

  setStatusText(text) {
    this.statusText = text || '';
    this.statusEl.textContent = text || '';
    this.statusEl.style.display = text ? '' : 'none';
  },

  syncPromptButtons() {
    const show = this.awaitingPrompt && this.promptAnswerable && !this.exited;
    this.btnApprove.style.display = show ? '' : 'none';
    this.btnDeny.style.display = show ? '' : 'none';
  },

  /* "▸ 2 subagents" — Claude Code's Task calls, which otherwise show up as one
   * line of the parent's output and nothing else. */
  syncSubagents() {
    const live = this.subagents.filter((s) => !s.done).length;
    const show = live > 0 && !this.exited;
    const text = show ? `▸ ${live}` : '';
    if (this.subEl.textContent !== text) this.subEl.textContent = text;
    const display = show ? '' : 'none';
    if (this.subEl.style.display !== display) this.subEl.style.display = display;
    if (!show) return;
    const names = this.subagents.filter((s) => !s.done).map((s) => s.desc || 'subagent');
    this.subEl.dataset.tip = `${live} subagent${live > 1 ? 's' : ''} running: ${names.join(' · ')}`;
  },

  /* "waiting 4m" beside the status. Hidden the moment the agent is working
   * again, so it can never show a stale age. */
  syncWaitChip() {
    const show = !this.exited && this.awaitingPrompt && this.waitingSince > 0;
    const text = show ? 'waiting ' + fmtWait(Date.now() - this.waitingSince) : '';
    if (this.waitEl.textContent !== text) this.waitEl.textContent = text;
    const display = show ? '' : 'none';
    if (this.waitEl.style.display !== display) this.waitEl.style.display = display;
    if (!show) return;
    const since = new Date(this.waitingSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const tip = `Blocked on you since ${since} — Ctrl+. jumps to whoever has waited longest`;
    if (this.waitEl.dataset.tip !== tip) this.waitEl.dataset.tip = tip;
  },

  /* Quick-respond to a live numbered permission prompt from the pane header
   * or the notification bell, without opening the pane. Reuses the same
   * menu-line shape the clickable option links already parse
   * (MENU_OPTION_RE): scan the tail of the buffer for "N. <text>" lines and
   * send just the matching option's digit — no Enter, same as those links.
   *
   * kind: 'yes' picks the first option whose text starts with "yes";
   * 'no' the first starting with "no". always=true (shift-click ✓) prefers
   * a "yes" option that also mentions "don't ask"/"always" (Claude's
   * remember-this-choice variant) over a plain one, falling back to plain
   * yes if no such option exists. No matching option = nothing sent; caller
   * shows a toast instead of guessing. */
  promptOptions(lines = this.tailLines(30)) {
    const options = [];
    for (const line of lines) {
      const m = MENU_OPTION_RE.exec(line);
      // the label only — the "1." itself has to come off, or every option
      // starts with a digit and nothing ever matches ^yes / ^no
      if (m) options.push({ digit: m[2], text: line.slice(m[1].length + m[2].length + 1).trim() });
    }
    return options;
  },

  pickPromptOption(kind, always, options = this.promptOptions()) {
    const wantAlways = kind === 'yes' && always;
    let pick = null;
    for (const o of options) {
      if (!new RegExp('^' + kind, 'i').test(o.text)) continue;
      // "…and don't ask again", "…allow all edits during this session" — the
      // remember-this-choice variant, whichever wording this prompt uses
      const mentionsAlways = /don'?t ask|always|allow all/i.test(o.text);
      if (wantAlways ? mentionsAlways : !mentionsAlways) return o;
      if (!pick) pick = o; // fallback candidate of the right yes/no family
    }
    return pick;
  },

  /* Whether the ✓/✕ pair has anything to click — a numbered menu with both a
   * yes and a no option on screen right now. The Notification hook fires for
   * *any* block on the user, and its commonest form is the idle "Claude is
   * waiting for your input" nudge, which has no menu behind it (in bypass
   * permissions mode it is the only notification there is). Gating on
   * awaitingPrompt alone therefore offered buttons that could only ever
   * answer "couldn't read the prompt". Re-run whenever output settles, since
   * the hook can land a beat before the TUI paints the menu. */
  refreshPromptOptions(lines = this.tailLines(30)) {
    const options = this.exited ? [] : this.promptOptions(lines);
    const answerable = !!(this.pickPromptOption('yes', false, options)
      && this.pickPromptOption('no', false, options));
    if (answerable === this.promptAnswerable) return;
    this.promptAnswerable = answerable;
    this.syncPromptButtons();
    // the bell and the swarm view carry their own copy of these buttons
    this.handlers.onStatusChange(this, 'prompt');
  },

  respondToPrompt(kind, always) {
    if (this.exited) return false;
    const pick = this.pickPromptOption(kind, always);
    if (!pick) {
      this.refreshPromptOptions(); // the menu moved on — stop offering the buttons
      return false;
    }
    this.awaitingPrompt = false;
    this.syncPromptButtons();
    this.clearAttention();
    window.swarm.writeSession(this.session.id, pick.digit);
    return true;
  },

  /* One row for a call that has just started. The file sets are only fed by the
   * tools that genuinely name a file — a Grep pattern or a Bash command is not
   * a path, and putting either in a "files read" list would make the list lie. */
  noteCall(tool, target) {
    const entry = { tool, target: target || '', t: Date.now(), ms: 0, failed: false, done: false };
    // a Task call *is* a subagent starting — the only trace one ever leaves
    if (tool === 'Task') {
      entry.sub = { desc: target || 'subagent', t: entry.t, ms: 0, done: false };
      this.subagents.push(entry.sub);
      if (this.subagents.length > SUBAGENTS_MAX) this.subagents.shift();
      this.syncSubagents();
    }
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_MAX) this.activity.shift();
    this.openCalls.push(entry);
    // a swarm of never-closed calls would grow forever; the oldest is retired
    if (this.openCalls.length > OPEN_CALLS_MAX) this.retire(this.openCalls.shift());
    const set = WRITE_TOOLS.has(tool) ? this.writes : FILE_READ_TOOLS.has(tool) ? this.reads : null;
    if (!set || !target) return;
    set.set(target, (set.get(target) || 0) + 1);
    if (set.size > TOUCHED_MAX) set.delete(set.keys().next().value);
  },

  /* Close the call a PostToolUse belongs to. Matched on tool *and* target
   * rather than "whichever started last": Claude Code runs calls in parallel —
   * several Task subagents at once is the normal case — so closing the newest
   * one would report the wrong subagent as finished. */
  closeCall(tool, target, failed) {
    const want = target || '';
    let idx = this.openCalls.findIndex((c) => c.tool === tool && c.target === want);
    if (idx < 0) idx = this.openCalls.findIndex((c) => c.tool === tool);
    if (idx < 0) return; // its PreToolUse was overwritten before the watcher saw it
    const [entry] = this.openCalls.splice(idx, 1);
    entry.done = true;
    entry.ms = Date.now() - entry.t;
    entry.failed = !!failed;
    if (entry.sub) {
      entry.sub.done = true;
      entry.sub.ms = entry.ms;
      this.syncSubagents();
    }
  },

  /* A call that never reported back: the turn ended on it. A denied permission
   * prompt emits no PostToolUse and — as the driven app showed — no Stop
   * either, so this runs on the next turn's UserPromptSubmit as well. A row
   * that says "running" for the rest of the session is worse than no row. */
  retire(entry) {
    if (!entry || entry.done) return;
    entry.done = true;
    entry.ms = Date.now() - entry.t;
    entry.cancelled = true;
    if (entry.sub) {
      entry.sub.done = true;
      entry.sub.ms = entry.ms;
    }
  },

  retireOpenCalls() {
    if (!this.openCalls.length) return;
    for (const entry of this.openCalls.splice(0)) this.retire(entry);
    this.syncSubagents();
  },

  applyHookEvent({ event, tool, message, model, usage, transcript, target, failed }) {
    if (this.exited) return;
    // /clear and --resume both move the agent onto another transcript file,
    // so the newest one the hooks reported wins
    if (transcript) this.transcriptId = transcript;
    // per-turn totals from the transcript — a bookkeeping event, not a state
    // change, so it returns before any of the working/waiting handling below
    if (event === 'UsageUpdate') {
      // a null payload is the reset /clear sends: the tally starts over
      this.usage = usage || null;
      this.renderUsagePanel();
      return;
    }
    const wasWorking = this.working;
    if (!this.hookAlive) {
      this.hookAlive = true;
      clearTimeout(this.idleTimer); // heuristics are off duty now
      // and whatever they last decided is stale: boot output marks the pane
      // working, and if the first hook event is one that doesn't set
      // `working` itself (SessionStart, ModelUpdate), that true would be
      // frozen forever — idle timer cancelled, nothing left to clear it
      this.working = false;
    }
    // model only updates on these two event types: SessionStart (in case a
    // future Claude Code version populates it) and ModelUpdate (the main
    // process's own follow-up after tailing the transcript on Stop, since
    // the model isn't in the common hook payload — see hooks.js). Every
    // other event type ignores it, so a stale cached value never stomps a
    // fresher one from the /model-confirmation buffer scan below.
    if ((event === 'SessionStart' || event === 'ModelUpdate') && model) this.setModel(prettyModelName(model));
    if (event === 'UserPromptSubmit') {
      this.working = true;
      this.awaitingPrompt = false;
      this.noteTurnStart();
      // "vibing..." from the first moment of the turn, not the first tool call
      // — otherwise the equalizer runs wordless while the model is thinking,
      // and a turn with no tool calls never gets a status at all
      this.setStatusText('vibing...');
      this.retireOpenCalls(); // a new turn retires whatever the last one left open
      Activity.sync(this);
    } else if (event === 'PreToolUse') {
      this.working = true;
      this.awaitingPrompt = false;
      this.noteTurnStart();
      if (tool) {
        this.toolTrail.push(tool);
        if (this.toolTrail.length > TOOL_TRAIL_MAX) this.toolTrail.shift();
        if (READ_ONLY_TOOLS.has(tool)) this.readOnlyStreak++;
        else this.readOnlyStreak = 0;
        this.syncRightsize();
        this.noteCall(tool, target);
      }
      // one word for every tool — which tool and what it was on are both in
      // the activity popover, which the cost panel's tool trail opens
      this.setStatusText('vibing...');
      Activity.sync(this);
    } else if (event === 'PostToolUse') {
      // between two calls is still mid-turn — the agent is working, not idle
      this.working = true;
      this.awaitingPrompt = false;
      this.noteTurnStart();
      this.closeCall(tool, target, failed);
      Activity.sync(this);
    } else if (event === 'Notification') {
      // claude is blocked on the user (permission prompt / waiting for input)
      this.working = false;
      this.awaitingPrompt = true;
      this.turnStartedAt = 0;
      this.waitingSince = this.waitingSince || Date.now();
      // the plain idle nudge says nothing the status dot does not already say,
      // so only a real permission prompt gets text in the header
      this.setStatusText(IDLE_NUDGE_RE.test(message || '') ? '' : message || '');
      // a permission prompt is usually already painted by the time its hook
      // lands; a plain "waiting for your input" nudge never has a menu at all
      this.refreshPromptOptions();
      this.flagAttention();
    } else if (event === 'Stop') {
      this.working = false;
      this.awaitingPrompt = false;
      this.turnStartedAt = 0;
      this.waitingSince = 0;
      this.setStatusText('done');
      // calls still open when the turn ends never ran — a denied permission
      // prompt or an interrupt, both of which skip PostToolUse entirely
      this.retireOpenCalls();
      Activity.sync(this);
      this.flagAttention();
      // completion must reach app.js even when flagAttention suppresses its
      // event (pane focused and watched, or attention already flagged) — a
      // board task's completion handling hangs off this dedicated status
      this.handlers.onStatusChange(this, 'done');
    }
    this.syncPromptButtons();
    this.syncStatus();
    if (wasWorking !== this.working) {
      this.handlers.onStatusChange(this, this.working ? 'working' : 'idle');
    }
  },

  /* Offer a cheaper tier to an Opus agent that has done nothing but read.
   * The offer states what it will do before it does it and takes two clicks —
   * a model swap that happened silently mid-task would be the worst possible
   * version of this. Hidden again the moment the agent edits something. */
  syncRightsize() {
    const n = this.readOnlyStreak;
    const eligible = n >= RIGHTSIZE_MIN_CALLS
      && !this.exited
      && /^opus\b/i.test(this.modelLabel || '')
      && !RIGHTSIZE_SKIP_ROLES.has(this.session.role);
    this.rightsizeEl.style.display = eligible ? '' : 'none';
    if (!eligible) return;
    this.rightsizeEl.dataset.tip =
      `${this.session.agentName} has run ${n} read-only tool calls in a row on `
      + `${this.modelLabel}. Click twice to restart it on Haiku — the conversation `
      + 'is kept (--continue), so it picks up where it left off. The thread so far '
      + 'is re-sent once at the cheaper rate.';
  },

  /* ---- cost & context panel ---- */

  noteTurnStart() {
    this.waitingSince = 0;
    if (!this.turnStartedAt) this.turnStartedAt = Date.now();
  }
});
