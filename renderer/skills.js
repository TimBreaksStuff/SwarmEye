/* Skills screen: install Claude Code skills from a GitHub repo URL, toggle
 * whether they're symlinked into every agent (~/.claude/skills/) or left for
 * manual per-project use, optionally mark one "active" so it's auto-invoked
 * at the start of every new agent instead of waiting on the model's own
 * judgment (see getActiveSkills/app.js), and surface background update checks.
 * Also lists skills found on disk that SwarmEye never installed — the ones an
 * agent writes itself — each under a header for the folder it was found in.
 * Fully self-contained — owns its own list and talks to window.swarm
 * directly, unlike the task board there's no other screen that needs to know
 * about skill state. Exposes the global `Skills` (read directly by app.js,
 * not via window — see Board.js for the same pattern). */

const Skills = (() => {
  const listEl = document.getElementById('skills-list');
  const emptyEl = document.getElementById('skills-empty');
  const addBtn = document.getElementById('skills-add-btn');
  const formEl = document.getElementById('skills-form');
  const urlEl = document.getElementById('skills-form-url');
  const cancelBtn = document.getElementById('skills-form-cancel');
  const submitBtn = document.getElementById('skills-form-submit');
  const statsTotalEl = document.getElementById('skills-stats-total');
  const statsEnabledEl = document.getElementById('skills-stats-enabled');
  const statsActiveEl = document.getElementById('skills-stats-active');
  const statsUpdatesEl = document.getElementById('skills-stats-updates');

  let skills = [];

  /* repoIds currently collapsed by the user — toggled without a full
   * render() so the click is a single class flip, not a rebuild */
  const collapsedRepos = new Set();

  const { armOrFire } = Confirm; // click-twice-to-confirm remove buttons

  function makeRow(skill) {
    const row = document.createElement('div');
    // left-edge state colour: active glows accent, loaded is grey, off is dimmed
    row.className = 'skill-row ' + (skill.active ? 'skill-row-state-active'
      : (skill.enabled || skill.local) ? 'skill-row-state-on' : 'skill-row-state-off');

    /* A local skill is live purely by sitting where it does, so there's no
     * enable checkbox to offer — just its name. */
    let toggle;
    if (skill.local) {
      toggle = document.createElement('div');
      toggle.className = 'skill-row-toggle skill-row-toggle-local';
      toggle.dataset.tip = 'Found on disk at ' + skill.dir + ' — already loaded for ' +
        (skill.workspaceId ? 'agents in this workspace' : 'every agent') + ', nothing to enable.';
      const name = document.createElement('span');
      name.className = 'skill-row-name';
      name.textContent = skill.name;
      toggle.appendChild(name);
    } else {
      toggle = document.createElement('label');
      toggle.className = 'skill-row-toggle';
      toggle.dataset.tip = 'Load this skill for every agent (symlinks it into ~/.claude/skills/). ' +
        'Only new agents pick it up — already-running agents need a restart.';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!skill.enabled;
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true;
        const res = await window.swarm.setSkillEnabled(skill.id, checkbox.checked);
        if (!res || !res.ok) toast('could not update: ' + (res && res.reason));
        await refresh();
      });
      const name = document.createElement('span');
      name.className = 'skill-row-name';
      name.textContent = skill.name;
      toggle.appendChild(checkbox);
      toggle.appendChild(name);
    }

    const activeToggle = document.createElement('label');
    activeToggle.className = 'skill-row-active';
    activeToggle.dataset.tip = skill.local
      ? `Auto-invoke this skill ("/${skill.invokeName}") right when a new agent starts` +
        (skill.workspaceId ? ' in this workspace' : '') + ', instead of waiting on the model to notice it\'s relevant.'
      : `Auto-invoke this skill ("/${skill.id}") right when every new agent starts, instead of ` +
        'waiting on the model to notice it\'s relevant. Turning this on also enables the skill.';
    const activeCheckbox = document.createElement('input');
    activeCheckbox.type = 'checkbox';
    activeCheckbox.checked = !!skill.active;
    activeCheckbox.addEventListener('change', async () => {
      activeCheckbox.disabled = true;
      const res = await window.swarm.setSkillActive(skill.id, activeCheckbox.checked);
      if (!res || !res.ok) toast('could not update: ' + (res && res.reason));
      await refresh();
    });
    const activeLabel = document.createElement('span');
    activeLabel.textContent = 'Active in new sessions';
    activeToggle.appendChild(activeCheckbox);
    activeToggle.appendChild(activeLabel);

    const header = document.createElement('div');
    header.className = 'skill-row-header';
    header.appendChild(toggle);
    header.appendChild(activeToggle);
    row.appendChild(header);

    if (skill.description) {
      const desc = document.createElement('div');
      desc.className = 'skill-row-desc';
      desc.textContent = skill.description;
      row.appendChild(desc);
    }

    /* bottom line: provenance on the left, buttons on the right — the repo
     * URL lives in the group header now, so the row only shows branch@commit */
    const foot = document.createElement('div');
    foot.className = 'skill-row-foot';

    const meta = document.createElement('div');
    meta.className = 'skill-row-meta';
    meta.textContent = skill.local
      ? skill.dir
      : skill.branch + (skill.commit ? '@' + skill.commit : '');
    if (!skill.local) meta.dataset.tip = skill.repoUrl;
    foot.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'skill-row-actions';

    if (skill.updateAvailable && !skill.local) {
      const updateBtn = document.createElement('button');
      updateBtn.className = 'skill-update-btn';
      updateBtn.textContent = '⟳ update';
      updateBtn.dataset.tip = 'Pull the latest commit for this skill';
      updateBtn.addEventListener('click', async () => {
        updateBtn.disabled = true;
        const res = await window.swarm.updateSkill(skill.id);
        if (!res || !res.ok) toast('update failed: ' + (res && res.reason));
        await refresh();
      });
      actions.appendChild(updateBtn);
    }

    if (!skill.enabled && !skill.local) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'skill-copy-btn';
      copyBtn.textContent = '📋';
      copyBtn.dataset.tip = 'Copy a command to load this skill in one project\'s terminal';
      copyBtn.addEventListener('click', async () => {
        const cmd = await window.swarm.skillTerminalCommand(skill.id);
        window.swarm.copyText(cmd);
        toast('command copied — paste it into an agent\'s terminal');
      });
      actions.appendChild(copyBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'skill-remove-btn';
    removeBtn.textContent = '🗑';
    removeBtn.dataset.tip = skill.local
      ? 'Delete this skill\'s folder from disk (click twice) — there\'s no clone to restore it from'
      : 'Remove this skill (click twice)';
    removeBtn.addEventListener('click', () => {
      armOrFire(removeBtn, 'del:' + skill.id, async () => {
        const res = await window.swarm.removeSkill(skill.id);
        if (!res || !res.ok) toast('could not remove: ' + (res && res.reason));
        await refresh();
      });
    });
    actions.appendChild(removeBtn);

    foot.appendChild(actions);
    row.appendChild(foot);
    return row;
  }

  /* Groups the flat skill list by repoId, preserving first-seen order —
   * every skill from the same install shares repoId (see main/skills.js).
   * Filesystem-discovered skills reuse the same mechanism, with their source
   * directory standing in for a repo, so each lands under its own header
   * instead of being mixed into an installed repo's list. */
  function groupByRepo(list) {
    const groups = [];
    const byId = new Map();
    for (const skill of list) {
      let group = byId.get(skill.repoId);
      if (!group) {
        group = {
          repoId: skill.repoId,
          repoUrl: skill.repoUrl,
          local: !!skill.local,
          label: skill.local ? skill.sourceLabel : skill.repoUrl,
          skills: [],
        };
        byId.set(skill.repoId, group);
        groups.push(group);
      }
      group.skills.push(skill);
    }
    return groups;
  }

  function makeRepoGroup(group, hueIndex) {
    const wrap = document.createElement('div');
    wrap.className = 'skill-repo-group';
    // repos cycle through the tint hues; disk-found sources stay grey
    if (group.local) wrap.classList.add('skill-repo-group-local');
    else if (hueIndex % 3) wrap.classList.add('skill-repo-hue-' + (hueIndex % 3));

    const header = document.createElement('div');
    header.className = 'skill-repo-header';

    const chevron = document.createElement('span');
    chevron.className = 'skill-repo-chevron';
    chevron.textContent = '▾';
    header.appendChild(chevron);

    if (group.local) {
      /* No repo to link to and no "Delete all" — deleting a whole source
       * directory is not something to put one click away. */
      const label = document.createElement('span');
      label.className = 'skill-repo-label skill-repo-label-local';
      label.textContent = group.label;
      header.appendChild(label);

      const badge = document.createElement('span');
      badge.className = 'skill-repo-badge';
      badge.textContent = 'on disk';
      badge.dataset.tip = 'Skills found in this folder rather than installed from a repo — ' +
        'anything an agent creates here shows up after reopening this screen';
      header.appendChild(badge);
    } else {
      const label = document.createElement('a');
      label.className = 'skill-repo-label';
      label.href = group.repoUrl;
      label.textContent = group.repoUrl.replace(/^https:\/\/github\.com\//, '');
      label.dataset.tip = 'Open ' + group.repoUrl;
      label.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.swarm.openExternal(group.repoUrl);
      });
      header.appendChild(label);
    }

    const count = document.createElement('span');
    count.className = 'skill-repo-count';
    count.textContent = String(group.skills.length);
    count.dataset.tip = group.skills.length + (group.skills.length === 1 ? ' skill' : ' skills');
    header.appendChild(count);

    if (!group.local) {
      const removeAllBtn = document.createElement('button');
      removeAllBtn.className = 'skill-repo-remove-btn';
      removeAllBtn.textContent = '🗑 all';
      removeAllBtn.dataset.tip = 'Remove every skill from this repo (click twice)';
      removeAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        armOrFire(removeAllBtn, 'delrepo:' + group.repoId, async () => {
          const res = await window.swarm.removeSkillRepo(group.repoId);
          if (!res || !res.ok) toast('could not remove: ' + (res && res.reason));
          await refresh();
        });
      });
      header.appendChild(removeAllBtn);
    }

    if (collapsedRepos.has(group.repoId)) wrap.classList.add('skill-repo-group-collapsed');
    header.dataset.tip = 'Click to collapse/expand this repo\'s skills';
    header.addEventListener('click', () => {
      const isCollapsed = wrap.classList.toggle('skill-repo-group-collapsed');
      if (isCollapsed) collapsedRepos.add(group.repoId);
      else collapsedRepos.delete(group.repoId);
    });

    wrap.appendChild(header);

    const rows = document.createElement('div');
    rows.className = 'skill-repo-rows';
    for (const skill of group.skills) rows.appendChild(makeRow(skill));
    wrap.appendChild(rows);

    return wrap;
  }

  function render() {
    listEl.innerHTML = '';
    emptyEl.hidden = skills.length > 0;
    let hue = 0;
    for (const group of groupByRepo(skills)) {
      listEl.appendChild(makeRepoGroup(group, group.local ? 0 : hue++));
    }
    statsTotalEl.textContent = skills.length;
    // counts the symlink this screen controls, so local skills — which are
    // loaded by living where they do, not by anything toggled here — are out
    statsEnabledEl.textContent = skills.filter((s) => s.enabled && !s.local).length;
    statsActiveEl.textContent = skills.filter((s) => s.active).length;
    const updates = skills.filter((s) => s.updateAvailable).length;
    statsUpdatesEl.textContent = updates;
    statsUpdatesEl.closest('.skills-stat-card').classList.toggle('has-updates', updates > 0);
  }

  /* Every skill currently marked active — read by app.js right after a new
   * agent session starts, to auto-invoke each one. Returns objects rather
   * than bare ids because a workspace-local skill needs both its own invoke
   * name (the folder, not our synthetic id) and the workspace it's scoped to:
   * `/that-skill` doesn't resolve in an agent running anywhere else. */
  function getActiveSkills() {
    return skills.filter((s) => s.active).map((s) => ({
      command: s.invokeName || s.id,
      workspaceId: s.workspaceId || null,
    }));
  }

  async function refresh() {
    skills = (await window.swarm.listSkills()) || [];
    render();
    window.swarm.checkSkillUpdates(); // background — results stream in via onSkillUpdateStatus
  }

  function showForm(show) {
    formEl.hidden = !show;
    if (show) { urlEl.value = ''; urlEl.focus(); }
  }

  addBtn.addEventListener('click', () => showForm(formEl.hidden));
  cancelBtn.addEventListener('click', () => showForm(false));
  submitBtn.addEventListener('click', async () => {
    const url = urlEl.value.trim();
    if (!url) return;
    submitBtn.disabled = true;
    const res = await window.swarm.installSkill(url);
    submitBtn.disabled = false;
    if (!res || !res.ok) { toast('install failed: ' + (res && res.reason)); return; }
    showForm(false);
    await refresh();
  });
  urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });

  window.swarm.onSkillUpdateStatus(({ id, updateAvailable }) => {
    const skill = skills.find((s) => s.id === id);
    if (!skill || skill.updateAvailable === updateAvailable) return;
    skill.updateAvailable = updateAvailable;
    render();
  });

  return { refresh, getActiveSkills };
})();
