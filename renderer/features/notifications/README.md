# `renderer/features/notifications/`

The bell: what your agents did.

Every finished turn, permission prompt and failure, as a popover and a
dockable panel sharing one row builder — a row can only look one way. Also owns
the OS notification and the spoken "done" when those options are on.

## Files

`notifications.js`, `notifications.css`

## Public interface

`init(ctx)`, `pushNotif`, `renderNotifs`, `closeNotifPop`, `notifyOS`,
`speakDone`, `notifPopEl`, `notifPanelEl`, `notifHandlers`, `notifMuted`. An ES
module imported by `app.js`.

## How to test

Start an agent and let a turn finish. The bell count should rise, the row
should jump to that pane, and double-clicking the bell should mute it.
