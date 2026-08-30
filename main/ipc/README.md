# `main/ipc/`

Every `ipcMain` channel, one file per domain. It was a single 900-line
`registerIpc()` in `main.js`; the channels share nothing but the window, so the
split costs nothing and a change to one domain opens one file.

## Public interface

`require('./ipc')` returns `registerIpc(deps)`. `index.js` calls each domain
registrar with the same `deps`:

```js
registerIpc({
  get win() { return win; },      // a getter: macOS rebuilds the window
  ptys, usage, ptysReady, hooks, git, health, updates, skills, speech,
  sendToWin, debugLog, setVisibleSessions,
})
```

`index.js` also supplies `projectArchive` — archived tasks always cross IPC
without their transcripts. Live tasks never carry one either: transcripts are
stored per task by `main/tasklogs.js` and fetched one id at a time over
`task:log`.

| File | Channels |
|---|---|
| `config.js` | `config:*`, `template:*`, `app:relaunch`, `app:version` |
| `openrouter.js` | `openrouter:*` |
| `workspaces.js` | `workspace:*`, `areas:read`, `preview:*`, `git:*` |
| `tasks.js` | `task:*`, `coordinator:split`, `orchestrator:*` |
| `sessions.js` | `session:*`, `sessions:visible`, `roles:list`, `models:list` |
| `skills.js` | `skills:*` |
| `system.js` | `usage:refresh`, `update:*`, `speech:*`, `tts:*`, `clipboard:*`, `notify`, `open-external` |

## Rules

- **Handlers resolve paths server-side from an id.** The renderer never names a
  path, so there is nothing to escape out of.
- **Check for an existing channel before adding one.** Crossing the boundary
  means touching `preload.js` too; several payloads ride channels that already
  exist (`hooks.js`'s usage and model events go down `session:state`).
- `win` is read as `deps.win` at call time, never captured.

## How to test

`npm start`, then exercise the domain you changed. The whole surface is
enumerated in `preload.js` — if a channel is missing there, the renderer cannot
reach it.
