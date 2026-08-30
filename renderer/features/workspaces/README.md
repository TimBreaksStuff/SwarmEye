# `renderer/features/workspaces/`

The workspace list, and everything done to it.

A workspace is a folder with agents in it. This owns adding, removing,
renaming, reordering and selecting one. The rail (`features/rail/`) *draws* the
list; `app.js` holds the state everyone reads.

Removing is the only destructive one, and it goes through the app-wide
`lib/confirm.js` like every other destructive control, so an armed pane ✕ and
an armed workspace ✕ can never be live at once. It kills the workspace's agents
— including detached ones, which read as exited while their tmux agent is still
running, and would otherwise be orphaned.

## Files

`workspaces.js`

## Public interface

`init(ctx)`, then `selectWorkspace(id)`, `addWorkspace()`,
`removeWorkspace(id, btn)`, `renameWorkspace(id, name)`,
`reorderWorkspaces(dragId, targetId, before)`, `cycleWorkspace(dir)` and
`killSessionChecked(id)`.

`ctx` is `{ state, grid, syncGrid, syncChrome, panesForWs }` — `app.js` owns
the state and the two repaints; this owns what happens to the list.

`killSessionChecked` is here rather than with the agent lifecycle because the
only thing it adds over `window.swarm.killSession` is the toast for *"main
could not reach tmux"*, and removing a workspace is what raises it in bulk.

## How to test

`npm start`. Add a folder, rename it in the rail, drag it past another and
restart — the order sticks. With agents running in it, press its ✕ once (a
toast counts them), then again (they die and the workspace goes).
`Ctrl+Tab` walks the list in the order the rail shows.
