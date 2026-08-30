# `renderer/features/board/`

The task board.

The full-screen queue of todos: create, edit, reorder, categorise, archive.
It is a view swapped in for the agent grid, not a modal — `app.js`'s
`toggleBoard` forces the Skills view closed at the same time.

The board **draws** tasks; which one starts, and when, is
[`../scheduler/`](../scheduler/README.md).

## Files

`board.js`, `board.css` · `board.html`

The markup was in `renderer/index.html`. It is here now, as
`<template data-mount="…">` sections that `lib/fragments.js` puts into the
shell before any module runs.

## Public interface

`Board` — `render`, `renderArchive`, `toggleArchive`, `setDefaults`,
`showForm`, `closeSessionView`, `stopDictation`, `toggleDictation`,
`isFormOpen`, `REPEAT_MS`. An ES module.

## Conventions

The view is one console card (`.board-box`): a title bar, then bands separated
by dividers — each band carries its own padding, so `#board-main` has none.

Two form controls are styled, not replaced: the four "when" radios and the two
option checkboxes are still the real inputs `board.js` reads, taken out of the
layout inside `.board-seg` / `.board-toggle` labels that `:has(input:checked)`
lights up. The harness picker's caption follows the `<select>` out of sight via
`.board-field:has(> select[hidden])`, since `board.js` only toggles the select.

`board.css` loads *before* `chrome-clean.css` (slot 3, see
[`../../styles/README.md`](../../styles/README.md)), so the few rules that have
to beat it — the bare Close button, the chip-row button sizes, a card's
background on a column — win on specificity rather than order.

## How to test

`npm start`, **Task Board** (or `Ctrl+B`). Add a task, edit it, archive it,
open a completed task's transcript. `Ctrl+R` toggles dictation while the form
is open.
