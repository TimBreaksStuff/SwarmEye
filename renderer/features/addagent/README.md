# `renderer/features/addagent/`

The + Agent button's menu.

What kind of agent to start. Two plain agents lead the menu — that choice is
the provider, Anthropic subscription or OpenRouter catalog — and the role
presets below are flavours of the first. The last two entries start no agent
directly: **Coordinator** splits a request into board tasks, **Orchestrator**
starts a lead agent that delegates to workers.

## Files

`addagent.js` · `addagent.css`

The sheet is the role editor's one row adjustment, cut out of
`styles/chrome-clean.css`. Slot 5, after chrome-clean.css: the menu is built
from the shared branch-row shapes and this only nudges the row carrying a role.

## Public interface

`init({ toast, addAgent, selectedWorkspace })` — an ES module imported by
`app.js`. The role list comes from `roles:list` once and is shared with both
cards.

## How to test

Press **+ Agent**. The menu should show Provider and Roles sections, close on
a click outside or a second press, and each row should start what it names.
With no OpenRouter key saved the OpenRouter row is absent.
