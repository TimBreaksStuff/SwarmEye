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
`boardHandlers`, the `TASK_*_MS` delays and the per-session bookkeeping sets.
An ES module imported by `app.js`.

## How to test

Queue an "auto" task with no slot free, then close an agent — it should
start. Watch the pane: the prompt must arrive as a submitted keystroke, after
the mode and model lines, not interleaved with them.
