/* Pane: one terminal card (DOM + xterm + addons). Import it from index.js,
 * which is the copy with the three prototype mixins applied.
 *
 * Still a classic script, deliberately: other classic scripts read Pane's
 * statics (app.js constructs it; board.js, launcher.js, coordinator.js and
 * openrouter.js read MODES/MODELS/EFFORTS), and a classic script cannot
 * import from a module.
 *
 * What is left here is the class shell: the constructor that builds the header
 * DOM, the buffer scans, the terminal lifecycle, and the statics. Three method
 * groups live beside it in pane-status.js, pane-usage.js and pane-git.js,
 * re-attached with Object.assign(Pane.prototype, ...) — load order in
 * index.html is what makes that work, so they come after this file. */

import { Confirm } from '../../lib/confirm.js';
import { elt } from '../../lib/dom.js';
import { Icons } from '../../lib/icons.js';
import { toast } from '../../lib/toast.js';
import { OpenRouterUI } from '../openrouter/openrouter.js';
import { Speech } from '../speech/speech.js';
import { ATLAS_CLEAR_MIN_MS, ATLAS_PAGE_LIMIT, AUTO_ACCEPT_DIALOGS, DICTATE_SUBMIT, DICTATE_SUBMIT_DELAY_MS, EFFORTS, MAX_WEBGL_PANES, MENU_OPTION_RE, MODELS, MODES, MODE_MARKERS, MODE_STEP_MS, MODE_TIP, NAME_MAX, READ_ONLY_ASK, READ_ONLY_LIFT, SHIFT_TAB, autoOrganize, droppedPaths, fmtDuration, icon, livePanes, prettyModelName, setAutoOrganize, setShowInitialCommand, setShowUsagePanel, setSkipPermissions, setUsageWindow, showInitialCommand, skipPermissions, webglPanes } from './pane-const.js';
import { DEFAULT_FONT_SIZE, DEFAULT_FONT_WEIGHT, activeFontSize, activeFontWeight, activeMinContrast, activeMonoFont, activeXtermTheme, boldFor, getDefaultFontSize, getDefaultFontWeight, getMinContrast, getMonoFont, setDefaultFontSize, setDefaultFontWeight, setMonoFont, setXtermTheme } from './pane-theme.js';

/* The glyph-atlas counters behind attachWebgl and redrawGlyphs. They are per
 * swarm, not per pane: xterm hands every terminal sharing a font, theme and
 * cell size the *same* texture atlas (acquireTextureAtlas), so pages one pane
 * fills are pages every other pane draws from, and a clear anywhere is a clear
 * everywhere. The limits they are measured against are in pane-const.js with
 * the rest of the vocabulary; the counters are here because this is the only
 * file that moves them. */
let atlasPages = 0;
let atlasClearedAt = 0;
let atlasRebuild = 0; // rAF handle while a rebuild is already scheduled

export class Pane {
  /**
   * @param {object} session {id, num, agentName, workspaceName, cwd, persistent, lastCommand}
   * @param {object} handlers {onClose, onMaximize, onResize, onRename,
   *                           onRestart, onFocus, onStatusChange,
   *                           onShortcut, onSplit, setLastCommand}
   * @param {object} [opts] {managed} — managed is true when a board task
   *                         started this agent; false for a manually-added one
   */
  constructor(session, handlers, opts = {}) {
    this.session = session;
    this.handlers = handlers;
    this.managed = !!opts.managed;
    this.exited = false;
    this.detached = false;
    this.exitCode = null;
    this.attention = false;
    this.working = false;
    this.trustDialogHandled = false; // one-shot: auto-accept the folder-trust dialog at most once per session
    this.bypassDialogHandled = false; // one-shot: auto-accept the bypass-permissions warning at most once per session
    this.hookAlive = false; // true once Claude Code hook events flow — they replace the output-timing heuristics
    this.awaitingPrompt = false; // true while the agent is blocked on the user (Notification hook, cleared on the next turn)
    this.promptAnswerable = false; // true while a numbered yes/no menu is actually on screen — with awaitingPrompt, gates the ✓/✕ quick-respond buttons
    this.statusText = ''; // what the hooks say the agent is doing right now (the permission message / 'done'; empty mid-turn)
    this.lastInputAt = 0; // last keystroke/mouse report — its echo must not read as agent activity
    this.idleTimer = null;
    this.writeSeq = 0; // bumped on every buffer change, so consumers can memoize reads
    this.screenEl = null; // .xterm-screen and its rect, memoized for the wheel path (cellAt)
    this.screenRect = null;

    // cost & context panel state — usage arrives per turn from the hooks'
    // transcript read (UsageUpdate); the rest is derived from hook events.
    // A reattached session brings its totals back with it, so the panel is
    // populated before this agent's next turn ever runs.
    this.usage = session.usage || null;
    this.toolTrail = [];
    this.openCalls = []; // calls started and not yet reported back — tools run in parallel
    this.subagents = []; // Task calls: {desc, t, ms, done}
    this.planAsked = false; // plan mode was picked but could not be set, so it was asked for in words instead
    this.turnStartedAt = 0; // when the agent started working, 0 while it isn't
    this.waitingSince = 0; // when it started waiting on the user, 0 while it isn't
    this.toolTrailSig = null; // what renderToolTrail last drew (pane-usage.js)
    /* on screen = this pane is in the grid the user is looking at. app.js
     * keeps it honest (setOnScreen, from syncRendererReclaim). Two things
     * read it: the settle-time scans below, which skip the header chips
     * nobody can see, and main's pty batching, which slows down for the
     * sessions behind it. */
    this.onScreen = true;
    this.chipsStale = false; // a scan was skipped while off screen — run it on the way back
    this.lastFocusAt = session.createdAt || Date.now(); // renderer budget: least-recently-focused loses its context first
    livePanes.add(this);

    this.el = elt('section', 'pane');
    this.el.dataset.sessionId = session.id;

    const header = document.createElement('div');
    header.className = 'pane-header';

    this.dot = elt('span', 'pane-dot idle');

    this.taskEl = elt('span', 'pane-task', 'task');
    this.taskEl.dataset.tip = 'Started by a board task';
    this.taskEl.style.display = this.managed ? '' : 'none';

    // role preset this agent was launched with (main/sessions.js ROLES) —
    // persisted on the session, so it survives a reattach after a restart
    this.roleEl = elt('span', 'pane-role');
    if (session.role) {
      this.roleEl.textContent = session.role;
      this.roleEl.dataset.tip = `Launched as a ${session.role} — its own system prompt and model`;
    } else {
      this.roleEl.style.display = 'none';
    }

    // model and effort are drawn in exactly one place at a time — see syncModelChip
    this.effortEl = elt('span', 'pane-effort');
    this.effortEl.style.display = 'none';
    this.effortLabel = '';
    this.effortTip = 'Claude reasoning effort for this agent';

    this.llmEl = elt('span', 'pane-llm');
    this.llmEl.style.display = 'none';
    this.llmEl.addEventListener('click', () => this.openModelPicker());
    // the launch model is session state (sessions.js persists meta.model for
    // restarts), so the chip can show the pick from the first frame instead of
    // waiting for the first turn's ModelUpdate. A Claude tier seeded this way
    // ('Opus') is refined to the resolved id ('Opus 4.8') on that first turn;
    // an agent launched on the account default has nothing to seed and still
    // fills in then.
    const viaOr = !!(session.model && session.model.startsWith('or:'));
    // the harness this agent runs in: 'clean' (agent/clean.js), 'opencode' or
    // 'pi' — all three drop the Claude Code harness entirely, so they share
    // the same OpenRouter bookkeeping and differ only in their label
    this.harness = OpenRouterUI.harnessOf(session.model);
    this.viaClean = OpenRouterUI.isBare(session.model);
    // the OpenRouter slug is also this pane's "not on the Anthropic quota"
    // flag, and the key into the catalog for its real context window
    this.orSlug = OpenRouterUI.slugOf(session.model);
    this.orCtx = 0; // filled from the catalog on the first panel render
    this.modelLabel = (session.model && prettyModelName(this.orSlug || session.model)) || '';
    this.modelTip = this.viaClean ? `Model this agent runs — ${this.harness} agent, straight to OpenRouter`
      : viaOr ? 'Model this agent runs, via OpenRouter' : 'Claude model for this agent';

    this.gitEl = elt('span', 'pane-git');
    this.gitEl.style.display = 'none';
    this.gitEl.addEventListener('click', () => this.openBranchMenu());
    this.gitInfo = null;
    this.branchMenuEl = null;

    this.titleEl = elt('span', 'pane-title', session.agentName);
    this.titleEl.dataset.tip = 'Click to rename';
    this.titleEl.addEventListener('click', () => this.startRename());

    /* the area or folder this agent may edit inside (main/scope.js). The deny
     * rules are in the settings file claude read at startup, so they cannot
     * change under the running process — clicking the chip restarts it with
     * --continue on the picked boundary instead (openScopePicker, pane-git.js),
     * the model picker's mechanism. Every Claude pane wears the chip, dimmed
     * while unscoped, so a boundary can be put on a running agent too; a bare
     * harness (clean/opencode/pi) gets none — no permission layer to deny
     * with, main refuses a scope there. */
    if (!this.viaClean) {
      this.scopeEl = elt('span', 'pane-scope');
      this.scopeEl.addEventListener('click', () => this.openScopePicker());
      if (session.scope && session.scope.paths) {
        this.scopeEl.textContent = session.scope.label;
        this.scopeEl.dataset.tip = `Scoped: may only edit ${session.scope.paths.join(', ')} — everything else in this workspace is denied. Click to switch or lift the boundary (restarts the agent, conversation continues).`;
      } else {
        this.scopeEl.classList.add('off');
        this.scopeEl.innerHTML = Icons.markup('folder');
        this.scopeEl.dataset.tip = 'May edit the whole workspace. Click to confine this agent to one area or folder (restarts the agent, conversation continues).';
      }
    }

    this.modeSel = elt('select', 'pane-mode');
    this.modeSel.dataset.tip = MODE_TIP;
    for (const [value, label] of MODES) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      // relabelled while a plan-mode request is standing but not enforced
      if (value === 'plan') this.planOpt = opt;
      this.modeSel.appendChild(opt);
    }
    // a clean agent has no claude footer to steer — its select maps to the
    // /yolo permission gate instead: manual (gate asks) or auto (gate off).
    // Options skip-permissions launched it with the gate already off.
    if (this.viaClean) {
      this.modeSel.textContent = '';
      for (const [value, label] of [['default', 'manual'], ['bypass', 'auto']]) this.modeSel.add(new Option(label, value));
      this.modeSel.value = skipPermissions ? 'bypass' : 'default';
      this.modeSel.dataset.tip = 'Permission gate — auto runs every tool call without asking (types /yolo into the agent)';
    }
    this.modeSel.addEventListener('keydown', (e) => e.stopPropagation());
    this.modeSel.addEventListener('change', () => this.pickMode(this.modeSel.value));

    /* the select alone reads "auto" with nothing to say what is auto — the pill
     * around it carries the word, and the select keeps every behaviour it had */
    this.modePillEl = elt('span', 'pane-mode-pill');
    this.modePillEl.append(elt('span', 'pane-mode-label', 'mode'), this.modeSel);

    this.modeBusy = false;
    this.modeTimer = null;
    this.modeAskedShown = false;

    // live agent state from Claude Code hooks (tool name + what it is on,
    // waiting, done)
    this.statusEl = elt('span', 'pane-status');
    this.statusEl.style.display = 'none';
    this.statusEl.dataset.tip = 'What this agent is doing';

    // how long the agent has been blocked on the user. A 40-second wait and a
    // 40-minute one are the same pane otherwise, and only one of them is worth
    // walking over to.
    this.waitEl = elt('span', 'pane-wait');
    this.waitEl.style.display = 'none';
    this.waitEl.addEventListener('click', () => this.handlers.onFocus(this));

    // Claude Code's Task subagents, which are otherwise invisible: their whole
    // run is one line of the parent's output
    this.subEl = elt('span', 'pane-sub');
    this.subEl.style.display = 'none';

    // equalizer-style busy indicator, shown only while the agent is working —
    // the shared .sw-busy component (styles/chrome-clean.css), the same one the
    // rail's agent rows use. Lives at the left edge of the usage footer;
    // placeBusy (pane-usage.js) moves it into the header when that is hidden.
    this.busyEl = elt('span', 'sw-busy');
    this.busyEl.style.display = 'none';
    for (let i = 0; i < 5; i++) {
      const bar = document.createElement('span');
      bar.className = 'sw-busy-bar';
      bar.style.animationDelay = `${i * 0.1}s`;
      this.busyEl.appendChild(bar);
    }

    // quick-respond to a live numbered permission prompt (Notification hook
    // event) without opening the pane — reuses the same menu-line parsing as
    // the clickable option links below (MENU_OPTION_RE)
    this.btnApprove = elt('button', 'pane-btn approve');
    this.btnApprove.dataset.tip = 'Approve (shift-click: always allow)';
    this.btnApprove.innerHTML = icon('<path d="M5 12.5l5 5L19 7"/>');
    this.btnApprove.style.display = 'none';
    this.btnApprove.addEventListener('click', (e) => {
      if (!this.respondToPrompt('yes', e.shiftKey)) toast("couldn't read the prompt — open the pane");
    });

    this.btnDeny = elt('button', 'pane-btn deny');
    this.btnDeny.dataset.tip = 'Deny';
    this.btnDeny.innerHTML = icon('<path d="M6 6l12 12M18 6L6 18"/>');
    this.btnDeny.style.display = 'none';
    this.btnDeny.addEventListener('click', () => {
      if (!this.respondToPrompt('no', false)) toast("couldn't read the prompt — open the pane");
    });

    this.badge = elt('span', 'pane-badge');
    this.badge.style.display = 'none';

    // "this Opus agent has only been reading" — click twice to bring it back
    // on Haiku. A button, not a chip: it is the one thing in the header that
    // changes what the agent costs.
    this.readOnlyStreak = 0;
    this.rightsizeEl = elt('button', 'pane-rightsize', '→ Haiku');
    this.rightsizeEl.style.display = 'none';
    this.rightsizeEl.addEventListener('click', () => {
      Confirm.armOrFire(this.rightsizeEl, 'rightsize:' + this.session.id, () => {
        this.readOnlyStreak = 0;
        this.syncRightsize(); // the offer goes away with the agent it was for
        this.handlers.onRestart(this, { resume: true, model: 'haiku' });
      });
    });

    const btnMic = elt('button', 'pane-btn mic');
    btnMic.dataset.tip = 'Dictate (click to start/stop, Ctrl+R) — say "send it" to submit, double-click for hands-free';
    btnMic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>';
    // closing the pane mid-dictation must release the mic (see dispose).
    // Double-click arms hands-free: "send it" still submits, but the mic stays
    // open for the next prompt instead of closing, until a second double-click
    // (or anything else that stops dictation) ends it.
    let dictating = false;
    const mic = Speech.wire(btnMic, {
      onStart: () => { dictating = true; },
      onEnd: () => { dictating = false; this.setHandsFree(false); },
      onDouble: () => {
        if (this.handsFree) { this.stopDictation(); return; }
        this.setHandsFree(true);
        if (!dictating) mic.toggle();
      },
      onResult: (text) => {
        if (!text) return;
        const submit = DICTATE_SUBMIT.test(text);
        const body = submit ? text.replace(DICTATE_SUBMIT, '') : text;
        if (body) this.term.paste(submit ? body : body + ' ');
        if (!submit) return;
        if (!this.handsFree) this.stopDictation();
        setTimeout(() => {
          if (!this.exited) window.swarm.writeSession(this.session.id, '\r');
        }, DICTATE_SUBMIT_DELAY_MS);
      },
    });
    this.handsFree = false;
    this.setHandsFree = (on) => {
      this.handsFree = on;
      btnMic.classList.toggle('hands-free', on);
    };
    this.toggleDictation = mic.toggle;
    this.stopDictation = mic.stop;

    /* /clear: wipes the agent's conversation context without restarting the
     * process. Hidden on the harnesses that have no such command — the clean
     * agent (`oc:`), opencode and pi; an `or:` model runs inside Claude Code
     * and takes it like any other. */
    this.btnClear = elt('button', 'pane-btn clear');
    this.btnClear.dataset.tip = "Clear this agent's context (/clear)";
    this.btnClear.innerHTML = icon('<path d="M20 20H8.5L3.6 15a1.4 1.4 0 0 1 0-2L12.8 3.8a1.4 1.4 0 0 1 2 0l5.2 5.2a1.4 1.4 0 0 1 0 2L11.5 20"/><path d="M6.5 10.5l7 7"/>');
    if (/^(oc|opencode|pi):/.test(this.session.model || '')) this.btnClear.style.display = 'none';
    this.btnClear.addEventListener('click', () => {
      if (this.exited) return;
      window.swarm.writeSession(this.session.id, '/clear\r');
    });

    const btnMax = elt('button', 'pane-btn max');
    btnMax.dataset.tip = 'Maximize / restore (Ctrl+Shift+M)';
    btnMax.innerHTML = icon('<path d="M9 4H4v5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M4 15v5h5"/>');
    btnMax.addEventListener('click', () => handlers.onMaximize(this));

    this.btnSplitRight = elt('button', 'pane-btn split-right');
    this.btnSplitRight.dataset.tip = 'Open a new agent to the right';
    this.btnSplitRight.innerHTML = icon('<path d="M4 12h15"/><path d="M13.5 6.5L19 12l-5.5 5.5"/>');
    this.btnSplitRight.addEventListener('click', () => handlers.onSplit(this, 'right'));

    this.btnSplitDown = elt('button', 'pane-btn split-down');
    this.btnSplitDown.dataset.tip = 'Open a new agent below';
    this.btnSplitDown.innerHTML = icon('<path d="M12 4v15"/><path d="M6.5 13.5L12 19l5.5-5.5"/>');
    this.btnSplitDown.addEventListener('click', () => handlers.onSplit(this, 'down'));
    this.syncSplitButtons();

    this.btnClose = elt('button', 'pane-btn close');
    this.btnClose.dataset.tip = 'Close session';
    this.btnClose.innerHTML = icon('<path d="M6 6l12 12M18 6L6 18"/>');
    // mousedown, not click: a click needs down+up on the same element and
    // can get eaten by focus/layout churn in between — mousedown cannot
    this.btnClose.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // killing a pane shouldn't also focus it
      e.preventDefault();
      this.requestClose();
    });

    // one cluster in two groups — what the agent does, what happens to its
    // window — told apart by a hairline rather than a gap
    const actions = document.createElement('span');
    actions.className = 'pane-actions';
    actions.append(
      this.btnClear, btnMic, elt('span', 'pane-actions-div'),
      btnMax, this.btnSplitRight, this.btnSplitDown, this.btnClose
    );

    header.append(
      this.dot, this.taskEl, this.roleEl, this.effortEl, this.llmEl, this.gitEl, this.titleEl, this.statusEl, this.waitEl, this.subEl, this.btnApprove, this.btnDeny, this.modePillEl, this.rightsizeEl, this.badge, actions
    );
    // its own statement rather than a slot in the append above: that line is
    // the header's whole running order and every pane feature edits it
    if (this.scopeEl) header.insertBefore(this.scopeEl, this.titleEl);

    // search row (hidden until toggled)
    this.searchEl = elt('div', 'pane-search');
    this.searchEl.style.display = 'none';
    this.searchInput = document.createElement('input');
    this.searchInput.placeholder = 'search';
    this.searchInput.spellcheck = false;
    const sPrev = elt('button', null, '↑');
    sPrev.dataset.tip = 'Previous match';
    const sNext = elt('button', null, '↓');
    sNext.dataset.tip = 'Next match';
    const sClose = elt('button', null, '✕');
    sClose.dataset.tip = 'Close search (Esc)';
    this.searchEl.append(this.searchInput, sPrev, sNext, sClose);

    // second header row, under the main one — the most recent command
    // entered in this pane (the task prompt it was launched with, until the
    // user types a new line, which then takes over); hidden unless both the
    // option is on and there is a command to show
    this.subheaderEl = elt('div', 'pane-subheader');
    this.subheaderEl.style.display = 'none';
    const subheaderBar = elt('span', 'pane-subheader-bar');
    this.subheaderTextEl = elt('span', 'pane-subheader-text');
    this.subheaderEl.append(subheaderBar, this.subheaderTextEl);
    this.initialCommandText = '';
    // survives a reattach after the app was closed and reopened — tmux keeps
    // the agent alive but remembers nothing of what was typed into it, so the
    // subheader would otherwise go blank on every restart
    this.typedInitialCommand = session.lastCommand || null;
    this.typedLineBuffer = '';

    this.termEl = elt('div', 'pane-term');

    // bottom panel: what this agent has spent and how full its context is.
    // One row of capsules, each pill one reading — it wraps to a second line
    // rather than truncate when the pane is too narrow to hold them side by
    // side. Hidden entirely unless the option is on.
    this.usageEl = elt('div', 'pane-usage');
    this.usageEl.style.display = 'none';

    // context: the meter and the tokens it counts, in one pill
    this.usageBarEl = elt('span', 'pane-usage-bar');
    this.usageBarFillEl = document.createElement('i');
    this.usageBarEl.appendChild(this.usageBarFillEl);
    this.usageCtxEl = elt('span', 'pane-usage-ctx');
    const capCtx = elt('span', 'pane-usage-cap');
    capCtx.append(this.usageBarEl, this.usageCtxEl);

    // spend: what it cost, and how much of the input the cache paid for
    this.usageCostEl = elt('span', 'pane-usage-cost');
    this.usageCacheEl = elt('span', 'pane-usage-cache');
    this.usageCostCapEl = elt('span', 'pane-usage-cap');
    this.usageCostCapEl.append(this.usageCostEl, elt('span', 'pane-usage-div'), this.usageCacheEl);

    // the turn: the header dot's state repeated beside the clock it explains
    // (pane-status syncStatus keeps both in step), then turns and the 5h share
    this.usageDotEl = elt('span', 'pane-dot pane-usage-dot idle');
    this.usageTurnsEl = document.createElement('span');
    this.usageTimeEl = document.createElement('span');
    this.usageShareEl = document.createElement('span');
    const capRun = elt('span', 'pane-usage-cap pane-usage-run');
    capRun.append(this.usageDotEl, this.usageTimeEl, this.usageTurnsEl, this.usageShareEl);

    // the tool trail, opening the row's right half — the one place that says
    // what the agent is doing right now, newest tool carrying the weight
    this.usageToolsEl = elt('span', 'pane-usage-cap pane-usage-tools');

    // which upstream this agent talks to, left of the effort. Fixed at launch:
    // main persists meta.model for OpenRouter agents alone, so the 'or:' prefix
    // is the whole signal, and a restart builds a fresh Pane rather than
    // mutating this one.
    this.usageProviderEl = elt('span', 'pane-usage-provider', this.viaClean ? 'OpenRouter · ' + this.harness : viaOr ? 'OpenRouter' : 'Anthropic');
    this.usageProviderEl.dataset.tip = this.viaClean
      // pi has no permission prompts at all — its author considers them
      // security theatre — so it runs unattended whatever the Options toggle
      // says, and the chip is where that is admitted
      ? (this.harness === 'pi' ? 'pi agent — straight to OpenRouter, no Claude Code. Always auto: pi gates no tool calls'
        : `${this.harness === 'clean' ? 'Clean' : this.harness} agent — straight to OpenRouter, no Claude Code`)
      : viaOr ? 'Runs through OpenRouter' : 'Runs on Anthropic';
    this.usageEffortEl = elt('span', 'pane-usage-effort');
    this.usageModelEl = elt('span', 'pane-usage-model');
    this.usageModelEl.addEventListener('click', () => this.openModelPicker());
    // provider / effort / model ride the row's right edge as one outlined pill,
    // the only capsule that is drawn rather than filled
    const usageRight = elt('span', 'pane-usage-cap pane-usage-right');
    usageRight.append(this.usageProviderEl, this.usageEffortEl, this.usageModelEl);

    // the row's two halves: the readings on the left, what the agent is running
    // on the right. Grouped so the right half still sits right when the tool
    // trail is empty and hidden.
    const usageEnd = elt('span', 'pane-usage-end');
    usageEnd.append(this.usageToolsEl, usageRight);
    /* the equalizer opens the row, left of every reading — syncUsagePanel
     * (placeBusy, pane-usage.js) parks it back in the header while the panel
     * is switched off, so the busy signal is never lost with it */
    this.usageRowEl = elt('div', 'pane-usage-row');
    const usageRow = this.usageRowEl;
    usageRow.append(capCtx, this.usageCostCapEl, capRun, usageEnd);
    this.usageEl.append(usageRow);

    this.el.append(header, this.subheaderEl, this.searchEl, this.termEl, this.usageEl);
    this.syncInitialCommandHeader();
    this.syncUsagePanel();

    this.term = new Terminal({
      // the pty is spawned at 100×30 (see createSession / _launch), and refit()
      // can't correct that until the pane is on screen — an agent started in a
      // workspace nobody is looking at would otherwise take 100-column rows
      // into xterm's 80×24 default and mangle its buffer for good
      cols: 100,
      rows: 30,
      theme: activeXtermTheme,
      // per-cell readability on the light themes — see the pass above
      minimumContrastRatio: activeMinContrast,
      // opaque, so the glyph atlas gets subpixel antialiasing — see paneTheme
      allowTransparency: false,
      fontFamily: activeMonoFont,
      fontSize: activeFontSize,
      fontWeight: activeFontWeight,
      fontWeightBold: boldFor(activeFontWeight),
      lineHeight: 1.15,
      cursorBlink: true,
      // a completed task's transcript popup reads straight from this buffer
      // (see getBufferText below) — too small a cap silently evicts the
      // start of a long session before it ever gets captured
      scrollback: 20000,
      allowProposedApi: true,
      // native OSC 8 hyperlinks (an agent can re-open a full link span on
      // every row a long URL wraps across) — without this, xterm's built-in
      // fallback is a confirm() dialog plus window.open, which does nothing
      // useful in Electron. WebLinksAddon below covers plain-text URLs; this
      // covers OSC 8 ones the same way.
      linkHandler: {
        activate: (_event, uri) => window.swarm.openExternal(uri),
      },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.swarm.openExternal(uri)));

    // clicking a numbered menu line (e.g. Claude's "1. Yes  2. No" prompts)
    // sends that option's digit key to the pty, same as typing it
    this.term.registerLinkProvider({
      provideLinks: (lineNum, callback) => {
        const line = this.term.buffer.active.getLine(lineNum - 1);
        const text = line && line.translateToString(true);
        const m = text && MENU_OPTION_RE.exec(text);
        if (!m) return callback(undefined);
        callback([{
          range: { start: { x: m[1].length + 1, y: lineNum }, end: { x: text.length + 1, y: lineNum } },
          text: m[2],
          activate: () => {
            if (this.exited) return;
            window.swarm.writeSession(session.id, m[2]);
          },
        }]);
      },
    });

    // a TUI can switch on terminal mouse reporting (DECSET 1000/1002/1006…),
    // which would make xterm hand every click to the app — breaking text
    // selection, copy, and both link providers above. Nothing here wants raw
    // mouse reporting — clicks are handled client-side, and the one event tmux
    // does act on (the wheel) is synthesized by the wheel listener below — so
    // swallow the requests and keep the mouse local.
    const MOUSE_DECSET = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
    for (const final of ['h', 'l']) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) =>
        params.every((p) => MOUSE_DECSET.has(p)));
    }

    this.term.open(this.termEl);

    // GPU renderer; falls back to the DOM renderer on failure/context loss
    this.webgl = null;
    this.rendererDropped = false; // true while a hidden pane's context is released (see dropRenderer)
    this.attachWebgl();

    // attention: terminal bell, plus OSC 9 / OSC 777 desktop-notification sequences
    this.term.onBell(() => this.flagAttention());
    this.term.parser.registerOscHandler(9, () => { this.flagAttention(); return true; });
    this.term.parser.registerOscHandler(777, () => { this.flagAttention(); return true; });

    // shortcuts are executed by the document-level handler; returning false
    // here just keeps xterm from also acting on the keystroke
    this.term.attachCustomKeyEventHandler((e) => {
      // Ctrl+C with an active selection copies it (Windows Terminal
      // convention) instead of interrupting the agent — xterm itself has no
      // copy path for Ctrl+C: it would send ^C to the pty and clear the
      // selection, making copying from a pane impossible. Interrupt still
      // works with nothing selected (or after a click to deselect).
      if (e.type === 'keydown' && e.code === 'KeyC' && e.ctrlKey
          && !e.shiftKey && !e.altKey && !e.metaKey && this.term.hasSelection()) {
        window.swarm.copyText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      // Ctrl+V pastes on Windows, the other half of that convention. xterm
      // maps Ctrl+V to ^V and calls preventDefault on the keystroke, which
      // also cancels Chromium's own paste — so nothing ever reached the
      // agent. Returning false leaves the default action alone: the browser
      // pastes into xterm's textarea and xterm's paste handler writes it to
      // the pty (bracketed when the TUI asked for it). macOS is untouched —
      // ⌘V is already native there, and Ctrl+V stays a literal ^V.
      if (e.type === 'keydown' && e.code === 'KeyV' && e.ctrlKey
          && !e.altKey && !e.metaKey && !window.swarm.isMac) {
        return false;
      }
      // Shift+Insert, the other terminal paste key. Nothing native to lean
      // on here — xterm turns Insert into an escape sequence — so read the
      // clipboard and paste it, and cancel the keystroke so a browser that
      // does bind Shift+Insert cannot paste a second copy.
      if (e.type === 'keydown' && e.code === 'Insert' && e.shiftKey
          && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        this.pasteClipboard();
        return false;
      }
      return !handlers.onShortcut(e);
    });

    this.term.onData((data) => {
      if (this.exited) return;
      this.lastInputAt = Date.now();
      this.clearAttention();
      this.captureInitialCommand(data);
      window.swarm.writeSession(session.id, data);
    });

    // Wheel over the output scrolls the agent's history; over the input box
    // at the bottom it stays Up/Down, which is what cycles previous prompts.
    //
    // xterm's own scrollback is empty here — the tmux attach client paints on
    // the alternate buffer — and its alternate-scroll fallback turns every
    // notch anywhere into an Up/Down keypress, which is why scrolling used to
    // walk the prompt history instead of the transcript. tmux holds the real
    // scrollback, so forward the notch to it as an SGR mouse event (see
    // WHEEL_LINES in sessions.js). Without tmux there is no alternate buffer
    // and xterm's native scrollback works — leave that case alone.
    //
    // The report carries the real cell, column included: tmux only reads the
    // coordinates to pick a pane, but a harness that asked for the mouse gets
    // the event forwarded and hit-tests it against its own layout. opencode
    // ignores a notch on column 1 — its transcript starts further right — and
    // scrolls on one over the text, which is why a hardcoded column 1 scrolled
    // Claude panes but not opencode ones.
    this.termEl.addEventListener('wheel', (e) => {
      if (this.exited || this.term.buffer.active.type !== 'alternate') return;
      e.preventDefault();
      e.stopPropagation(); // capture phase: keep xterm from also alt-scrolling
      this.lastInputAt = Date.now(); // tmux repaints on scroll — not agent activity
      const up = e.deltaY < 0;
      const [col, row] = this.cellAt(e.clientX, e.clientY);
      if (row >= this.inputBoxTop()) {
        window.swarm.writeSession(session.id, up ? '\x1b[A' : '\x1b[B');
        return;
      }
      window.swarm.writeSession(session.id, `\x1b[<${up ? 64 : 65};${col + 1};${row + 1}M`);
    }, { capture: true, passive: false });

    const sGo = (forward) => {
      const q = this.searchInput.value;
      if (!q) return;
      if (forward) this.search.findNext(q); else this.search.findPrevious(q);
    };
    this.searchInput.addEventListener('input', () => {
      const q = this.searchInput.value;
      if (q) this.search.findNext(q, { incremental: true });
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { sGo(!e.shiftKey); e.preventDefault(); }
      if (e.key === 'Escape') { this.toggleSearch(false); e.preventDefault(); }
      e.stopPropagation();
    });
    sPrev.addEventListener('click', () => sGo(false));
    sNext.addEventListener('click', () => sGo(true));
    sClose.addEventListener('click', () => this.toggleSearch(false));

    this.el.addEventListener('mousedown', () => {
      document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
      this.el.classList.add('focused');
      this.clearAttention();
      handlers.onFocus(this);
    });

    // dropping files/images onto the terminal pastes their paths for the agent
    this.termEl.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = this.exited ? 'none' : 'copy';
      this.el.classList.toggle('file-drop', !this.exited);
    });
    this.termEl.addEventListener('dragleave', () => this.el.classList.remove('file-drop'));
    this.termEl.addEventListener('drop', (e) => {
      this.el.classList.remove('file-drop');
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      if (this.exited) return;
      const paths = droppedPaths(e);
      if (!paths.length) return;
      // paste, not raw write: respects bracketed-paste mode in the TUI
      this.term.paste(paths.join(' ') + ' ');
      this.focus();
    });

    // right-click pastes (the Windows Terminal convention): a pane has no
    // context menu of its own for it to compete with, and the selection is
    // left alone so Ctrl+C still copies it
    this.termEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.pasteClipboard();
    });

    let fitTimer = null;
    this.observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => this.refit(), 50);
    });
    this.observer.observe(this.termEl);
  }

  /* Take xterm's GPU renderer, or leave the DOM one in place if the context
   * can't be had. A lost context detaches it exactly the way dropRenderer
   * does, so restoreRenderer can come back for it later.
   *
   * The GPU renderer keeps rasterised glyphs in a texture atlas of a few pages,
   * and once it runs out of pages it merges the least-used ones. That merge has
   * an upstream bug: glyphs that lived on a merged page come back blank, and
   * the pane then draws a screen with, say, every bold `f` missing — a long
   * colourful agent answer in one big pane is exactly what fills the atlas
   * (seen for real on 2026-08-14). Nothing is wrong with the buffer, only with
   * the GPU's cache of already-drawn characters, so the answer is to throw that
   * cache away before the merging starts and let the visible cells rasterise
   * again. A page is only added when the previous one fills, which makes the
   * addon's own page event the cheapest possible signal — no timer, and nothing
   * at all for a pane whose output is modest. */
  attachWebgl() {
    if (this.webgl) return;
    /* Over budget (MAX_WEBGL_PANES): stay on the DOM renderer rather than
     * asking for a context Chromium would answer by killing someone else's.
     * Marked dropped, so the reclaim pass in app.js can hand this pane a
     * context the moment one is free. */
    if (webglPanes.size >= MAX_WEBGL_PANES) { this.rendererDropped = true; return; }
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        try { webgl.dispose(); } catch { /* already gone */ }
        webglPanes.delete(this);
        this.webgl = null;
        this.rendererDropped = true; // free to come back when the pass next runs
      });
      webgl.onAddTextureAtlasCanvas(() => {
        if (++atlasPages < ATLAS_PAGE_LIMIT) return;
        if (Date.now() - atlasClearedAt < ATLAS_CLEAR_MIN_MS) return; // never thrash
        atlasPages = 0;
        atlasClearedAt = Date.now();
        this.redrawGlyphs(); // scheduled onto the next frame there
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
      webglPanes.add(this);
    } catch { /* DOM renderer it is */ }
  }

  /* Drop the GPU glyph cache and draw the visible rows again. Safe at any
   * time — it costs one re-rasterisation of what is on screen, which is what
   * changing the font size already does.
   *
   * Every pane goes through it, not just this one, because the atlas behind it
   * is shared (see the counters in pane-const.js). A pane that did not ask for
   * the clear keeps a render model whose cells still point at the coordinates
   * their glyphs used to sit on, and its renderer re-rasterises a cell only
   * when the model says it changed — so it goes on drawing whatever landed on
   * those coordinates afterwards, i.e. shredded fragments of other characters
   * (seen for real on 2026-08-14). Clearing every pane's model in the same
   * frame is what makes them all come back correct: no pane can re-fill the
   * atlas until the loop is done and rendering resumes on the next frame. */
  redrawGlyphs() {
    if (!this.webgl || atlasRebuild) return;
    atlasRebuild = requestAnimationFrame(() => {
      atlasRebuild = 0;
      for (const pane of livePanes) {
        if (!pane.webgl) continue;
        try { pane.webgl.clearTextureAtlas(); } catch { /* addon disposed under us */ }
        try { pane.term.refresh(0, pane.term.rows - 1); } catch { /* terminal gone */ }
      }
    });
  }

  /* ---- wheel scrolling (see the wheel listener above) ---- */

  /* 0-based terminal cell [col, row] under a viewport point. Both the screen
   * element and its rect are cached: this runs once per wheel notch — around a
   * hundred a second on a trackpad flick — and getBoundingClientRect forces a
   * layout flush. refit() drops the rect, which covers everything that moves
   * or resizes the terminal. */
  cellAt(x, y) {
    const screen = this.screenEl || (this.screenEl = this.termEl.querySelector('.xterm-screen'));
    if (!screen) return [0, 0];
    const r = this.screenRect || (this.screenRect = screen.getBoundingClientRect());
    const col = Math.floor((x - r.left) / (r.width / this.term.cols));
    const row = Math.floor((y - r.top) / (r.height / this.term.rows));
    return [Math.min(this.term.cols - 1, Math.max(0, col)),
      Math.min(this.term.rows - 1, Math.max(0, row))];
  }

  /* First row of Claude's input box. The prompt marker is the only reliable
   * sign of it from the outside: the box is drawn as two plain `─` rules,
   * indistinguishable from a separator in the transcript, but `❯` sits on the
   * box's first text row and the input box is always the last thing on the
   * screen — so the lowest `❯` is the live prompt (the ones above it are
   * echoed messages), and the rule above it is where the box starts. No
   * prompt (a plain shell, an overlay like `/help`, a permission dialog)
   * means no input area, so the whole pane scrolls. */
  inputBoxTop() {
    const buf = this.term.buffer.active;
    for (let i = this.term.rows - 1; i >= 0; i--) {
      const line = buf.getLine(buf.viewportY + i);
      const text = line && line.translateToString(true).trim();
      if (text && text.startsWith('❯')) return Math.max(0, i - 1);
    }
    return this.term.rows;
  }

  /* ---- status: exited > attention > working/idle ---- */

  get status() {
    if (this.exited) return 'exited';
    if (this.attention) return 'attention';
    return this.working ? 'working' : 'idle';
  }

  /* Last `n` buffer lines as plain text. Shared by every settle-time scan
   * (mode, model, trust/bypass dialogs) so a single pass over the buffer —
   * translateToString is the expensive part — serves all of them. */
  tailLines(n) {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows;
    const start = Math.max(0, end - n);
    const lines = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /* Live /model switches print "Set model to X and saved as your default…",
   * or "…for this session only" when the picker was left with `s` — caught
   * straight from the rendered buffer, same technique as permission mode, so
   * a mid-session switch updates the chip with no extra plumbing. */
  syncModelFromBuffer(lines = this.tailLines(30)) {
    if (this.exited) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /Set model to\s+([^\n]+?)(?:\s+(?:and saved|for this session)\b.*)?$/i.exec(lines[i]);
      // through prettyModelName like the launch and ModelUpdate paths, so a
      // switch doesn't leave the chip spelling the same model differently
      if (m) { this.setModel(prettyModelName(m[1].trim()) || m[1].trim()); return; }
    }
  }

  /* `/effort <level>` prints "Set effort level to high (this session only): …"
   * ("Effort level set to auto …" when cleared, "Current effort level: high"
   * from a bare `/effort current`) — read off the buffer exactly like the
   * model, so a manual switch updates the chip with no extra plumbing. */
  syncEffortFromBuffer(lines = this.tailLines(30)) {
    if (this.exited) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      // the level itself is spelled out, so the failure lines ("Failed to set
      // effort level: …") can't be mistaken for a level
      const m = /(?:Set effort level to|Effort level(?: set to)?:?)\s+(low|medium|high|xhigh|max|ultracode|auto)\b/i.exec(lines[i]);
      if (m) { this.setEffort(m[1].toLowerCase()); return; }
    }
  }

  /* Accept the blocking dialogs auto mode can't get past on its own (see
   * AUTO_ACCEPT_DIALOGS): each pre-highlights its accepting option, so
   * accepting is just pressing Enter — the same mechanism tryInjectPrompt
   * (app.js) uses to submit an initial task. Each fires at most once per
   * pane, and only when the user actually opted into auto mode. */
  autoAcceptDialogs(lines = this.tailLines(30)) {
    const text = lines.join('\n');
    for (const [flag, re] of AUTO_ACCEPT_DIALOGS) {
      if (this.exited || this[flag] || !re.test(text)) continue;
      this[flag] = true;
      if (skipPermissions) window.swarm.writeSession(this.session.id, '\r');
    }
  }

  /* ---- claude permission mode ---- */

  /* Read the mode from claude's footer ("⏸ plan mode on", "⏵⏵ accept edits
   * on", "⏵⏵ bypass permissions on") in the last rows of the buffer. No
   * marker = default mode (or the footer is hidden — same answer either way). */
  detectMode(lines = this.tailLines(12)) {
    const text = lines.slice(-12).join('\n');
    for (const [mode, re] of MODE_MARKERS) {
      if (re.test(text)) return mode;
    }
    return 'default';
  }

  /* The dropdown as the user drives it — setMode is the mechanism, this is the
   * intent, and `plan` is the one mode with a fallback: when the switch cannot
   * be made (a dialog is up, the agent is mid-turn) the same thing is asked for
   * in words, which the agent can ignore — so the select says `plan (asked)`
   * rather than claiming plan mode it did not get. */
  async pickMode(target) {
    // clean agents: the pick is a /yolo command, not a Shift+Tab dance
    if (this.viaClean) {
      this.say('/yolo ' + (target === 'bypass' ? 'on' : 'off'));
      this.modeSel.value = target === 'bypass' ? 'bypass' : 'default'; // no-op user-driven, honest when a task drives it
      return;
    }
    const wasAsked = this.planAsked;
    this.planAsked = false;
    const asking = target === 'plan';
    const switched = await this.setMode(target, { quiet: asking });
    if (asking && !switched) {
      this.planAsked = true;
      this.say(READ_ONLY_ASK);
      toast(`could not set plan mode — asked ${this.session.agentName} to stop editing instead`);
    } else if (wasAsked && !asking) {
      this.say(READ_ONLY_LIFT); // the request stands until it is taken back in words
    }
    this.syncMode();
  }

  /* Type a line into the agent and submit it, the way the message box does. */
  say(text) {
    window.swarm.writeSession(this.session.id, text);
    setTimeout(() => {
      if (!this.exited) window.swarm.writeSession(this.session.id, '\r');
    }, DICTATE_SUBMIT_DELAY_MS);
  }

  /* Step Shift+Tab until the footer shows the target. One full lap is at
   * most 4 presses; if the target never appears (bypass not enabled, or a
   * dialog is eating keys) walk on back to where we started. Returns whether
   * the target was reached, so a caller applying a saved default can lap
   * again; `quiet` suppresses the toast on those non-final attempts. */
  async setMode(target, { quiet = false } = {}) {
    if (this.exited || this.modeBusy) return false;
    this.modeBusy = true;
    // only refocus the terminal if this pane had focus to begin with (the
    // user-picked dropdown case) — a scheduler-started task's setMode must
    // not steal the keyboard from whatever pane the user is typing in
    const hadFocus = this.el.contains(document.activeElement);
    try {
      const start = this.detectMode();
      let mode = start;
      for (let i = 0; i < 4 && mode !== target; i++) {
        window.swarm.writeSession(this.session.id, SHIFT_TAB);
        await new Promise((r) => setTimeout(r, MODE_STEP_MS));
        mode = this.detectMode();
      }
      if (mode !== target) {
        for (let i = 0; i < 4 && mode !== start; i++) {
          window.swarm.writeSession(this.session.id, SHIFT_TAB);
          await new Promise((r) => setTimeout(r, MODE_STEP_MS));
          mode = this.detectMode();
        }
        if (!quiet) {
          toast(target === 'bypass'
            ? 'auto mode is off in this agent — enable it in ⌨ Options, then restart the agent'
            : 'could not switch mode — is claude showing a dialog?');
        }
      }
      this.modeSel.value = mode;
      return mode === target;
    } finally {
      this.modeBusy = false;
      if (hadFocus) this.term.focus();
    }
  }

  /* Runs on every buffer scan, so the label and tooltip only move when the
   * asked state actually flips. While a request is standing the select holds
   * `plan` rather than following the footer, which reads `default` — the footer
   * is right about the permission mode and wrong about what was asked for.
   * Until the user moves the mode in the agent itself: plan reached by hand
   * turns the request into the rule it asked for, any other mode takes it
   * back, and either way the footer is now the newer answer. */
  syncMode(lines) {
    // a clean pane's select holds what the user picked — there is no footer
    // to read back, and scanning would reset it to 'manual' on every write
    if (this.exited || this.modeBusy || this.viaClean) return;
    const mode = this.detectMode(lines);
    if (this.planAsked && mode !== 'default') this.planAsked = false;
    const asked = this.planAsked;
    this.modeSel.value = asked ? 'plan' : mode;
    if (asked === this.modeAskedShown) return;
    this.modeAskedShown = asked;
    this.modeSel.classList.toggle('asked', asked);
    this.planOpt.textContent = asked ? 'plan (asked)' : 'plan';
    this.modeSel.dataset.tip = asked
      ? `Asked ${this.session.agentName} to stop editing — plan mode could not be set from here, so it is a request, not a rule. Pick another mode to lift it.`
      : MODE_TIP;
  }

  /* ---- focus view ---- */

  /* `/focus` toggles claude's "Focus view" — it is NOT off by default, so
   * blindly sending it (as a task's focus checkbox used to) can just as
   * easily turn it off as on. The footer shows a right-aligned "focus" pill
   * on the very last row while it's active; only the last row is checked
   * since "focus" alone is too common a word to safely match higher up in
   * the scrollback. */
  detectFocus(lines = this.tailLines(1)) {
    return /\bfocus\b/i.test(lines[lines.length - 1] || '');
  }

  /* ---- last-command header row ----
   * Shows the most recently submitted command in this pane's terminal,
   * reconstructed from the user's own keystrokes: best-effort, since raw
   * terminal input includes backspaces, arrow keys and pastes, but good
   * enough for the common case of typing (or pasting) a message and hitting
   * Enter. A task-started pane starts out showing its launch prompt (from
   * app.js's getPaneInitialPrompt) until the user types a new line, which
   * then takes over — see syncInitialCommandHeader. */
  captureInitialCommand(data) {
    // a full bracketed-paste chunk: unwrap it and treat embedded newlines as
    // literal content, not as Enter submitting the line
    const pasteMatch = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
    if (pasteMatch) {
      this.typedLineBuffer += pasteMatch[1].replace(/[\r\n]+/g, ' ');
      return;
    }
    if (data.charCodeAt(0) === 0x1b) return; // other escape sequences (arrow keys, etc.) — ignore whole chunk
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = this.typedLineBuffer.trim();
        this.typedLineBuffer = '';
        if (!line) continue; // blank Enter (e.g. dismissing a splash screen) — keep waiting
        this.typedInitialCommand = line;
        this.syncInitialCommandHeader();
        this.handlers.setLastCommand(this, line);
        return;
      }
      if (ch === '\x7f' || ch === '\b') { this.typedLineBuffer = this.typedLineBuffer.slice(0, -1); continue; }
      if (ch.charCodeAt(0) < 0x20) continue; // other control bytes
      this.typedLineBuffer += ch;
    }
  }

  /* Called explicitly by app.js whenever a task's prompt text becomes known
   * (task start) or the option is toggled, and by captureInitialCommand
   * above every time the user submits a new line. Once the user has typed
   * anything, that takes precedence over the task's original launch prompt
   * — the header tracks the latest command, not just the first one. */
  syncInitialCommandHeader() {
    const prompt = this.handlers.getPaneInitialPrompt && this.handlers.getPaneInitialPrompt(this.session.id);
    this.initialCommandText = this.typedInitialCommand || prompt || '';
    // the title/dot hover shows a task's prompt (not a manually typed first
    // line) — same data-tip system as every other hint in the app, so
    // tooltip.js owns the delay, placement and dismissal
    this.titleEl.dataset.tip = prompt || 'Click to rename';
    if (prompt) this.dot.dataset.tip = prompt; else delete this.dot.dataset.tip;
    this.subheaderTextEl.textContent = this.initialCommandText;
    this.subheaderEl.style.display = (showInitialCommand && this.initialCommandText) ? '' : 'none';
  }

  /* Called at construction and whenever the "Auto-organize agent windows"
   * option is toggled — the split buttons are how you place agents by hand,
   * so they're only useful while auto-organize is off. */
  syncSplitButtons() {
    this.btnSplitRight.style.display = autoOrganize ? 'none' : '';
    this.btnSplitDown.style.display = autoOrganize ? 'none' : '';
  }

  /* ---- rename ---- */

  startRename() {
    if (this.titleEl.isContentEditable) return;
    const orig = this.session.agentName;
    this.titleEl.contentEditable = 'plaintext-only';
    this.titleEl.focus();
    document.getSelection().selectAllChildren(this.titleEl);

    const commit = (keep) => {
      // remove, don't set 'false': [contenteditable] CSS matches any value,
      // so a leftover attribute keeps the edit outline on forever
      this.titleEl.removeAttribute('contenteditable');
      const name = (keep ? this.titleEl.textContent : orig).trim().slice(0, NAME_MAX) || orig;
      this.titleEl.textContent = name;
      document.getSelection().removeAllRanges();
      if (name !== orig) {
        this.session.agentName = name;
        this.handlers.onRename(this, name);
      }
      this.term.focus();
    };
    // typing past the limit would grow the box past the header room it has
    const onInput = () => {
      if (this.titleEl.textContent.length <= NAME_MAX) return;
      this.titleEl.textContent = this.titleEl.textContent.slice(0, NAME_MAX);
      const r = document.createRange();
      r.selectNodeContents(this.titleEl);
      r.collapse(false);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.titleEl.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); this.titleEl.textContent = orig; this.titleEl.blur(); }
    };
    // pressing on non-focusable chrome never blurs the title by itself —
    // force the edit to end on any mousedown outside it
    const onDocDown = (e) => {
      if (!this.titleEl.isConnected) {
        document.removeEventListener('mousedown', onDocDown, true);
        return;
      }
      if (e.target !== this.titleEl) this.titleEl.blur();
    };
    document.addEventListener('mousedown', onDocDown, true);
    this.titleEl.addEventListener('keydown', onKey);
    this.titleEl.addEventListener('input', onInput);
    this.titleEl.addEventListener('blur', () => {
      document.removeEventListener('mousedown', onDocDown, true);
      this.titleEl.removeEventListener('keydown', onKey);
      this.titleEl.removeEventListener('input', onInput);
      commit(true);
    }, { once: true });
  }

  /* ---- search ---- */

  toggleSearch(show = this.searchEl.style.display === 'none') {
    this.searchEl.style.display = show ? '' : 'none';
    if (show) {
      this.searchInput.focus();
      this.searchInput.select();
    } else {
      this.search.clearDecorations();
      this.term.focus();
    }
    requestAnimationFrame(() => this.refit());
  }

  /* ---- close with confirm ---- */

  requestClose() {
    if (this.exited) {
      this.handlers.onClose(this);
      return;
    }
    // the app-wide Confirm, like ↻ and → Haiku above: arming this ✕ disarms
    // any other armed control, and one arm window everywhere
    const fired = Confirm.armOrFire(this.btnClose, 'close:' + this.session.id, () => {
      this.handlers.onClose(this);
    });
    if (!fired) {
      this.btnClose.dataset.tip = 'Click again to kill this agent';
      toast(`click ✕ again to kill ${this.session.agentName}`);
    }
  }

  disarmClose() {
    // only if this pane's ✕ is what is armed — Confirm tracks one arm app-wide
    if (this.btnClose.classList.contains('armed')) Confirm.disarm();
    this.btnClose.dataset.tip = 'Close session';
  }

  /* ---- misc ---- */

  setFontSize(px) {
    const size = Math.max(8, Math.min(24, px));
    if (size === this.term.options.fontSize) return;
    this.term.options.fontSize = size;
    setDefaultFontSize(size); // pane-theme.js owns the value and its storage
    this.refit();
  }

  setFontWeight(weight) {
    if (weight === this.term.options.fontWeight) return;
    this.term.options.fontWeight = weight;
    this.term.options.fontWeightBold = boldFor(weight);
    this.refit(); // a heavier face can measure a hair wider
  }

  refit() {
    this.screenRect = null; // the terminal moved or resized — see cellAt
    if (!this.el.isConnected) return;
    this.writeSeq++;
    try {
      this.fit.fit();
      // ...and rebuild the glyph atlas while we are redrawing anyway: this is
      // what makes resizing the window cure a pane already showing the blank
      // glyphs described in attachWebgl, which is what anyone would try first
      this.redrawGlyphs();
      if (!this.exited) {
        this.handlers.onResize(this, this.term.cols, this.term.rows);
      }
    } catch { /* pane momentarily hidden */ }
  }

  write(data) {
    this.writeSeq++;
    this.term.write(data);
    this.noteActivity();
    // keep the mode dropdown (and model chip) honest once output settles —
    // one shared buffer read feeds all four scans
    clearTimeout(this.modeTimer);
    this.modeTimer = setTimeout(() => this.scanBuffer(), 500);
  }

  /* The settle-time buffer scan. One tail read feeds all of it (tailLines is
   * the expensive part), but only two of the five have to run for a pane the
   * user cannot see: auto-accept, because a dialog nobody clears leaves that
   * agent blocked in a workspace nobody is looking at, and the prompt options,
   * because the bell offers its ✓/✕ buttons from anywhere. The three header
   * chips paint a pane that is off screen, so they wait for it to come back —
   * setOnScreen runs the scan once on the way in. */
  scanBuffer() {
    const lines = this.tailLines(30);
    if (this.onScreen) {
      this.chipsStale = false;
      this.syncMode(lines);
      this.syncModelFromBuffer(lines);
      this.syncEffortFromBuffer(lines);
    } else {
      this.chipsStale = true;
    }
    this.autoAcceptDialogs(lines);
    this.refreshPromptOptions(lines);
  }

  /* app.js says which panes are in the grid on screen. Coming back with a
   * scan owed catches the chips up in one pass. */
  setOnScreen(on) {
    if (on === this.onScreen) return;
    this.onScreen = on;
    if (on && this.chipsStale) this.scanBuffer();
  }

  /* detached = the attach client died but the agent lives on in tmux
   * (WSL hiccup, manual detach) — the rail's Reattach all brings it back */
  markExited(exitCode, detached) {
    this.exited = true;
    this.detached = !!detached;
    this.exitCode = exitCode;
    this.attention = false;
    this.working = false;
    this.awaitingPrompt = false;
    this.promptAnswerable = false;
    this.syncPromptButtons();
    if (this.stopDictation) this.stopDictation(); // agent gone — mic must not stay hot
    clearTimeout(this.idleTimer);
    clearTimeout(this.modeTimer);
    this.modeSel.disabled = true;
    this.planAsked = false; // the agent it was asked of is gone
    this.setStatusText('');
    this.el.classList.add('exited');
    this.el.classList.toggle('detached', this.detached);
    this.badge.textContent = this.detached ? 'detached' : 'exited (' + exitCode + ')';
    this.badge.style.display = '';
    this.disarmClose();
    this.syncStatus();
  }

  /* the attach client is back on the same session id — un-exit the pane */
  markReattached() {
    this.exited = false;
    this.detached = false;
    this.exitCode = null;
    this.modeSel.disabled = false;
    this.el.classList.remove('exited', 'detached');
    this.badge.style.display = 'none';
    this.syncStatus();
    requestAnimationFrame(() => this.refit());
  }

  /* Plain-text scrollback, for the transcript a finishing task captures. Read
   * once per task, so it is deliberately not memoized: the search across all
   * agents that used to call it per keystroke is gone, and holding a second
   * copy of every pane's scrollback for a once-a-task read is pure memory. */
  getBufferText() {
    const buf = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : '');
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('\n');
  }

  /* The clipboard into the agent, for the two paste routes the browser does
   * not serve by itself (right-click, Shift+Insert). term.paste, not a raw
   * write: it brackets the text when the TUI asked for bracketed paste, which
   * is what makes a multi-line paste arrive as one block. */
  pasteClipboard() {
    if (this.exited) return;
    window.swarm.readText().then((text) => { if (text) this.term.paste(text); });
  }

  focus() {
    this.lastFocusAt = Date.now(); // the renderer budget spends its contexts on the panes worked in most recently
    document.querySelectorAll('.pane.focused').forEach((p) => p.classList.remove('focused'));
    this.el.classList.add('focused');
    this.clearAttention();
    this.term.focus();
    this.handlers.onFocus(this);
  }

  /* Give up this pane's GPU renderer while nobody is looking at it (app.js
   * arms this for panes in a workspace that has been off screen a while).
   * Chromium caps a page at ~16 live WebGL contexts, and every pane in every
   * workspace holds one — past that the oldest start getting killed under the
   * running app. xterm falls straight back to its DOM renderer, so the buffer,
   * the scrollback and the pty are all untouched; the only thing lost is the
   * GPU acceleration of a terminal that isn't on screen. */
  dropRenderer() {
    if (!this.webgl) return;
    try { this.webgl.dispose(); } catch { /* crashy addon */ }
    webglPanes.delete(this);
    this.webgl = null;
    this.rendererDropped = true;
  }

  /* ... and take it back when the pane is on screen again. */
  restoreRenderer() {
    if (!this.rendererDropped) return;
    this.rendererDropped = false;
    if (this.exited) return;
    this.attachWebgl();
  }

  dispose() {
    this.closeBranchMenu();
    if (this.stopDictation) this.stopDictation();
    clearTimeout(this.idleTimer);
    clearTimeout(this.modeTimer);
    livePanes.delete(this);
    Pane.syncUsagePanelTicker(); // the last panel closing stops the shared beat
    this.observer.disconnect();
    // the webgl addon's dispose can throw (upstream bug) — detach it first
    // and never let any teardown error keep the pane element on screen
    try { if (this.webgl) this.webgl.dispose(); } catch { /* crashy addon */ }
    webglPanes.delete(this); // the context this pane held is budget for another
    this.webgl = null;
    try { this.term.dispose(); } catch { /* must not block removal */ }
    this.el.remove();
  }
}

/* One ticker for every waiting chip rather than a timer per pane: the chips
 * only move once a minute, and a swarm of per-pane intervals is exactly the
 * per-beat cost CLAUDE.md's render-cost note warns about. Panes that are not
 * waiting write nothing (syncWaitChip guards on the text it would set). */
setInterval(() => {
  for (const pane of livePanes) pane.syncWaitChip();
}, 15000);

/* Spend the page's WebGL contexts on the panes the user is actually working
 * in. app.js calls this with the panes in the grid on screen, after every
 * change to it; the off-screen reclaim there is the other half — this one
 * only acts when the grid alone holds more panes than MAX_WEBGL_PANES.
 *
 * Rank is last-focused first, so the pane being typed in never loses its
 * renderer to one three rows down that has not been touched all session.
 * Losing it costs nothing but GPU acceleration: xterm falls straight back to
 * the DOM renderer, buffer and pty untouched. */
Pane.applyRendererBudget = (visible) => {
  const ranked = [...visible].sort((a, b) => b.lastFocusAt - a.lastFocusAt);
  const keep = ranked.slice(0, MAX_WEBGL_PANES);
  const keepSet = new Set(keep);
  // visible panes past the budget go first — they are the reason it is tight
  for (const pane of ranked.slice(MAX_WEBGL_PANES)) pane.dropRenderer();
  for (const pane of keep) {
    if (pane.webgl || !pane.rendererDropped) continue;
    if (webglPanes.size >= MAX_WEBGL_PANES) {
      // take one back off whichever holder outside the keep set was worked in
      // longest ago — an off-screen pane, or one this pass just demoted
      const victim = [...webglPanes].filter((p) => !keepSet.has(p))
        .sort((a, b) => a.lastFocusAt - b.lastFocusAt)[0];
      if (!victim) break; // every context is held by a pane that outranks this one
      victim.dropRenderer();
    }
    pane.restoreRenderer();
  }
};

/* app.js calls this on theme switch — and on a "Theme background overlay"
 * flip, after setting the attribute, since that changes --term-bg and hence
 * the backdrop paneTheme reads. New panes pick the result up via the
 * constructor; existing terminals are restyled by the caller. */
Pane.setXtermTheme = setXtermTheme;
/* the caller pushes this to already-open panes alongside the palette */
Pane.getMinContrast = getMinContrast;

/* app.js's Options-panel "Agent pane text size" control reads/writes the same
 * default new panes start at (and that MOD+/- / the pane buttons update);
 * the caller is responsible for pushing the result to already-open panes */
Pane.DEFAULT_FONT_SIZE = DEFAULT_FONT_SIZE;
Pane.getDefaultFontSize = getDefaultFontSize;
Pane.setDefaultFontSize = setDefaultFontSize;

/* the macOS "Native Apple style" option's terminal half — new panes read the
 * result here, already-open ones are restyled by the caller (a font swap needs
 * a refit, since the cell size changes with it) */
Pane.getMonoFont = getMonoFont;
Pane.setMonoFont = setMonoFont;

/* and the same for "Agent pane text weight" — no keyboard path, so the option
 * is the only writer; the caller pushes the result to already-open panes */
Pane.DEFAULT_FONT_WEIGHT = DEFAULT_FONT_WEIGHT;
Pane.getDefaultFontWeight = getDefaultFontWeight;
Pane.setDefaultFontWeight = setDefaultFontWeight;

/* app.js's Options-panel "Show last command in pane header" checkbox owns
 * persistence; this just flips the flag every pane's syncInitialCommandHeader
 * reads — the caller is responsible for re-syncing already-open panes */
Pane.setShowInitialCommand = setShowInitialCommand;

/* same pattern as setShowInitialCommand, for the → / ↓ split buttons */
Pane.setAutoOrganize = setAutoOrganize;

/* and again for "Default agent permissions: auto" — the only thing that reads
 * it here is autoAcceptDialogs, which must not stall on an IPC round trip in
 * the middle of a buffer scan */
Pane.setSkipPermissions = setSkipPermissions;

/* same pattern again, for the bottom cost & context panel — the caller
 * re-syncs already-open panes (which also refits their terminals) */
Pane.setShowUsagePanel = setShowUsagePanel;

/* app.js hands over each usage poll: the 5-hour window is what every pane's
 * "≈x% of 5h" share is measured against */
Pane.setUsageWindow = setUsageWindow;

// exposed so the task board can build its starting-mode picker from the
// same single source of truth as the per-pane mode dropdown
Pane.MODES = MODES;
Pane.MODELS = MODELS;
Pane.EFFORTS = EFFORTS;
Pane.fmtDuration = fmtDuration;

