# `renderer/features/message/`

Messages between agents.

One line, addressed with `@name` (several allowed) or `@all`, written
straight into those sessions. The `@` picker offers files from the selected
workspace.

The two-write channel is the one a task's prompt goes down — text, a beat, then
Enter — so Claude's input box sees a real keystroke rather than a pasted chunk
with a newline in it.

## Files

`message.js`, `message.css`

## Public interface

`Messenger.init({ toast, workspaceId, listAgents, send })`, `.open()`,
`.close()`, `.isOpen()`. A classic script.

## How to test

`Ctrl+Shift+E` or the envelope, with two agents running. `@all hello` should
reach both; the message should arrive as a submitted prompt, not sit unsent in
the input box.
