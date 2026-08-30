# `renderer/features/settings/`

The ⌨ Options popover.

Every app-wide option, the theme picker and the shortcut sheet. Options main
owns are mirrored into the renderer modules that need them
(`Pane.setSkipPermissions`, …) rather than read back over IPC — a per-keystroke
`getConfig()` is never the answer.

`settings.css` carries **both** halves — `app.css`'s and `chrome-clean.css`'s —
which is why it is linked *after* `chrome-clean.css` rather than before.

## Files

`settings.js`, `settings.css` · `settings.html`

The markup was in `renderer/index.html`. It is here now, as
`<template data-mount="…">` sections that `lib/fragments.js` puts into the
shell before any module runs.

## Public interface

`init(ctx)`, `applyConfig(cfg)`, `applyTheme(name, persist)`, `kbdPop`,
`kbdShortcutsPop`, `kbdHelpBtn`, `themeDots`, and the live-binding values
`maxAgents`, `autoUsageLimit`, `taskSummaries`, `desktopNotifs`, `notifSpeech`,
`notifSound`. An ES module imported by `app.js`.

## How to test

The gear, or `Ctrl+K → Options`. Flip an option, restart the app, and check
it stuck. Every theme must clear WCAG AA on text against `--bg`.
