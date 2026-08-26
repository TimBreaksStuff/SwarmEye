/* The + Agent button's menu: which kind of agent to start.
 *
 * Two plain agents lead it — that choice is the provider, Anthropic
 * subscription or OpenRouter catalog — and the role presets below are flavours
 * of the first one. The last two entries start no agent directly: the
 * coordinator splits a request into board tasks, and the orchestrator starts a
 * lead agent that delegates to workers.
 *
 * The role list comes from main once (main/roles.js owns the prompts and the
 * model tier each job is worth) and is shared with the two cards below, which
 * offer the same roles for their workers.
 *
 * Owns no app state: the workspace lookup, the launcher and the toast arrive
 * in `init`. */

import { open as openOrchestratorCard } from '../orchestrator/orchestrator.js';
import { createTask } from '../scheduler/scheduler.js';

let ctx = null;
let roles = []; // [{key, label, model}] — from main, once
let menuEl = null;
let undismiss = null; // dismissPop's teardown, live while the menu is up

const btnEl = document.getElementById('add-agent');

function close() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  undismiss();
  undismiss = null;
}

/* The coordinator splits into tasks, so it needs a workspace but no agent
 * slot — the cap applies later, when the scheduler starts what it produced. */
function openCoordinator() {
  const ws = ctx.selectedWorkspace();
  if (!ws) {
    ctx.toast('add and select a workspace first');
    return;
  }
  Coordinator.open({ workspaceId: ws.id, workspaceName: ws.name, roles, onCreate: createTask });
}

/* The lead agent takes an agent slot itself — but the cap is checked where
 * every other launch checks it (session:create), so this only needs the
 * workspace its swarm will work in. */
function openOrchestrator() {
  const ws = ctx.selectedWorkspace();
  if (!ws) {
    ctx.toast('add and select a workspace first');
    return;
  }
  openOrchestratorCard({ workspaceId: ws.id, workspaceName: ws.name, roles });
}

function build() {
  const menu = document.createElement('div');
  // its own class as well: the rows sit indented under their section labels,
  // which the branch and scope menus using .branch-menu must not pick up
  menu.className = 'branch-menu agent-kind-menu';
  const entries = [{ label: 'Provider', section: true },
    { label: 'Anthropic Subscription', strong: true, tip: 'A plain agent — your Options default model, no role prompt' }];
  // an OpenRouter agent is a plain agent on a catalog model — the entry only
  // exists once a key is saved (Options → Setup) and the catalog is in
  if (OpenRouterUI.models.length) entries.push({ label: 'OpenRouter', openrouter: true, strong: true, tip: 'A plain agent on any OpenRouter model — pick it from the catalog' });
  entries.push({ divider: true });
  entries.push({ label: 'Roles', section: true });
  for (const r of roles) entries.push({ label: r.label, role: r.key, tip: `${r.label} role prompt · ${r.model || 'default tier'}` });
  entries.push({ label: 'Coordinator', coordinate: true, tip: 'Split one multi-part request into subtasks on the board — nothing starts until you approve them' });
  entries.push({ label: 'Orchestrator', orchestrate: true, tip: 'One agent plans and delegates; its workers run on a model of their own' });
  for (const { label, role, tip, coordinate, orchestrate, openrouter, strong, divider, section } of entries) {
    if (divider) {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'branch-menu-divider' }));
      continue;
    }
    if (section) {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'branch-menu-label', textContent: label }));
      continue;
    }
    const row = elt('button', 'branch-item' + (strong ? ' branch-item-strong' : ''), label);
    row.dataset.tip = tip;
    row.addEventListener('click', () => {
      close();
      if (coordinate) openCoordinator();
      else if (orchestrate) openOrchestrator();
      // the picked model rides the same one-launch `launch` channel the
      // empty-workspace card uses; permissions keep the Options default
      else if (openrouter) OpenRouterUI.openModelMenu(btnEl, (model) => ctx.addAgent({
        launch: { model, effort: 'default', focus: null, startMode: localStorage.getItem('swarmeye.defaultStartMode') || 'default' },
      }));
      else ctx.addAgent({ role, claudeOnly: true });
    });
    menu.appendChild(row);
  }
  return menu;
}

export function init(context) {
  ctx = context;
  window.swarm.listRoles().then((list) => { roles = list || []; });

  btnEl.addEventListener('click', () => {
    if (menuEl) { close(); return; }
    const menu = build();
    document.body.appendChild(menu);
    placePop(menu, btnEl);
    menuEl = menu;
    undismiss = dismissPop(menu, close, { keep: [btnEl] });
  });
}
