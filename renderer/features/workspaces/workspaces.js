/* renderer/features/workspaces/ — the workspace list and everything done to it.
 *
 * A workspace is a folder with agents in it. This owns adding, removing,
 * renaming, reordering and selecting one; the rail draws the list
 * (features/rail/), and app.js holds the state they all read.
 *
 * Removing is the only destructive one, and it is armed through the app-wide
 * Confirm like every other destructive control, so an armed pane ✕ and an
 * armed workspace ✕ can never be live at once.
 *
 * It was in app.js, which is a chokepoint: every session touching any feature
 * opened the same file.
 */

import { Confirm } from '../../lib/confirm.js';
import { toast } from '../../lib/toast.js';
import { Preview } from '../preview/preview.js';

/* { state, grid, syncGrid, syncChrome, panesForWs } — app.js owns the state
 * and the two repaints; this owns what happens to the list. */
let ctx = null;

export function init(next) {
  ctx = next;
  document.getElementById('add-workspace').addEventListener('click', addWorkspace);
}

export async function selectWorkspace(id) {
  if (id === ctx.state.selectedWorkspaceId) return;
  ctx.state.selectedWorkspaceId = id;
  await window.swarm.selectWorkspace(id);
  Preview.setWorkspace(id); // each workspace remembers its own preview address
  ctx.syncGrid();
  ctx.syncChrome();
}

/* main refuses the kill when it can't reach tmux (the agent would be left
 * running invisibly) — the pane is already gone from the UI by then, so all
 * that's left to do is say so; the kept metadata reattaches it next launch */
export function killSessionChecked(id) {
  window.swarm.killSession(id).then((res) => {
    if (res && !res.ok) toast('could not reach tmux — that agent is still running and will reattach on the next launch');
  });
}

/* removing a workspace kills its agents — armed through the app-wide Confirm
 * like every other destructive control, so an armed pane ✕ and an armed
 * workspace ✕ can never be live at once */
export async function removeWorkspace(id, btn) {
  const agents = ctx.panesForWs(id);
  if (agents.length && btn) {
    const fired = Confirm.armOrFire(btn, 'ws-remove:' + id, () => doRemoveWorkspace(id));
    if (!fired) {
      const running = agents.filter((p) => !p.exited || p.detached).length;
      toast(running
        ? `this workspace has ${running} running agent${running > 1 ? 's' : ''} — click ✕ again to remove it and kill them`
        : 'click ✕ again to remove this workspace and its exited panes');
    }
    return;
  }
  doRemoveWorkspace(id, agents);
}

// the armed path re-reads the panes when it finally fires, seconds later
async function doRemoveWorkspace(id, agents = ctx.panesForWs(id)) {
  for (const pane of agents) {
    // detached panes read as exited but their tmux agent is still running —
    // kill those too, or removing the workspace would orphan live agents
    if (!pane.exited || pane.detached) killSessionChecked(pane.session.id);
    if (ctx.state.lastFocused === pane) ctx.state.lastFocused = null;
    ctx.state.panes.delete(pane.session.id);
    ctx.grid.remove(pane); // disposes; no-op removal if the pane wasn't visible
  }

  const res = await window.swarm.removeWorkspace(id);
  ctx.state.workspaces = res.workspaces;
  ctx.state.selectedWorkspaceId = res.selectedWorkspaceId;
  ctx.syncGrid();
  ctx.syncChrome();
  toast('workspace removed');
}

export async function renameWorkspace(id, name) {
  const ws = ctx.state.workspaces.find((w) => w.id === id);
  if (ws) ws.name = name; // optimistic; ctx.syncChrome() below repaints the pill
  await window.swarm.renameWorkspace(id, name);
  ctx.syncChrome();
}

/* drag-reorder: move dragId before/after targetId, persist the new order */
export function reorderWorkspaces(dragId, targetId, before) {
  const list = ctx.state.workspaces;
  const from = list.findIndex((w) => w.id === dragId);
  if (from === -1) return;
  const [moved] = list.splice(from, 1);
  let to = list.findIndex((w) => w.id === targetId);
  if (to === -1) { list.splice(from, 0, moved); return; }
  if (!before) to += 1;
  list.splice(to, 0, moved);
  ctx.syncChrome();
  window.swarm.reorderWorkspaces(list.map((w) => w.id));
}

export async function addWorkspace() {
  const res = await window.swarm.addWorkspace();
  if (res.canceled) return;
  ctx.state.workspaces = res.workspaces;
  if (res.selectedWorkspaceId) ctx.state.selectedWorkspaceId = res.selectedWorkspaceId;
  // the standard CLAUDE.md, if one is set and the folder had none of its own —
  // worth saying out loud, since it wrote a file into the user's repo
  if (res.template && res.template.copied) toast('CLAUDE.md added from your standard');
  ctx.syncGrid();
  ctx.syncChrome();
}

export function cycleWorkspace(dir) {
  // the rail's own order — Ctrl+Tab must walk what's on screen
  const list = ctx.state.workspaces;
  const n = list.length;
  if (n < 2) return;
  const i = list.findIndex((w) => w.id === ctx.state.selectedWorkspaceId);
  const next = list[((i === -1 ? 0 : i) + dir + n) % n];
  selectWorkspace(next.id);
}
