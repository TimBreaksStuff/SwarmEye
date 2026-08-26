# `renderer/features/orchestrator/`

A lead agent and its workers.

The coordinator splits a *sentence*. This is the other thing: a real agent in
a pane that reads the repo, decides what the work is, and hands each piece to a
worker on whatever model workers are worth. The lead stays live and is told how
each worker went, so it can queue a second wave or call the job done.

Nothing here is a new kind of agent. The lead is an ordinary board task and
every worker is an ordinary board task, so the agent cap, the usage gate and the
billing rules all apply unchanged. The only new mechanism is the plan file,
which `main/orchestrator.js` watches.

## Files

`orchestrator.js`, `orchestrator.css`

## Public interface

`init(ctx)`, `open(...)`, `close()`, `popEl`, `restore()`, `onWorkerDone`,
`onWorkerGaveUp`, `isCrewWorker`, `hiddenIds`, `paintCrew`. An ES module
imported by `app.js`.

## How to test

**+ Agent → Orchestrator**, give it a brief. The lead should appear as a
pane; workers should appear as ordinary agents and report back on finishing.
Leads survive an app restart via `restore()`.
