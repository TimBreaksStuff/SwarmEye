# `renderer/features/launcher/`

The empty-workspace launch card.

What a workspace with no agents shows: how many to start, on which provider
and model, at what effort, in which scope. Its picks ride the one-launch
`launch` channel rather than changing any default.

## Files

`launcher.js` · `launcher.css`

The sheet used to be the `EMPTY WORKSPACE: LAUNCH CARD` block at the end of
`styles/chrome-clean.css`. It took chrome-clean's half as well as `app.css`'s,
so it loads at slot 5 — immediately after chrome-clean.css, which is where
those rules sat and where they still have to win from.

## Public interface

`Launcher.init(host, headline, hint, onLaunch)` and `Launcher.getSettings()`
→ `{ model, effort, focus, startMode, scope }`. An ES module.

## How to test

`npm start`, select a workspace with no agents. Change the pickers, press
the launch button, and check the resulting command with
`ps -eo args | grep swarmeye_`.
