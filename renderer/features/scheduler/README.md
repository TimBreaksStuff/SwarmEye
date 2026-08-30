# `renderer/features/scheduler/`

Which task starts, and when.

Main only *stores* tasks; this decides which one runs. A task starts when an
agent slot and usage headroom are both free, then the launch sequence types its
prompt into the new pane — skills first, then the mode, model and effort, then
the prompt itself, each with the settle delay the CLI needs to have drawn its
confirmation line.

The board draws tasks ([`../board/`](../board/README.md)); this starts them.

## Files

`scheduler.js`

## Public interface

`init(ctx)`, `runScheduler`, `startTask`, `createTask`, `startChain`,
`startRepeat`, `tryInjectPrompt`, `startManualSession`,
`waitForInjectionsToSettle`, `applyTaskSummary`, `renderBoard`, `renderArchive`,
`boardHandlers` and the `TASK_*_MS` delays. An ES module imported by `app.js`.

### The launch sequence

A just-created session owes this module a few things: skills to inject, a
prompt to type, a mode to settle, a turn to begin. Six sets and maps track
that, and they are **not** exported — `app.js` used to reach into all six,
adding to two and deleting from all of them on exit, so neither file owned the
sequence and either could leave it half-torn-down.

`app.js` still reports the session events, because that is where they arrive.
It says what happened, not which container to poke:

| Verb | When |
|---|---|
| `noteManualLaunch(id, launch)` | the empty-workspace card started this one, with these picks |
| `noteSessionStarted(id)` | `SessionStart` — claude's CLI is up and reading keys |
| `noteAgentTurn(id)` | any hook event but `Stop`/`SessionStart`: the agent is live on the prompt |
| `isStartingUp(id)` | a `Stop` landing now belongs to an injection, not to the task |
| `forgetSession(id)` | the session ended — all six at once, because a partial forget leaves a dead id gating the *next* session |

## How to test

Queue an "auto" task with no slot free, then close an agent — it should
start. Watch the pane: the prompt must arrive as a submitted keystroke, after
the mode and model lines, not interleaved with them.
