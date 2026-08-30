# `renderer/features/coordinator/`

The coordinator modal.

One multi-part request in, a reviewable list of board tasks out. Two states
in one modal: the request, then the split it came back with. **Nothing is
created until the rows are approved** — a misread request would otherwise spend
a whole agent per subtask before anyone saw it.

The split itself is one headless `claude -p --model haiku` call in
`main/coordinator.js`. This is not an agent: it holds no pane and no session.

## Files

`coordinator.js` · `coordinator.html`

The markup was in `renderer/index.html`. It is here now, as
`<template data-mount="…">` sections that `lib/fragments.js` puts into the
shell before any module runs.

## Public interface

`Coordinator.open({ workspaceId, workspaceName, roles, onCreate })` and
`Coordinator.close()`. An ES module; owns no app state.

## How to test

**+ Agent → Coordinator**, type a request with several parts, press Split,
then Create. The rows should land on the board as ordinary pending tasks.
