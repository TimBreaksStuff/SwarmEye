# `renderer/features/board/`

The task board.

The full-screen queue of todos: create, edit, reorder, categorise, archive.
It is a view swapped in for the agent grid, not a modal — `app.js`'s
`toggleBoard` forces the Skills view closed at the same time.

The board **draws** tasks; which one starts, and when, is
[`../scheduler/`](../scheduler/README.md).

## Files

`board.js`, `board.css`

## Public interface

`window.Board` — `render`, `renderArchive`, `toggleArchive`, `setDefaults`,
`showForm`, `closeSessionView`, `stopDictation`, `toggleDictation`,
`isFormOpen`, `REPEAT_MS`. A classic script.

## How to test

`npm start`, **Task Board** (or `Ctrl+B`). Add a task, edit it, archive it,
open a completed task's transcript. `Ctrl+R` toggles dictation while the form
is open.
