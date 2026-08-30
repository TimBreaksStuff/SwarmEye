# `renderer/features/notifications/`

The bell: what your agents did.

Every finished turn, permission prompt and failure, drawn as a timeline —
day headings, a dot in the kind's colour at each event and a thread down to
the next — as a popover and a dockable panel sharing one row builder, so a row
can only look one way. The panel is the same timeline widened: model,
permission mode, runtime and absolute time under each event, and the quoted
prompt wrapping instead of clipping. Also owns the OS notification and the
spoken "done" when those options are on.

## Files

`notifications.js`, `notifications.css` · `notifications.html`

The markup was in `renderer/index.html`. It is here now, as
`<template data-mount="…">` sections that `lib/fragments.js` puts into the
shell before any module runs.

## Public interface

`init(ctx)`, `pushNotif`, `renderNotifs`, `closeNotifPop`, `notifyOS`,
`speakDone`, `notifPopEl`, `notifPanelEl`, `notifHandlers`, `notifMuted`. An ES
module imported by `app.js`.

## How to test

Start an agent and let a turn finish. The bell count should rise, the row
should jump to that pane, and double-clicking the bell should mute it.
