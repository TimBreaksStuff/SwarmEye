/* ---- Pane: the git context chip, branch menu and model picker ----
 *
 * Split out of the one 2416-line pane.js. The branch/dirty chip in the pane header, the diff --stat popover behind
 * it, the branch switcher, and the restart-on-another-model menu.
 */

Object.assign(Pane.prototype, {
  /* ---- git context chip ---- */

  setGit(info) {
    this.gitInfo = info || null;
    if (!info || !info.branch) {
      this.gitEl.style.display = 'none';
      this.gitEl.textContent = '';
      return;
    }
    this.gitEl.style.display = '';
    // an icon rather than '⎇': the system font on a Mac has no glyph for it and
    // draws a box, and the chip is the header's most-read chip
    this.gitEl.innerHTML = Icons.markup('branch');
    this.gitEl.append(elt('span', 'pane-git-name', info.branch));
    this.gitEl.classList.toggle('dirty', !!info.dirty);
    // dirty is null when the status check timed out — saying "clean" there is a lie
    this.gitEl.dataset.tip = (info.dirty === null
      ? `branch ${info.branch} — could not read status`
      : info.dirty
        ? `branch ${info.branch} — uncommitted changes`
        : `branch ${info.branch} — clean`) + ' · click for the diff and to switch branch';
  },

  /* Fill the popover's top section with what the workspace has changed since
   * HEAD. Long stats are elided in the middle — the summary line (git's own
   * "N files changed…") is the one that must survive, so it's kept explicitly
   * rather than trusting a plain head(). */
  renderDiffSummary(el, d) {
    el.textContent = '';
    if (!d) { el.textContent = 'could not read changes'; return; }
    const lines = d.stat ? d.stat.split('\n') : [];
    if (!lines.length && !d.untracked) { el.textContent = 'no changes since HEAD'; return; }
    const shown = lines.length > DIFF_STAT_MAX_LINES
      ? [...lines.slice(0, DIFF_STAT_MAX_LINES - 2), '…', lines[lines.length - 1]]
      : lines;
    for (const line of shown) {
      const row = elt('div', 'branch-diff-line', line);
      el.appendChild(row);
    }
    if (d.untracked) {
      const row = elt('div', 'branch-diff-line branch-diff-untracked', `${d.untracked} untracked file${d.untracked === 1 ? '' : 's'}`);
      el.appendChild(row);
    }
  },

  /* Click on the git chip: a summary of the working tree's changes on top,
   * then the repo's branches (local + remote, see main/git.js listBranches).
   * Picking one runs `git checkout` in the workspace; the chip updates via
   * the git:update push that follows.
   *
   * The two reads run concurrently rather than in sequence: listing branches
   * does a network fetch first and is much the slower of the two, so awaiting
   * it before asking for the diff would leave the popover blank the whole time. */
  async openBranchMenu() {
    if (this.branchMenuEl) { this.closeBranchMenu(); return; }
    const menu = document.createElement('div');
    menu.className = 'branch-menu';
    const diffEl = elt('div', 'branch-diff', 'checking changes…');
    const listEl = elt('div', 'branch-list', 'fetching branches…');
    menu.append(diffEl, listEl);
    // fixed-position (the pane clips overflow), anchored under the chip — and
    // flipped above it for a pane low in the grid, since this popover is tall
    // (the diff summary plus the branch list). See dom.js placePop.
    document.body.appendChild(menu);
    placePop(menu, this.gitEl, { flip: true });
    this.branchMenuEl = menu;
    this._branchDismiss = dismissPop(menu, () => this.closeBranchMenu(), { keep: [this.gitEl] });

    window.swarm.gitDiff(this.session.workspaceId).then((d) => {
      if (this.branchMenuEl !== menu) return; // dismissed while the read ran
      this.renderDiffSummary(diffEl, d);
    });

    const branches = await window.swarm.listBranches(this.session.workspaceId);
    if (this.branchMenuEl !== menu) return; // dismissed while the fetch ran
    if (!branches || !branches.length) {
      listEl.textContent = 'no branches found';
      return;
    }
    const current = this.gitInfo && this.gitInfo.branch;
    listEl.textContent = '';
    for (const b of branches) {
      const row = elt('button', 'branch-item' + (b === current ? ' current' : ''), b);
      if (b !== current) row.addEventListener('click', () => this.pickBranch(b));
      listEl.appendChild(row);
    }

    // "+ new branch…" swaps itself for an input; Enter runs checkout -b
    const divider = document.createElement('div');
    divider.className = 'branch-menu-divider';
    listEl.appendChild(divider);
    const add = elt('button', 'branch-item new', '+ new branch…');
    add.addEventListener('click', () => {
      const input = document.createElement('input');
      input.className = 'branch-new-input';
      input.placeholder = 'new branch name';
      input.spellcheck = false;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing must not trigger app shortcuts
        if (e.key === 'Enter') {
          const name = input.value.trim();
          if (name) this.pickBranch(name, { create: true });
        } else if (e.key === 'Escape') {
          this.closeBranchMenu();
        }
      });
      add.replaceWith(input);
      input.focus();
    });
    listEl.appendChild(add);
  },

  closeBranchMenu() {
    if (!this.branchMenuEl) return;
    this.branchMenuEl.remove();
    this.branchMenuEl = null;
    this._branchDismiss();
    this._branchDismiss = null;
  },

  async pickBranch(branch, { create = false } = {}) {
    this.closeBranchMenu();
    const res = await window.swarm.checkoutBranch(this.session.workspaceId, branch, create);
    if (res && res.ok) toast(create ? `created ${branch}` : `switched to ${branch}`);
    else toast(res && res.error ? res.error : 'checkout failed');
  },

  /* ---- model picker ---- */

  /* Switch this agent's model from the chip: the Claude tiers plus the whole
   * OpenRouter catalog, in the filterable menu the + Agent button already
   * uses. The pick is a restart with --continue — not a typed `/model` — for
   * the reason claudeBase passes the model as a launch flag (sessions.js):
   * `/model` saves the choice as the user's default for *new* sessions, so an
   * OpenRouter slug picked inside a running agent leaks into every Claude
   * agent started afterwards, which then fails with "It may not exist or you
   * may not have access to it". A restart changes nothing outside this pane,
   * and it is also the only way to reach the rest of the catalog: against a
   * foreign base URL `/model` can only list the four tier aliases the launch
   * env carries (main/providers.js). */
  openModelPicker() {
    if (this.detached) return; // a restart would reattach, ignoring the pick
    if (!window.OpenRouterUI || !OpenRouterUI.models.length) {
      toast('add an OpenRouter key in ⌨ Options to switch models');
      return;
    }
    // whichever of the two spellings of the chip is the visible one
    const anchor = this.llmEl.style.display === 'none' ? this.usageModelEl : this.llmEl;
    OpenRouterUI.openModelMenu(anchor, (model) => {
      // a bare harness's conversation lives in a store only that same harness
      // can read — resuming a Claude relaunch would `--continue` whatever
      // unrelated claude conversation this folder saw last, and switching
      // between clean/opencode/pi is just as much a different conversation
      const was = OpenRouterUI.harnessOf(this.session.model);
      const resume = !(OpenRouterUI.isBare(this.session.model) && OpenRouterUI.harnessOf(model) !== was);
      this.handlers.onRestart(this, { resume, model });
      // the Claude tiers only: OpenRouterUI.install appends the whole catalog
      // to MODELS, and the menu lists that itself
    }, { extra: MODELS.filter(([v]) => v !== 'default' && !/^o[rc]:/.test(v)) });
  },

  /* ---- scope picker ---- */

  /* Switch which folder this agent may edit inside, from its scope chip: the
   * same areas+folders menu + Agent offers (renderer/features/scope/scope.js), with "whole
   * workspace" lifting the boundary. Like the model pick it is a restart with
   * --continue — the deny rules live in the per-session settings file claude
   * read at startup, so a running agent cannot be re-fenced in place. */
  openScopePicker() {
    if (this.detached) return; // a restart would reattach, ignoring the pick
    const cur = this.session.scope && this.session.scope.paths;
    Scope.open(this.scopeEl, this.session.workspaceId, (scope) => {
      // the boundary it already has — nothing to restart for
      if (!scope && !cur) return;
      if (scope && cur && scope.paths.join('\n') === cur.join('\n')) return;
      this.handlers.onRestart(this, { resume: true, scope: scope || null });
    });
  }
});
