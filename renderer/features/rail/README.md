# `renderer/features/rail/`

The left rail and the top bar.

One area, three files: the workspace tiles and gauges (`topbar.js`), the
fold-out agent rows under a tile (`wsagents.js`), and the drag handles that
size and collapse it (`railgrip.js`).

`Topbar.renderWorkspaces` runs on the same beat as `syncChrome()` — several
times a second with a busy swarm — so everything on that path reconciles nodes
in place or guards on a signature. Never `innerHTML = ''` unconditionally here:
a wiped node also orphans the tooltip of whatever the cursor is resting on,
because Chromium fires no `mouseout` for a removed element.

## Files

`railgrip.js`, `topbar.js`, `wsagents.js`, `rail.css`

## Public interface

`Topbar.renderWorkspaces`, `.renderNotifications`, `.renderNotifPanel`,
`.updateAgentCap`, `.renderUsage`, `.setUsageSection`, `.fmtIn`;
`WsAgents.reset`, `.attach`, `.sync(wsId, panes, onOpen, onClose)`; `railgrip.js` exposes nothing. Classic
scripts.

## How to test

`npm start` with several workspaces. Drag a tile to reorder, right-click for
Rename/Remove, drag the grip to resize and collapse, and watch the gauges while
agents run. Right-click an agent row inside a tile's fold-out list for its
"Close agent" menu — one click there kills that agent.
