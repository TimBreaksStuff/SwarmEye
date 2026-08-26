# `renderer/features/palette/`

The command palette (`Ctrl+K`).

Every agent, workspace, task, skill, view and theme in one filter box. The
entries themselves are built by `app.js` — it is the one file that knows both
the app's state and what an entry should *do* — and rebuilt on every open, so a
closed agent or a finished task is never still offered.

The top bar's mic fills this box, which is how speech reaches every verb
without a second intent layer.

## Files

`palette.js`

## Public interface

`Palette.init({ getItems })`, `.open()`, `.close()`, `.toggle()`,
`.setQuery(text)`, `.isOpen()`. A classic script.

## How to test

`Ctrl+K`. Type part of an agent name, a task or a theme; Enter should run it.
Closing an agent and reopening the palette should drop its rows.
