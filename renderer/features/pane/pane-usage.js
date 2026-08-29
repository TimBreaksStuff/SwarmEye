/* ---- Pane: the cost & context panel and the model/effort chips ----
 *
 * Split out of the one 2416-line pane.js. The row of capsules behind the
 * 'Show cost & context panel' option, plus the header chips that name the
 * model and effort it is running on.
 */

Object.assign(Pane.prototype, {
  /* Show or hide the panel, and keep the terminal's row count honest — the
   * panel's rows are rows the terminal no longer has. */
  syncUsagePanel() {
    const was = this.usageEl.style.display !== 'none';
    this.usageEl.style.display = showUsagePanel ? '' : 'none';
    clearInterval(this.usageTimer);
    this.usageTimer = null;
    if (showUsagePanel) {
      this.renderUsagePanel();
      // the turn timer and the 5h share both move on their own
      this.usageTimer = setInterval(() => this.renderUsagePanel(), 1000);
    }
    this.placeBusy();
    this.syncModelChip(); // the panel takes the model over from the header

    if (showUsagePanel !== was && this.fit) this.refit();
  },

  /* The busy equalizer belongs to the panel's left edge, ahead of every
   * reading. With the panel off there is no left edge to sit on, so it goes
   * back to its old header slot rather than disappearing with the row. */
  placeBusy() {
    const home = showUsagePanel ? this.usageRowEl : this.statusEl.parentNode;
    if (this.busyEl.parentNode === home && (!showUsagePanel || home.firstChild === this.busyEl)) return;
    if (showUsagePanel) home.prepend(this.busyEl);
    else home.insertBefore(this.busyEl, this.statusEl);
  },

  /* Tokens this agent burned inside the current 5-hour usage window. Also the
   * numerator and (summed across panes) the denominator of its quota share. */
  windowTokens() {
    // an OpenRouter agent spends none of the Anthropic window, so it is
    // neither a share of it nor part of what the swarm burned against it
    if (this.orSlug || !this.usage || !this.usage.series) return 0;
    const start = (usageWindow && usageWindow.resetsAt ? usageWindow.resetsAt : Date.now() + FIVE_HOURS_MS) - FIVE_HOURS_MS;
    let total = 0;
    for (const point of this.usage.series) if (point.t >= start) total += point.tokens;
    return total;
  },

  renderUsagePanel() {
    // display is the option flag, not visibility: a pane in a workspace nobody
    // is looking at is detached from the DOM, and its 1s tick would still sum
    // windowTokens() over every live pane for a panel that isn't on screen
    if (!this.el.isConnected || this.usageEl.style.display === 'none') return;
    const u = this.usage;
    if (!u) {
      // no turn counted yet — either a brand-new agent or one just /clear'ed,
      // in which case last conversation's figures must not linger
      this.usageCtxEl.textContent = 'waiting for the first turn…';
      this.usageBarFillEl.style.width = '0%';
      this.usageEl.classList.remove('warn', 'hot');
      this.usageCostEl.textContent = '';
      this.usageCacheEl.textContent = '';
      // an empty pill is a stray blob: the spend capsule goes with its figures
      this.usageCostCapEl.style.display = 'none';
      this.usageTurnsEl.textContent = '';
      this.usageShareEl.style.display = 'none';
      this.renderToolTrail();
      return;
    }

    // an OpenRouter model's window is a fact the catalog already carries (it
    // is what the launch env caps the agent at), so the meter uses it rather
    // than the Claude 200k/1M guess. Looked up until it lands: config:get can
    // arrive after a restored pane was built.
    if (!this.orCtx && this.orSlug && window.OpenRouterUI) {
      const known = OpenRouterUI.models.find((m) => m.id === this.orSlug);
      if (known && known.ctx > 0) this.orCtx = known.ctx;
    }
    const limit = this.orCtx || (u.context > CONTEXT_WINDOW ? CONTEXT_WINDOW_LARGE : CONTEXT_WINDOW);
    const filled = Math.min(100, Math.round((u.context / limit) * 100));
    this.usageBarFillEl.style.width = filled + '%';
    this.usageEl.classList.toggle('warn', filled >= 70 && filled < 90);
    this.usageEl.classList.toggle('hot', filled >= 90);
    this.usageBarEl.dataset.tip = `Context in use: ${u.context.toLocaleString()} of ${fmtTokens(limit)} tokens — `
      + (this.viaClean ? 'no auto-compaction here: /clear starts the conversation over' : 'Claude Code compacts the conversation as this fills');
    this.usageCtxEl.textContent = `${fmtTokens(u.context)} / ${fmtTokens(limit)}`;

    this.usageCostCapEl.style.display = '';
    this.usageCostEl.textContent = (u.partial ? '≈' : '') + fmtCost(u.cost);
    this.usageCostEl.dataset.tip = 'Estimated spend for this agent at list prices — in '
      + fmtTokens(u.input) + ' · out ' + fmtTokens(u.output)
      + ' · cache read ' + fmtTokens(u.cacheRead) + ' · cache write ' + fmtTokens(u.cacheWrite)
      + (u.partial ? ' (session was already long when SwarmEye started counting, so this is a floor)' : '');

    const cached = u.cacheRead + u.cacheWrite + u.input;
    const hit = cached ? Math.round((u.cacheRead / cached) * 100) : 0;
    this.usageCacheEl.textContent = hit + '% cached';
    this.usageCacheEl.dataset.tip = 'Share of input served from the prompt cache at a tenth of the price — higher is cheaper';
    // the transcript's model is the same one ModelUpdate carries, but it can
    // arrive first on a reattach — take it when the chip is still blank
    if (!this.modelLabel && u.model) this.setModel(prettyModelName(u.model));

    this.usageTurnsEl.textContent = u.turns + (u.turns === 1 ? ' turn' : ' turns');

    const now = Date.now();
    if (this.turnStartedAt) this.usageTimeEl.textContent = 'working ' + fmtDuration(now - this.turnStartedAt);
    else if (this.waitingSince) this.usageTimeEl.textContent = 'waiting ' + fmtDuration(now - this.waitingSince);
    else this.usageTimeEl.textContent = 'idle';

    // this agent's slice of the 5-hour quota: its share of everything the
    // swarm burned this window, applied to the window's own percentage. The
    // API reports a percentage rather than tokens, so this is an estimate —
    // hence the ≈.
    const mine = this.windowTokens();
    let swarm = 0;
    for (const pane of livePanes) swarm += pane.windowTokens();
    const used = usageWindow && typeof usageWindow.usedPct === 'number' ? usageWindow.usedPct : null;
    if (used != null && swarm > 0 && !this.orSlug) {
      const share = (mine / swarm) * used;
      this.usageShareEl.textContent = '≈' + (share < 1 ? share.toFixed(1) : Math.round(share)) + '% of 5h';
      this.usageShareEl.dataset.tip = `This agent burned ${fmtTokens(mine)} of the swarm's ${fmtTokens(swarm)} tokens this session window, which is ${used}% used overall`;
      this.usageShareEl.style.display = '';
    } else {
      this.usageShareEl.style.display = 'none';
    }

    this.renderToolTrail();
  },

  /* The tool trail as its own capsule: the tools in order, an arrow between
     each pair, the newest one carrying the weight — it is the one the agent is
     running right now. Empty until the first tool call, and the pill goes with
     it rather than sit there blank. */
  renderToolTrail() {
    const el = this.usageToolsEl;
    el.textContent = '';
    el.style.display = this.toolTrail.length ? '' : 'none';
    this.toolTrail.forEach((name, i) => {
      if (i) el.append(elt('span', 'pane-usage-arrow', '→'));
      el.append(elt('span', i === this.toolTrail.length - 1 ? 'pane-usage-tool now' : 'pane-usage-tool', name));
    });
    el.dataset.tip = 'Most recent tools this agent ran';
  },

  /* ---- model chip ---- */

  setModel(label) {
    if (!label) return;
    this.modelLabel = label;
    this.syncModelChip();
    // the tier usually lands after the first tool calls, so the streak can
    // already be long by the time we learn it is Opus
    this.syncRightsize();
  },

  setEffort(label) {
    if (!label) return;
    this.effortLabel = label;
    this.syncModelChip();
  },

  /* One model, one place: the cost & context panel owns it whenever that
   * panel is on, and the header chip only fills in when it is off. The
   * effort label rides along in both spots, left of the model. */
  syncModelChip() {
    const inPanel = this.usageEl.style.display !== 'none';
    const tip = this.modelTip + ' — click to switch, keeping the conversation';
    this.llmEl.textContent = this.modelLabel;
    this.llmEl.dataset.tip = tip;
    this.llmEl.style.display = this.modelLabel && !inPanel ? '' : 'none';
    this.usageModelEl.textContent = this.modelLabel;
    this.usageModelEl.dataset.tip = tip;
    this.usageModelEl.style.display = this.modelLabel ? '' : 'none';
    this.effortEl.textContent = this.effortLabel;
    this.effortEl.dataset.tip = this.effortTip;
    this.effortEl.style.display = this.effortLabel && !inPanel ? '' : 'none';
    this.usageEffortEl.textContent = this.effortLabel;
    this.usageEffortEl.dataset.tip = this.effortTip;
    this.usageEffortEl.style.display = this.effortLabel ? '' : 'none';
  }
});
