# `renderer/features/shortcuts/`

The keyboard map, and what `Escape` closes.

Three things, one concern — a key goes down and something in some other area
happens:

- **`isShortcut(e)`**, a pure predicate with no side effects. Terminals get it
  through xterm's `attachCustomKeyEventHandler` so they *ignore* these keys;
  execution happens exactly once, in the document-level listener the event
  bubbles up to. Splitting the predicate from the action is what stops a
  shortcut firing twice.
- **`handleShortcut(e)`**, the dispatch.
- **the Escape chain**, an ordered list: outermost first, the first open one
  wins, and nothing below it sees the key.

Every arm of the dispatch is a call into another area, because that is what a
keyboard map is. `ctx` is that list of verbs, handed over once by `app.js`.

## Files

`shortcuts.js`

## Public interface

`init(ctx)` — installs the `keydown` listener and localises the labels in the
Options → Keyboard shortcuts panel. Also exports `isShortcut(e)` (for the pane
to hand xterm), `focusedPane()` and `handleShortcut(e)`.

`ctx` is `{ state, grid, boardEl, escapable, toggleBoard, toggleSkills,
selectWorkspace, cycleWorkspace, newAgentShortcut, cloneActiveAgent }`.

**`escapable` is built by `app.js`, not here.** Almost every entry pairs
another area's element with that area's own close function, and `app.js` is the
one file that already imports all of them. Building it here would mean
importing every area into the keyboard map.

## The one platform rule

`Ctrl` on Windows, `Cmd` (or `Ctrl`) on macOS, via `lib/keys.js`'s `modHeld`.
Never accept `metaKey` as the modifier on Windows — Chromium reports the
Windows key as `metaKey`, so `Win+N` would spawn an agent.

`index.html` spells every shortcut the Windows way and `localizeShortcutLabels`
rewrites the labels on macOS. Two opt out with `data-keep-ctrl`: `Ctrl+Tab`
(`Cmd+Tab` is the macOS app switcher) and `Ctrl+I`.

## How to test

`npm start`. `Ctrl/Cmd+K` opens the palette and `Esc` closes it; with the board
*and* the palette open, `Esc` closes the palette first and the board second.
On macOS the Options → Keyboard shortcuts panel should read `⌘K`, not `Ctrl+K`,
while `Ctrl+Tab` stays `Ctrl`.
