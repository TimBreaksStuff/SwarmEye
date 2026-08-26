# `renderer/features/scope/`

Confining an agent to part of a workspace.

The folder list the launch card and the + Agent menu offer, and the little
menu the second of those opens. An agent can read the whole workspace but only
edit inside its scope.

The list is derived from the `@` picker's file list rather than a directory walk
of its own: that is one `git ls-files` main already caches, it knows about
`.gitignore`, and it cannot wander into `node_modules` — so it costs no new IPC.
Main turns a pick into deny rules (`main/scope.js`); everything here is a
chooser.

## Files

`scope.js`

## Public interface

`window.Scope`. A classic script.

## How to test

`npm start` in a repo with a `.swarmeye/areas.json`. The card's scope select
should list those areas first, then plain folders. Start a scoped agent and ask
it to edit a file outside the scope — it must be denied.
