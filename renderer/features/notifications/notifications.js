/* ---- Notifications: the bell, its popover, the docked panel, and the three
 * ways an agent event reaches you when you aren't looking at it (taskbar
 * flash, OS toast, spoken announcement) ----
 *
 * Split out of app.js. The *options* behind these — "Desktop notifications",
 * "Spoken notifications", the sound picker — belong to the Options popover and
 * are imported from features/settings; this module owns only what happens when
 * an event actually arrives. That is the one import between two features, and
 * it goes one way: settings never reaches back here (app.js hands it the two
 * things it needs through its own ctx), so there is no cycle to trip over.
 */

import { dragWidth, placePop } from '../../lib/dom.js';
import { Topbar } from '../rail/topbar.js';
import { Sounds } from '../sounds/sounds.js';

import { kbdPop, kbdShortcutsPop, desktopNotifs, notifSpeech } from '../settings/settings.js';

export const notifPopEl = document.getElementById('notif-pop');
export const notifPanelEl = document.getElementById('notif-panel');
const notifBtnEl = document.getElementById('notif-btn');

/* newest first: {paneId, agent, ws, kind, text, time, count} — restored from
 * the last run (agents outlive the app in tmux, so "what happened while it was
 * closed" is exactly when the history matters). Restored rows count as read. */
const notifs = (() => {
  try { return JSON.parse(localStorage.getItem('swarmeye.notifs')) || []; }
  catch { return []; }
})();
let notifUnread = 0;
const NOTIF_MAX = 50;

function persistNotifs() {
  try { localStorage.setItem('swarmeye.notifs', JSON.stringify(notifs)); } catch { /* full/blocked — history only */ }
}

/* Double-click the bell to mute — kills the OS toasts, the chime and the
 * spoken announcements without touching either option in the ⌨ popover, so the
 * settings you chose are still there when you unmute. The bell itself, the
 * panel and the taskbar flash stay: this silences what interrupts you, not
 * the history of what happened. */
export let notifMuted = localStorage.getItem('swarmeye.notifMuted') === '1';

/* set once by init() — what the row handlers need from app.js */
let ctx = null;

export const notifHandlers = {
  onClear() {
    notifs.length = 0;
    notifUnread = 0;
    persistNotifs();
    renderNotifs();
  },
  onDismiss(n) {
    const i = notifs.indexOf(n);
    if (i >= 0) notifs.splice(i, 1);
    persistNotifs();
    renderNotifs();
  },
  onExpand() {
    closeNotifPop();
    notifPanelEl.hidden = false;
    renderNotifs(); // both lists are only built while they are visible
  },
  async onOpen(paneId) {
    const pane = ctx.state.panes.get(paneId);
    if (!pane) { ctx.toast('this agent is gone'); return; }
    closeNotifPop();
    ctx.toggleBoard(false);
    if (pane.session.workspaceId !== ctx.state.selectedWorkspaceId) {
      await ctx.selectWorkspace(pane.session.workspaceId);
    }
    pane.focus();
  },
  onApprove(paneId, always) {
    const pane = ctx.state.panes.get(paneId);
    if (!pane) { ctx.toast('this agent is gone'); return; }
    if (!pane.respondToPrompt('yes', always)) ctx.toast("couldn't read the prompt — open the pane");
  },
  onDeny(paneId) {
    const pane = ctx.state.panes.get(paneId);
    if (!pane) { ctx.toast('this agent is gone'); return; }
    if (!pane.respondToPrompt('no', false)) ctx.toast("couldn't read the prompt — open the pane");
  },
};

/* closing the popover marks everything as read — bell back to grey */
export function closeNotifPop() {
  if (notifPopEl.hidden) return;
  notifPopEl.hidden = true;
  notifUnread = 0;
  renderNotifs();
}

/* dock badge: mirror of the bell's unread count, sent only when it changes.
 * Rides the existing 'notify' channel — a badge-only payload never flashes. */
let lastBadge = -1;

export function renderNotifs() {
  // a 'wait' row only earns its ✓/✕ while its agent still has a yes/no menu
  // up — the row itself is history and outlives the prompt behind it
  for (const n of notifs) {
    const pane = n.kind === 'wait' ? ctx.state.panes.get(n.paneId) : null;
    n.canRespond = !!(pane && pane.awaitingPrompt && pane.promptAnswerable);
  }
  if (notifUnread !== lastBadge) {
    lastBadge = notifUnread;
    window.swarm.notify({ badge: notifUnread });
  }
  // answerable prompts float to the top — the rows you can still act on;
  // stable sort keeps time order within each half, notifs itself stays put
  const ordered = [...notifs].sort((a, b) => (b.canRespond === true) - (a.canRespond === true));
  Topbar.renderNotifications(ordered, notifUnread, notifHandlers);
  Topbar.renderNotifPanel(ordered, notifHandlers);
}

export function pushNotif(pane, kind, text) {
  // the same event again on the same agent bumps a ×N on the newest row
  // instead of flooding the 50-row cap — a busy loop can 'finish its turn'
  // dozens of times an hour
  const top = notifs[0];
  if (top && top.paneId === pane.session.id && top.kind === kind && top.text === text) {
    top.count = (top.count || 1) + 1;
    top.time = Date.now();
  } else {
    notifs.unshift({
      paneId: pane.session.id,
      agent: pane.session.agentName,
      ws: pane.session.workspaceName,
      wsId: pane.session.workspaceId,
      kind,
      text,
      cmd: pane.initialCommandText,
      model: pane.modelLabel || null,
      mode: pane.modeSel.selectedOptions[0].textContent,
      createdAt: pane.session.createdAt || null,
      time: Date.now(),
      count: 1,
    });
    if (notifs.length > NOTIF_MAX) notifs.length = NOTIF_MAX;
  }
  if (notifPopEl.hidden) notifUnread += 1; // a coalesced repeat is still news
  persistNotifs();
  renderNotifs();
}

/* Flash the taskbar/dock and — when the option is on — raise an OS
 * notification naming the agent and what it did. */
export function notifyOS(pane, text) {
  window.swarm.notify({
    title: `${pane.session.agentName} · ${pane.session.workspaceName}`,
    body: text,
    desktop: desktopNotifs && !notifMuted,
  });
}

/* A workspace name is a folder name, not a phrase, and it is the only free
 * text left in the announcement — so the two shapes that actually turn up get
 * fixed before it is read out: a sort prefix ("03 - SwarmEye" is said as "zero
 * three dash SwarmEye") and a camelCase run ("DisruptiveNegotiations" comes
 * out as one mangled word). Deliberately not a second speechClean: everything
 * else a folder can be called reads well enough as-is. */
function sayableName(name) {
  return String(name || '')
    .replace(/^\W*\d+\W+/, '') // leading "03 - ", "1. ", "04 -  "
    .replace(/([a-z\d])([A-Z])/g, '$1 $2') // DisruptiveNegotiations
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* One fixed sentence: who finished, and where. Nothing waits for the agent's
 * closing message, so a finished turn is announced on the Stop that ended it
 * rather than a beat later. Kept short on purpose — "Agent … in workspace … is
 * finished" was 4.7 seconds of audio, five words of it carrying nothing, and a
 * busy swarm cuts one announcement off with the next. A session with no
 * workspace name says the agent alone. */
export function speakDone(pane) {
  if (!notifSpeech || notifMuted) return;
  const where = sayableName(pane.session.workspaceName);
  Sounds.speak(where
    ? `${pane.session.agentName} finished in ${where}`
    : `${pane.session.agentName} finished`);
}

function syncMuted() {
  notifBtnEl.classList.toggle('muted', notifMuted);
  notifBtnEl.dataset.tip = notifMuted
    ? 'Notifications muted — double-click to unmute'
    : 'Notifications — what your agents did (double-click to mute)';
}

export function init(context) {
  ctx = context;

  document.getElementById('notif-panel-close').addEventListener('click', () => { notifPanelEl.hidden = true; });
  document.getElementById('notif-panel-clear').addEventListener('click', () => notifHandlers.onClear());

  /* drag the panel's left edge to resize it — same handle as the preview dock,
   * width remembered across restarts */
  dragWidth(document.getElementById('notif-panel-resizer'), notifPanelEl,
    { key: 'swarmeye.notifPanelWidth', min: 300 });

  notifBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (notifPopEl.hidden) {
      kbdPop.hidden = true; // popovers are mutually exclusive
      kbdShortcutsPop.hidden = true;
      // anchor the popover right below the bell (the top bar can be zoomed)
      placePop(notifPopEl, notifBtnEl, { align: 'right', gap: 8 });
      notifPopEl.hidden = false;
      renderNotifs(); // the list is only built while it is visible
    } else {
      closeNotifPop(); // second click on the bell = mark as read
    }
  });
  document.addEventListener('click', (e) => {
    if (!notifPopEl.hidden && !notifPopEl.contains(e.target)) closeNotifPop();
  });

  notifBtnEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    notifMuted = !notifMuted;
    localStorage.setItem('swarmeye.notifMuted', notifMuted ? '1' : '0');
    syncMuted();
    closeNotifPop(); // the two clicks that got us here left it open or shut at random
  });

  syncMuted();
  renderNotifs();
}
