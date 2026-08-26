/* IPC: workspaces — adding, removing, renaming, reordering and selecting them,
 * plus everything addressed by a workspace id: its files, its areas, its task
 * categories, its git chip and its preview server.
 *
 * Every handler resolves the path server-side from the id, so the renderer
 * never names a path and there is nothing to escape out of. */

const { ipcMain, dialog } = require('electron');
const config = require('../config');
const template = require('../template');
const agentScope = require('../scope');
const attach = require('../attach');
const preview = require('../preview');
const path = require('path');
const { listBranches, checkoutBranch, diffStat } = require('../git');

module.exports = function register(deps) {
  const { git } = deps;

  ipcMain.handle('workspace:add', async () => {
    const res = await dialog.showOpenDialog(deps.win, {
      title: 'Add workspace folder',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const p = res.filePaths[0];
    /* The standard CLAUDE.md, before anything else looks at the folder: it
     * skips a folder that already has one, so running it on the re-added and
     * already-registered paths too costs a stat and covers the case where the
     * template was set after the workspace was first added. */
    const templateResult = template.apply(p);
    const cfg = config.load();
    const existing = cfg.workspaces.find((w) => w.path === p);
    if (existing) return { workspace: existing, workspaces: cfg.workspaces, template: templateResult };
    /* Adding a folder that was removed earlier brings the old workspace back
     * rather than minting a second one for the same path: its id is what the
     * tasks and sessions are filed under, so a new id would orphan all of
     * them and leave the archived entry behind forever. */
    const archived = (cfg.archivedWorkspaces || []).find((w) => w.path === p);
    if (archived) {
      cfg.archivedWorkspaces = cfg.archivedWorkspaces.filter((w) => w.id !== archived.id);
      cfg.workspaces.push(archived);
      cfg.selectedWorkspaceId = archived.id;
      config.save(cfg);
      if (git) git.tick();
      return { workspace: archived, workspaces: cfg.workspaces, selectedWorkspaceId: cfg.selectedWorkspaceId, template: templateResult };
    }
    const ws = {
      id: 'ws_' + Math.random().toString(36).slice(2, 8),
      name: path.basename(p),
      path: p,
      categories: [...config.DEFAULT_TASK_CATEGORIES],
    };
    cfg.workspaces.push(ws);
    if (!cfg.selectedWorkspaceId) cfg.selectedWorkspaceId = ws.id;
    config.save(cfg);
    if (git) git.tick(); // git chip for the new workspace without the poll delay
    return { workspace: ws, workspaces: cfg.workspaces, selectedWorkspaceId: cfg.selectedWorkspaceId, template: templateResult };
  });

  // what the message box can attach to a prompt: a file from this workspace
  // (the @ picker) or an image from the clipboard. Both resolve to a path the
  // *agent* can open — see main/attach.js — and both take a workspace id
  // rather than a path, like every other handler here.
  ipcMain.handle('workspace:files', async (e, id) => {
    const ws = config.load().workspaces.find((w) => w.id === id);
    if (!ws) return [];
    try { return await attach.listFiles(ws); } catch { return []; }
  });

  ipcMain.handle('attach:image', (e, dataUrl) => attach.saveImage(dataUrl));

  /* The workspace's areas (main/scope.js): what its `.swarmeye/areas.json`
   * carves it into, for the scope pickers. Resolved server-side from the id
   * like every other workspace path, and re-read on each call — the file is
   * the repo's, so an agent may have just rewritten it. */
  ipcMain.handle('areas:read', (e, id) => {
    const ws = config.load().workspaces.find((w) => w.id === id);
    return { areas: ws ? agentScope.readAreas(ws.path) : [] };
  });

  // per-workspace task categories — every workspace starts with the same
  // three defaults (config.DEFAULT_TASK_CATEGORIES) but can add/remove freely
  ipcMain.handle('workspace:add-category', (e, { id, name }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    const clean = String(name || '').trim().slice(0, 30);
    if (ws && clean && !ws.categories.includes(clean)) {
      ws.categories = [...ws.categories, clean];
      config.save(cfg);
    }
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:remove-category', (e, { id, name }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    if (ws) {
      ws.categories = ws.categories.filter((c) => c !== name);
      config.save(cfg);
    }
    return { workspaces: cfg.workspaces };
  });

  // the preview dock asks where its dev server is; main probes, then starts one
  ipcMain.handle('preview:resolve', (e, { workspaceId, preferred }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, reason: 'no-workspace' };
    return preview.resolve(ws.path, workspaceId, preferred);
  });

  ipcMain.handle('preview:stop', (e, { workspaceId }) => preview.stop(workspaceId).then(() => ({ ok: true })));

  // removing a workspace archives it (the folder ref, not the agents) so that
  // re-adding the same folder via workspace:add brings the old workspace —
  // and everything filed under its id — back instead of minting a new one
  ipcMain.handle('workspace:remove', (e, id) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    cfg.workspaces = cfg.workspaces.filter((w) => w.id !== id);
    if (ws) {
      cfg.archivedWorkspaces = (cfg.archivedWorkspaces || []).filter((w) => w.path !== ws.path);
      cfg.archivedWorkspaces.unshift(ws);
    }
    if (cfg.selectedWorkspaceId === id) {
      cfg.selectedWorkspaceId = cfg.workspaces.length ? cfg.workspaces[0].id : null;
    }
    config.save(cfg);
    return {
      workspaces: cfg.workspaces,
      selectedWorkspaceId: cfg.selectedWorkspaceId,
    };
  });

  // branch dropdown on the pane git chip
  ipcMain.handle('git:branches', (e, workspaceId) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    return ws ? listBranches(ws) : null;
  });

  // diff summary shown above the branch list in that same popover
  ipcMain.handle('git:diff', (e, workspaceId) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    return ws ? diffStat(ws) : null;
  });

  ipcMain.handle('git:checkout', async (e, { workspaceId, branch, create }) => {
    const ws = config.load().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, error: 'unknown workspace' };
    const res = await checkoutBranch(ws, String(branch || ''), { create: !!create });
    if (res.ok && git) git.tick(); // update every chip without the poll delay
    return res;
  });

  ipcMain.handle('workspace:reorder', (e, ids) => {
    const cfg = config.load();
    const byId = new Map(cfg.workspaces.map((w) => [w.id, w]));
    const next = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const w = byId.get(id);
      if (w) { next.push(w); byId.delete(id); }
    }
    next.push(...byId.values()); // never lose a workspace the renderer forgot
    cfg.workspaces = next;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:rename', (e, { id, name }) => {
    const cfg = config.load();
    const ws = cfg.workspaces.find((w) => w.id === id);
    const trimmed = String(name || '').trim().slice(0, 40);
    if (ws && trimmed) ws.name = trimmed;
    config.save(cfg);
    return { workspaces: cfg.workspaces };
  });

  ipcMain.handle('workspace:select', (e, id) => {
    config.patch({ selectedWorkspaceId: id });
    return { ok: true };
  });
};
