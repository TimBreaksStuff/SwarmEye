/* Scope: which folder of the workspace an agent may edit. Exposes
 * window.Scope — the folder list the launch card and the + Agent menu offer,
 * and the little menu the second of those opens.
 *
 * The list is derived from the `@` picker's file list rather than a directory
 * walk of its own: that is one `git ls-files` main already caches, it knows
 * about .gitignore, and it cannot wander into node_modules — so this costs no
 * new IPC at all. Main is the one that turns a pick into deny rules
 * (main/scope.js); everything here is a chooser. */

import { dismissPop, elt, placePop } from '../../lib/dom.js';

// deep enough for renderer/features/pane, shallow enough that the select stays
// a list a human can read — a big repo has thousands of folders further down
const SCOPE_MAX_DEPTH = 4;
const SCOPE_MAX_DIRS = 200;

export const Scope = {
  cache: new Map(), // workspace id -> Promise<string[]>
  areaCache: new Map(), // workspace id -> Promise<[{label, paths}]>
  menuEl: null,

  /* What the workspace's own `.swarmeye/areas.json` carves it into — "Agent
   * pane", "Task board" — each several paths at once, which is the unit work
   * actually arrives in. A workspace without the file has none, and the
   * folder list below is all there is to pick from. */
  areas(workspaceId) {
    if (!workspaceId) return Promise.resolve([]);
    if (!this.areaCache.has(workspaceId)) {
      this.areaCache.set(workspaceId, window.swarm.listAreas(workspaceId)
        .then((r) => (r && r.areas) || []).catch(() => []));
    }
    return this.areaCache.get(workspaceId);
  },

  /* Everything pickable, in the order it is offered: the areas first, since
   * an area is the better unit, then the raw folders. `scope` is what a pick
   * sends to main — { label, paths }. */
  entries(workspaceId) {
    return Promise.all([this.areas(workspaceId), this.dirs(workspaceId)]).then(([areas, dirs]) => [
      ...areas.map((a) => ({
        value: 'area:' + a.label,
        label: a.label,
        group: 'Areas',
        tip: `Only inside ${a.paths.join(', ')}`,
        scope: { label: a.label, paths: a.paths },
      })),
      ...dirs.map((d) => ({
        value: 'dir:' + d,
        label: d,
        group: 'Folders',
        tip: `The agent may only edit inside ${d}`,
        scope: { label: d, paths: [d] },
      })),
    ]);
  },

  /* Every folder in the workspace that holds a file, shallowest first. Cached
   * per workspace for the life of the window: the launch card and the menu
   * both ask on every open, and a folder appearing mid-session is not worth a
   * round trip each time. */
  dirs(workspaceId) {
    if (!workspaceId) return Promise.resolve([]);
    if (!this.cache.has(workspaceId)) {
      this.cache.set(workspaceId, window.swarm.listWorkspaceFiles(workspaceId)
        .then((files) => {
          const seen = new Set();
          for (const file of files || []) {
            const parts = String(file).split('/');
            parts.pop(); // the file itself
            for (let i = 1; i <= Math.min(parts.length, SCOPE_MAX_DEPTH); i++) {
              seen.add(parts.slice(0, i).join('/'));
            }
          }
          return [...seen].sort().slice(0, SCOPE_MAX_DIRS);
        })
        .catch(() => []));
    }
    return this.cache.get(workspaceId);
  },

  // a workspace whose files changed shape (a branch checkout, a new area)
  forget(workspaceId) {
    if (workspaceId) { this.cache.delete(workspaceId); this.areaCache.delete(workspaceId); }
    else { this.cache.clear(); this.areaCache.clear(); }
  },

  close() {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    this.undismiss();
    this.undismiss = null;
  },

  /* The + Agent menu's picker: the same branch-menu the model and branch
   * lists use. onPick gets { label, paths }, or undefined for the whole
   * workspace. Areas lead, folders follow, one rule between them. */
  async open(anchor, workspaceId, onPick) {
    this.close();
    const entries = await this.entries(workspaceId);
    const menu = document.createElement('div');
    menu.className = 'branch-menu';
    const rows = [{ label: 'whole workspace', strong: true, tip: 'No boundary — the agent may edit anywhere in the workspace' }]
      .concat(entries);
    if (!entries.length) rows.push({ label: 'no folders found', disabled: true, tip: 'This workspace is not a git repository, or holds no tracked files' });
    const rule = () => menu.appendChild(Object.assign(document.createElement('div'), { className: 'branch-menu-divider' }));
    let lastGroup = null;
    for (const { label, scope, tip, group, strong, disabled } of rows) {
      // one rule under "whole workspace", one more where areas give way to folders
      if (lastGroup !== null && group !== lastGroup) rule();
      const row = elt('button', 'branch-item' + (strong || group === 'Areas' ? ' branch-item-strong' : ''), label);
      row.dataset.tip = tip;
      row.disabled = !!disabled;
      row.addEventListener('click', () => { this.close(); onPick(scope); });
      menu.appendChild(row);
      lastGroup = group || null;
    }
    document.body.appendChild(menu);
    // a pane's scope chip can sit low in the grid, so the menu flips above the
    // anchor when it would run off the bottom (dom.js placePop)
    placePop(menu, anchor, { flip: true });
    this.menuEl = menu;
    this.undismiss = dismissPop(menu, () => this.close());
  },

  undismiss: null, // dismissPop's teardown, live while the menu is up
};
