/* ---- Pane: the cost & context panel and the model/effort chips ----
 *
 * Split out of the one 2416-line pane.js. The row of capsules behind the
 * 'Show cost & context panel' option, plus the header chips that name the
 * model and effort it is running on.
 */

import { elt } from '../../lib/dom.js';
import { OpenRouterUI } from '../openrouter/openrouter.js';
import { CONTEXT_WINDOW, CONTEXT_WINDOW_LARGE, FIVE_HOURS_MS, fmtCost, fmtDuration, fmtTokens, livePanes, prettyModelName, showUsagePanel, usageWindow } from './pane-const.js';
import { Pane } from './pane.js';

/* One ticker for every panel rather than one per pane, for the same reason as
 * the waiting-chip ticker in pane.js: the panel's own figures move once a
 * turn, and only the two clocks (time in this turn, the 5-hour share) need a
 * beat at all. Each pane's tick also summed every *other* pane's token series
 * to get the swarm total, so the per-second cost grew with the square of the
 * swarm — with the panel on and ten agents open that was a hundred series
 * walks a second to repaint numbers that had not changed. The total is now
 * summed once per beat and shared, and every write below is compared before
 * it lands. */
let panelTimer = null;
let swarmTotal = { at: 0, tokens: 0 };

function swarmWindowTokens() {
  const now = Date.now();
  // the panes render within a beat of each other, so one sum serves them all
  if (now - swarmTotal.at < 900) return swarmTotal.tokens;
  let tokens = 0;
  for (const pane of livePanes) tokens += pane.windowTokens();
  swarmTotal = { at: now, tokens };
  return tokens;
}

/* Runs while any panel is on screen, and is stopped the moment the option goes
 * off or the last pane closes — a 1s wake-up for nothing is exactly what the
 * per-beat cost note in CLAUDE.md warns about. */
function syncPanelTicker() {
  const wanted = showUsagePanel && livePanes.size > 0;
  if (wanted && !panelTimer) {
    panelTimer = setInterval(() => {
      swarmWindowTokens(); // one sum, before the panes read it
      for (const pane of livePanes) pane.renderUsagePanel();
    }, 1000);
  } else if (!wanted && panelTimer) {
    clearInterval(panelTimer);
    panelTimer = null;
  }
}
Pane.syncUsagePanelTicker = syncPanelTicker;

// the panel repaints on every beat, and an assignment costs a style recalc
// whether or not the value actually changed — so nothing is written twice
const setText = (el, text) => { const v = text == null ? '' : String(text); if (el.textContent !== v) el.textContent = v; };
const setTip = (el, tip) => { if (el.dataset.tip !== tip) el.dataset.tip = tip; };
const setShown = (el, on) => { const v = on ? '' : 'none'; if (el.style.display !== v) el.style.display = v; };

Object.assign(Pane.prototype, {
  /* Show or hide the panel, and keep the terminal's row count honest — the
   * panel's rows are rows the terminal no longer has. */
  syncUsagePanel() {
    const was = this.usageEl.style.display !== 'none';
    this.usageEl.style.display = showUsagePanel ? '' : 'none';
    // the turn timer and the 5h share both move on their own — on the one
    // shared beat above, not a timer of this pane's own
    syncPanelTicker();
    if (showUsagePanel) this.renderUsagePanel();
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
      setText(this.usageCtxEl, 'waiting for the first turn…');
      if (this.usageBarFillEl.style.width !== '0%') this.usageBarFillEl.style.width = '0%';
      this.usageEl.classList.remove('warn', 'hot');
      setText(this.usageCostEl, '');
      setText(this.usageCacheEl, '');
      // an empty pill is a stray blob: the spend capsule goes with its figures
      setShown(this.usageCostCapEl, false);
      setText(this.usageTurnsEl, '');
      setShown(this.usageShareEl, false);
      this.renderToolTrail();
      return;
    }

    // an OpenRouter model's window is a fact the catalog already carries (it
    // is what the launch env caps the agent at), so the meter uses it rather
    // than the Claude 200k/1M guess. Looked up until it lands: config:get can
    // arrive after a restored pane was built.
    if (!this.orCtx && this.orSlug) {
      const known = OpenRouterUI.models.find((m) => m.id === this.orSlug);
      if (known && known.ctx > 0) this.orCtx = known.ctx;
    }
    const limit = this.orCtx || (u.context > CONTEXT_WINDOW ? CONTEXT_WINDOW_LARGE : CONTEXT_WINDOW);
    const filled = Math.min(100, Math.round((u.context / limit) * 100));
    const width = filled + '%';
    if (this.usageBarFillEl.style.width !== width) this.usageBarFillEl.style.width = width;
    this.usageEl.classList.toggle('warn', filled >= 70 && filled < 90);
    this.usageEl.classList.toggle('hot', filled >= 90);
    setTip(this.usageBarEl, `Context in use: ${u.context.toLocaleString()} of ${fmtTokens(limit)} tokens — `
      + (this.viaClean ? 'no auto-compaction here: /clear starts the conversation over' : 'Claude Code compacts the conversation as this fills'));
    setText(this.usageCtxEl, `${fmtTokens(u.context)} / ${fmtTokens(limit)}`);

    setShown(this.usageCostCapEl, true);
    setText(this.usageCostEl, (u.partial ? '≈' : '') + fmtCost(u.cost));
    setTip(this.usageCostEl, 'Estimated spend for this agent at list prices — in '
      + fmtTokens(u.input) + ' · out ' + fmtTokens(u.output)
      + ' · cache read ' + fmtTokens(u.cacheRead) + ' · cache write ' + fmtTokens(u.cacheWrite)
      + (u.partial ? ' (session was already long when SwarmEye started counting, so this is a floor)' : ''));

    const cached = u.cacheRead + u.cacheWrite + u.input;
    const hit = cached ? Math.round((u.cacheRead / cached) * 100) : 0;
    setText(this.usageCacheEl, hit + '% cached');
    setTip(this.usageCacheEl, 'Share of input served from the prompt cache at a tenth of the price — higher is cheaper');
    // the transcript's model is the same one ModelUpdate carries, but it can
    // arrive first on a reattach — take it when the chip is still blank
    if (!this.modelLabel && u.model) this.setModel(prettyModelName(u.model));

    setText(this.usageTurnsEl, u.turns + (u.turns === 1 ? ' turn' : ' turns'));

    const now = Date.now();
    if (this.turnStartedAt) setText(this.usageTimeEl, 'working ' + fmtDuration(now - this.turnStartedAt));
    else if (this.waitingSince) setText(this.usageTimeEl, 'waiting ' + fmtDuration(now - this.waitingSince));
    else setText(this.usageTimeEl, 'idle');

    // this agent's slice of the 5-hour quota: its share of everything the
    // swarm burned this window, applied to the window's own percentage. The
    // API reports a percentage rather than tokens, so this is an estimate —
    // hence the ≈.
    const mine = this.windowTokens();
    const swarm = swarmWindowTokens();
    const used = usageWindow && typeof usageWindow.usedPct === 'number' ? usageWindow.usedPct : null;
    if (used != null && swarm > 0 && !this.orSlug) {
      const share = (mine / swarm) * used;
      setText(this.usageShareEl, '≈' + (share < 1 ? share.toFixed(1) : Math.round(share)) + '% of 5h');
      setTip(this.usageShareEl, `This agent burned ${fmtTokens(mine)} of the swarm's ${fmtTokens(swarm)} tokens this session window, which is ${used}% used overall`);
      setShown(this.usageShareEl, true);
    } else {
      setShown(this.usageShareEl, false);
    }

    this.renderToolTrail();
  },

  /* The tool trail as its own capsule: the tools in order, an arrow between
     each pair, the newest one carrying the weight — it is the one the agent is
     running right now. Empty until the first tool call, and the pill goes with
     it rather than sit there blank. */
  renderToolTrail() {
    const el = this.usageToolsEl;
    // rebuilt only when the trail itself moved: the panel's beat would
    // otherwise re-create these spans every second for an unchanged row
    const sig = this.toolTrail.join('\u0001');
    if (sig === this.toolTrailSig) return;
    this.toolTrailSig = sig;
    el.textContent = '';
    setShown(el, this.toolTrail.length > 0);
    this.toolTrail.forEach((name, i) => {
      if (i) el.append(elt('span', 'pane-usage-arrow', '→'));
      el.append(elt('span', i === this.toolTrail.length - 1 ? 'pane-usage-tool now' : 'pane-usage-tool', name));
    });
    setTip(el, 'Most recent tools this agent ran');
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
    setText(this.llmEl, this.modelLabel);
    setTip(this.llmEl, tip);
    setShown(this.llmEl, !!this.modelLabel && !inPanel);
    setText(this.usageModelEl, this.modelLabel);
    setTip(this.usageModelEl, tip);
    setShown(this.usageModelEl, !!this.modelLabel);
    setText(this.effortEl, this.effortLabel);
    setTip(this.effortEl, this.effortTip);
    setShown(this.effortEl, !!this.effortLabel && !inPanel);
    setText(this.usageEffortEl, this.effortLabel);
    setTip(this.usageEffortEl, this.effortTip);
    setShown(this.usageEffortEl, !!this.effortLabel);
  }
});
