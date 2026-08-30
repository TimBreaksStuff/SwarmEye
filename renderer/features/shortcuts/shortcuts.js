/* renderer/features/shortcuts/ — the keyboard map, and what Escape closes.
 *
 * Three things live here, and they are one concern: a key is pressed and
 * something in some other area happens.
 *
 *   - `isShortcut(e)`, the pure predicate. Terminals get it through xterm's
 *     attachCustomKeyEventHandler so they ignore these keys; execution happens
 *     exactly once, in the document listener the event bubbles up to.
 *   - `handleShortcut(e)`, the dispatch.
 *   - the Escape chain — an ordered list, outermost first, first open one wins
 *     and nothing below it sees the key.
 *
 * Every arm of the dispatch is a call into some other area, which is what a
 * keyboard map *is*; the `ctx` below is that list of verbs, handed over once
 * by app.js. It was inline in app.js, where it made a chokepoint file longer
 * for no reason: nothing else in that file reads any of it.
 */

import { IS_MAC, modHeld } from '../../lib/keys.js';
import { toast } from '../../lib/toast.js';
import { Pane } from '../pane/index.js';
import { Board } from '../board/board.js';
import { Palette } from '../palette/palette.js';

/* Everything a key press can reach. app.js hands it over because app.js is
 * where the state and the agent lifecycle live; the escapable list is passed
 * in rather than built here because most of its entries are other areas'
 * elements and their own close functions. */
let ctx = null;

export function init(next) {
  ctx = next;
  document.addEventListener('keydown', onKeyDown);
  localizeShortcutLabels();
}

export function focusedPane() {
  return ctx.state.lastFocused && ctx.grid.panes.includes(ctx.state.lastFocused)
    ? ctx.state.lastFocused
    : ctx.grid.panes[0] || null;
}

export function cycleAgent(dir) {
  const n = ctx.grid.panes.length;
  if (!n) return;
  const cur = focusedPane();
  const i = ctx.grid.panes.indexOf(cur);
  ctx.grid.panes[((i === -1 ? 0 : i) + dir + n) % n].focus();
}

/* ---- shortcuts ----
 * MOD is Ctrl on Windows and Cmd on macOS (where Ctrl works too).
 *
 * Tab                  next agent in this workspace
 *                      (Shift+Tab and Ctrl+I pass through to the terminal:
 *                       claude uses Shift+Tab, Ctrl+I types a literal tab)
 * Ctrl+Tab / +Shift    next / previous workspace — Ctrl on both platforms,
 *                      since Cmd+Tab is the macOS app switcher
 * MOD+'+' / '-' / 0    font size of the focused pane (bigger/smaller/reset)
 * MOD+N                new agent
 * MOD+M                new agent copying the active one
 * MOD+.                focus the agent that has been blocked longest, then
 *                      the next one down on the press after that
 * MOD+X                close focused agent (again within 5s: confirm kill)
 * MOD+T                task board, new-task form (dashboard)
 * MOD+R                dictate — mic in the focused pane, or the task-board
 *                      form's mic if the board is open
 * MOD+Shift+1..9,0     focus visible pane N (again: toggle maximize)
 * MOD+Shift+M          maximize/restore focused pane
 * MOD+Shift+F          search in focused pane
 * MOD+Shift+G          search across all agents
 * MOD+Shift+B          task board
 *
 * Terminals get the pure predicate (via attachCustomKeyEventHandler) so
 * xterm ignores these keys; execution happens exactly once, in the
 * document-level keydown listener the event bubbles up to. */

export function isShortcut(e) {
  if (e.type !== 'keydown' || e.altKey) return false;
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.shiftKey) return true;
  if (e.key === 'Tab') return e.ctrlKey && !e.metaKey;
  if (!modHeld(e)) return false;
  if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') return true;
  if (e.key === '0' && !e.shiftKey) return true;
  if (e.code === 'KeyN' && !e.shiftKey) return true;
  if (e.code === 'KeyM' && !e.shiftKey) return true;
  if (e.code === 'KeyX' && !e.shiftKey) return true;
  if (e.code === 'KeyT' && !e.shiftKey) return true;
  if (e.code === 'KeyR' && !e.shiftKey) return true;
  if (e.code === 'KeyK' && !e.shiftKey) return true;
  if (e.code === 'Period' && !e.shiftKey) return true;
  if (!e.shiftKey) return false;
  return e.code === 'KeyM' || e.code === 'KeyF' || e.code === 'KeyG' || e.code === 'KeyB'
    || e.code === 'KeyS' || e.code === 'KeyE' || /^Digit\d$/.test(e.code);
}

/* MOD+. — the attention queue. Running many agents *is* answering whoever is
 * blocked, and that loop used to start with a visual scan of every pane for a
 * dot that had changed colour. Oldest wait first; pressing it again moves down
 * the queue, since the queue is re-derived on every press (a pane that started
 * waiting, or stopped, simply changes where the next press lands). */
async function focusLongestWaiting() {
  const waiting = [...state.panes.values()]
    .filter((p) => !p.exited && p.awaitingPrompt && p.waitingSince > 0)
    .sort((a, b) => a.waitingSince - b.waitingSince);
  if (!waiting.length) { toast('nobody is waiting'); return; }
  // -1 (nothing focused, or the focused pane is not in the queue) lands on the
  // oldest; the oldest itself lands on the next one down
  const at = waiting.indexOf(focusedPane());
  const pane = waiting[(at + 1) % waiting.length];
  ctx.toggleBoard(false);
  if (pane.session.workspaceId !== ctx.state.selectedWorkspaceId) {
    await ctx.selectWorkspace(pane.session.workspaceId);
  }
  pane.focus();
}

export function handleShortcut(e) {
  if (!isShortcut(e)) return false;

  if (e.key === 'Tab') {
    if (e.ctrlKey) ctx.cycleWorkspace(e.shiftKey ? -1 : 1);
    else cycleAgent(1);
    return true;
  }

  const focused = focusedPane();

  if (e.key === '+' || e.key === '=') { if (focused) focused.setFontSize(focused.term.options.fontSize + 1); return true; }
  if (e.key === '-' || e.key === '_') { if (focused) focused.setFontSize(focused.term.options.fontSize - 1); return true; }
  if (e.key === '0' && !e.shiftKey) { if (focused) focused.setFontSize(Pane.DEFAULT_FONT_SIZE); return true; }

  if (e.code === 'Period' && !e.shiftKey) { focusLongestWaiting(); return true; }
  if (e.code === 'KeyK' && !e.shiftKey) { Palette.toggle(); return true; }
  if (e.code === 'KeyN' && !e.shiftKey) { ctx.newAgentShortcut(); return true; }
  if (e.code === 'KeyM' && !e.shiftKey) { ctx.cloneActiveAgent(); return true; }
  if (e.code === 'KeyX' && !e.shiftKey) { if (focused) focused.requestClose(); return true; }
  if (e.code === 'KeyT' && !e.shiftKey) { ctx.toggleBoard(true); return true; }
  if (e.code === 'KeyR' && !e.shiftKey) {
    if (!ctx.boardEl.hidden && Board.isFormOpen()) Board.toggleDictation();
    else if (focused) focused.toggleDictation();
    return true;
  }
  if (e.code === 'KeyM' && focused) { ctx.grid.toggleMax(focused); return true; }
  if (e.code === 'KeyF' && focused) { focused.toggleSearch(); return true; }
  if (e.code === 'KeyB') { ctx.toggleBoard(ctx.boardEl.hidden); return true; }

  const m = /^Digit(\d)$/.exec(e.code);
  if (m) {
    const n = m[1] === '0' ? 10 : Number(m[1]);
    const pane = ctx.grid.panes[n - 1];
    if (pane) {
      if (pane === focused && pane.el.classList.contains('focused')) ctx.grid.toggleMax(pane);
      else pane.focus();
    }
    return true;
  }
  return false;
}

/* Escape closes the innermost thing that is open. app.js builds the list —
 * most entries are another area's element and that area's own close function,
 * and app.js is the file that already imports every one of them. */
function onKeyDown(e) {
  if (e.key === 'Escape') {
    for (const [el, close] of ctx.escapable) {
      if (!el().hidden) { close(); return; }
    }
  }
  if (handleShortcut(e)) e.preventDefault();
}

/* index.html spells every shortcut the Windows way. On macOS the modifier is
 * Cmd, and the labels use the glyphs users expect there. Two labels stay Ctrl
 * on both platforms and opt out with data-keep-ctrl: Ctrl+Tab (Cmd+Tab is the
 * macOS app switcher) and Ctrl+I (a literal tab byte for the terminal). */
function localizeShortcutLabels() {
  if (!IS_MAC) return;
  const toMac = (t) => t.replace(/Ctrl\+Shift\+/g, '⌘⇧').replace(/Ctrl\+/g, '⌘');
  for (const el of document.querySelectorAll('kbd:not([data-keep-ctrl])')) {
    el.textContent = toMac(el.textContent);
  }
  for (const el of document.querySelectorAll('[data-tip], [aria-label]')) {
    if (el.hasAttribute('data-keep-ctrl')) continue;
    if (el.dataset.tip) el.dataset.tip = toMac(el.dataset.tip);
    const label = el.getAttribute('aria-label');
    if (label) el.setAttribute('aria-label', toMac(label));
  }
}
