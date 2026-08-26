# `renderer/features/grid/`

The agent grid.

The layout engine behind the panes: rows and columns when auto-organize is
on, a free canvas of remembered rectangles when it is off. Splitting a pane
places the new one beside its parent; maximising one hides the rest.

## Files

`grid.js`

## Public interface

`new GridController(container)` — `add`, `remove`, `replace`, `setPanes`,
`insertSplit`, `movePane`, `toggleMax`, `setMaximized`, `relayout`,
`setGutter`, `setAutoOrganize`, `saveLayout`. A classic script.

## How to test

`npm start` with two or more agents. Split with `→`/`↓`, drag a pane onto
another, maximise with `Ctrl+M`, and turn auto-organize off in Options — the
layout should survive a resize and a restart.
