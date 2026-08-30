# `renderer/features/preview/`

The preview dock.

A `<webview>` beside the grid showing the workspace's dev server. Restricted
to localhost in the renderer *and* re-enforced in `main.js` at attach and at
navigate — two checks, on purpose.

`onAgentDone` is called from `app.js`'s `done` branch: a debounced self-reload,
so an agent's work shows without hand-hitting `⟳`.

## Files

`preview.js`, `preview.css` · `preview.html`

The markup was in `renderer/index.html`. It is here now, as
`<template data-mount="…">` sections that `lib/fragments.js` puts into the
shell before any module runs.

## Public interface

`Preview.init({ getWorkspaceId })`, `.setWorkspace(id)`,
`.onAgentDone(workspaceId)`. An ES module.

## How to test

`npm start` in a workspace with a dev server, then the screen button.
`preview:resolve` probes 3000/5173/… and starts one in its own tmux session if
none answers. A non-localhost URL must not load.
