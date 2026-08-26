# `renderer/features/launcher/`

The empty-workspace launch card.

What a workspace with no agents shows: how many to start, on which provider
and model, at what effort, in which scope. Its picks ride the one-launch
`launch` channel rather than changing any default.

## Files

`launcher.js`

## Public interface

`Launcher.init(host, headline, hint, onLaunch)` and `Launcher.getSettings()`
→ `{ model, effort, focus, startMode, scope }`. A classic script.

## How to test

`npm start`, select a workspace with no agents. Change the pickers, press
the launch button, and check the resulting command with
`ps -eo args | grep swarmeye_`.
