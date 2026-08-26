# `renderer/features/coordinator/`

The coordinator modal.

One multi-part request in, a reviewable list of board tasks out. Two states
in one modal: the request, then the split it came back with. **Nothing is
created until the rows are approved** — a misread request would otherwise spend
a whole agent per subtask before anyone saw it.

The split itself is one headless `claude -p --model haiku` call in
`main/coordinator.js`. This is not an agent: it holds no pane and no session.

## Files

`coordinator.js`

## Public interface

`Coordinator.open({ workspaceId, workspaceName, roles, onCreate })` and
`Coordinator.close()`. A classic script; owns no app state.

## How to test

**+ Agent → Coordinator**, type a request with several parts, press Split,
then Create. The rows should land on the board as ordinary pending tasks.
