# ARCHITECTURE.md

Module-by-module rationale, moved out of `CLAUDE.md` to keep per-turn agent context small. Read only section for module you touching. Quick-lookup tables (`Where to look`, `Inside features/pane/`, `Files to leave alone`) at bottom — start there when you not know which file own a change.

Every module folder also carry own `README.md` — purpose, public interface, how to test. That the file to read when you working *inside* one folder; this one for how folders relate.

## Main process (`main/`)

One module per concern, wired in `main/main.js`, which own window lifecycle and the monitors — **not** `ipcMain`, which live in `main/ipc/` (task scheduler = `features/scheduler/scheduler.js` in renderer — main only store tasks):

- `ipc/` — whole `ipcMain` surface, one file per domain (`config`, `openrouter`, `workspaces`, `tasks`, `sessions`, `skills`, `system`), wired by `ipc/index.js`. Was one 900-line `registerIpc()` in `main.js`; channels share nothing but the window, so split cost nothing. `index.js` take one `deps` object carrying monitors, pty manager and two send helpers. **`win` a getter on it, never captured** — macOS rebuild window after last one close, and a held reference point at the dead one.

- `sessions.js` — PTY/tmux manager. Agents run in dedicated tmux server (`tmux -f ~/.config/swarmeye/tmux.conf -L swarmeye`), so node-pty host only *attach client*: kill app → detach, agent survive. Session metadata persisted, reconciled against `tmux list-sessions` at boot. On Windows that server only survive while a *Windows-side* WSL client exist — last one exit, WSL power distro down and take every agent with it — so `_ensureKeeper` leave one detached `wsl.exe` behind (`flock` keep it single, it exit itself once no session left). No tmux → spawn `claude` direct (sessions then die with app). `claudeBase()` build every launch command. **Everything appended to system prompt share one `--append-system-prompt`** — `claude` keep only last such flag, second one silently drop first — and every string in it must stay free of quotes, `$`, backticks, backslashes, because interpolated into single-quoted tmux command.
- `config.js` — single persistence layer. `config.json` loaded into module-level cache, written atomically via tmp+rename. New fields go in `DEFAULTS`, backfilled on load. Much of it main's own bookkeeping (per-session usage totals, tmux metadata, OpenRouter key), so `config:get` hand renderer explicit projection of fields it read — no widen back to whole file. **Big or rarely-changing data live in own files**, because every save rewrite whole file synchronously on main thread: `archive.json`, `skills.json`, `openrouter-catalog.json` (all three migrate themselves out of `config.json` on first read), plus `usage.json`, `usage-snapshot.json`, `runstate.json` and `task-logs/<taskId>.log` (`tasklogs.js`). Put nothing in `config.json` that grow with use.
- `template.js` — the standard `CLAUDE.md`. Config hold **path only**, never the text: template is file user edit in own editor, and copy in `config.json` go stale same moment. `apply(dir)` run once, from `workspace:add`, and never overwrite existing `CLAUDE.md` — that file the repo's from then on. Every failure a quiet skip: it a side effect of adding workspace and must not be able to fail the add.
- `hooks.js` — write `hook-settings.json` that spawned agents run with (`claude --settings ...`); those hooks `cat` their JSON into `hook-state/<sessionId>.json`, which main fs-watch and relay. **Source of truth for agent state** (busy / waiting / done / current tool); sessions reattached from older version and hook failures fall back to output-timing heuristics. Same watcher tail each transcript at every turn boundary for tokens, cost, closing summary. `claudeCmd()` wrap launch in `SWARMEYE_SESSION` / `SWARMEYE_STATE_DIR` env every harness report through (`{settings:false}` for foreign CLIs, which reject claude flags). Anything derived from hook stream belong here: `UsageUpdate` and `ModelUpdate` ride existing `session:state` channel as bookkeeping events renderer's one handler ignore for state purposes — that why none need new IPC. Hook settings written **at launch**, so widen payload only reach agents started after.
- `providers.js` — OpenRouter. One API key unlock whole catalog; model value carry harness, and `slugOf`/`cleanSlugOf`/`opencodeSlugOf`/`piSlugOf` are only decoders: bare tier names (`opus`) mean Claude, `or:<slug>` catalog model *inside* Claude Code, `oc:<slug>` our own clean agent, `opencode:<slug>` and `pi:<slug>` those CLIs. Key live in config.json, catalog in own `openrouter-catalog.json`; key never cross IPC (`status()` report counts). Every slug and key charset-checked — land in single-quoted tmux command.
- `roles.js` — role presets (short system prompt + model tier that job worth). Four, fixed: the + Agent menu, coordinator and orchestrator all pick from this table, nothing write to it. Prompts must stay free of quotes, `$`, backticks, backslashes — they reach shell command line verbatim.
- `usage.js` — poll Claude OAuth usage API (creds read read-only: macOS Keychain, fall back to `~/.claude/.credentials.json`; on Windows read out of WSL where that copy of Claude Code live), back off on rate limits.
- `worktree.js` — one git worktree per agent, behind the "Isolate agents in git worktrees" option. Whole point: agents in one workspace share one checkout, so orchestrator brief must *tell* its lead never to give two workers the same file — with a tree each, rule structural instead of advisory. Registry lives in own config key (`agentWorktrees`), **not in session metadata**: metadata dropped moment agent exits, and pane that exited by itself still own tree that must be landed when user finally close it. Same reason boot reconcile work — crash leave entries to answer for. Tree cut in `ipc/sessions.js` *before* `spawn()` (it the cwd), so branch carry name minted there too. Retire on pane close: commit leftovers, merge back, remove tree — but merge never forced and conflict never resolved, `merge --abort` then keep branch and say its name. Only what repo already ignores is carried in (`node_modules` symlink, ignored `.env*`), and the symlink must be excluded from the commit — `node_modules/` ignore rule match a directory, not a symlink, so `add -A` would commit it into user's history.
- `platform.js` — OS shim (see above). Everything reaching shell go through it.
- `coordinator.js` — one headless `claude -p --model haiku` call that split multi-part request into task-board tasks with role presets. Not agent: pane would need channel to hand plan back, while everything downstream of plan (scheduler, agent cap, usage gate, prompt injection) already exist on board. Request is arbitrary user text, so it never reach command line — go to temp file, `claude` read as stdin. It the one caller needing explicit `bash -lc`: `claude` install to `~/.local/bin`, which only login shell put on `PATH`, and `exec` give one on macOS but not Windows. Agents never hit this — tmux start their shell as login shell itself.
- `attach.js` (`@`-picker file list via `git ls-files`, and clipboard images — both reach agent as **path** in prompt text, which on Windows must be WSL spelling), `preview.js` (probe ports 3000/5173/… for dev server, else start one in own tmux session on same `TMUX` server as agents), `git.js` (branch/dirty per workspace + branch list/checkout behind pane chip), `health.js` (WSL reachability, Windows only), `update.js` (GitHub release check), `skills.js` (clone/symlink/update GitHub skills, plus discovery of skills already on disk), `speech.js` (**both** voice directions — faster-whisper STT in, Piper TTS out, each provisioned by own `scripts/setup-*.sh` into `~/.local/share/swarmeye/`, sharing one `_runSetup`), `names.js` (agent name pool).

## Foreign harnesses (`agent/`)

Pane not have to be Claude Code. `clean.js` our own dependency-free CLI talking OpenAI wire format straight to openrouter.ai; `opencode-plugin.js` and `pi-extension.ts` are adapters loaded into those third-party CLIs. All three earn normal pane by writing two artifacts `hooks.js` already watch — `hook-state/<id>.json` and Claude-format transcript JSONL — so **`hooks.js` need no changes for new harness**. They duplicate those ~40-line writers on purpose, no shared module (each loaded by foreign runtime with own resolver); keep three in sync by hand. Contract written up in `agent/README.md`; the plan file both were built from is retired.

## Renderer (`renderer/`)

No build step, **mid-migration to ES modules**. Two kinds of file live here at once:

Only four things live at `renderer/` top level: `app.js`, `index.html`, `styles/` and `lib/`. **Everything else is `features/<area>/`** — one folder per UI area, holding that area's JS, its CSS and its `README.md`. Markup stay in `index.html`.

`lib/` the five shared helpers no single area own — `dom.js`, `tooltip.js`, `confirm.js`, `icons.js`, `resizable.js`. They load first, as classic scripts.

Two kinds of file live in `features/` at once:

- **Classic scripts** — original arrangement, still most of it. Load order fixed by `<script>` tags in `index.html`; each file expose one object. Most assign to `window` (`Pane`, `GridController`, `Launcher`, `Topbar`, `Board`, `Sounds`, `Speech`, `Preview`, `Messenger`, `Palette`, `Confirm`, `Resizable`, `OpenRouterUI`, `Scope`, `WsAgents`); `Skills`, `Coordinator`, `Icons` are plain top-level consts app.js read direct, while `lib/tooltip.js` and `features/rail/railgrip.js` expose nothing — they just install listeners. xterm.js and addons load straight from `node_modules` as UMD, hence `node_modules` paths in `index.html`.
- **ES modules** — real modules `app.js` import; they get **no `<script>` tag of own**. `features/settings/`, `notifications/`, `scheduler/`, `orchestrator/`, `update/`, `addagent/`, `usage/` so far.

Migration possible one area at a time because **module scripts deferred**: every classic script run before any module do, so converted module still read `window.Pane`. Reverse not hold — classic script cannot see module exports — that why `app.js` converted first and why area move *out* of it, never other way. **Helper in `app.js` that classic script call by name must be republished on `window`** (`modHeld`, `toast` are): module scope silently take them global, and only symptom is `ReferenceError` in renderer console at moment key pressed — both broke in 1.60.7x split, found in 1.60.87 only by reading live app debug log. (ES modules over `file://` work in Electron; `win.loadFile` fine, no custom protocol needed. Verified on Electron 38.)

Area stylesheet slot depend on which half it took — see **Styling** below; sheet carrying only `app.css`'s half go *before* `chrome-clean.css`, sheet that took chrome-clean's half too go after. Move only selectors exclusively that area's: shared class it happen to use (`.kbd-title`, also styled by notif-pop and board head) stay in sheet it came from. Watch for rule *later* in `chrome-clean.css` that override one you moving — move flip cascade. `settings.css` hit exactly that with flat-popover treatment, resolved by carrying effective values itself and coming off shared list.

`features/pane/` the exception: **six classic scripts, not modules.** `Pane` constructed by `app.js` and read for statics by four more classic scripts (`features/board/board.js`, `features/launcher/launcher.js`, `features/coordinator/coordinator.js`, `features/openrouter/openrouter.js`), and classic script cannot import from module, so converting mean converting all five in one commit. Instead it stay classic, split across script scope:

- `pane-theme.js` — xterm palettes, light-theme contrast pass, font size/weight state.
- `pane-const.js` — ⌨ Options mirrors, mode/model/effort tables other scripts read, tool sets, pure formatters.
- `pane.js` — the class: constructor that build header DOM, buffer scans, terminal lifecycle, statics, `window.Pane`.
- `pane-status.js`, `pane-usage.js`, `pane-git.js` — 31 methods re-attached with `Object.assign(Pane.prototype, {…})`.

Load order in `index.html` carry all of it: vocabulary files must come before class that close over their `const`s, and three mixins must follow it because they reach `Pane.prototype`. Top-level `let`s shared across classic scripts — that why `Pane.setDefaultFontSize` in `pane.js` can still reassign `activeFontSize` in `pane-theme.js`. **Class body separate methods by nothing, object literal need commas** — the one real hazard when moving method group; check count of `^  }$` terminators equal count of method headers before and after.

Three full-screen views swap into one slot: agent grid, Task Board (`features/board/board.js`), Skills — each toggle explicitly hide the other two, so a fourth mean touch all of them. **Prefer popover over fourth view**: `features/message/`, `features/palette/`, `features/coordinator/` all float over whatever view up, build own root (so `index.html` gain only script tag), cost none of that wiring. New popover do need line in `ESCAPABLE` in `app.js` — ordered list, outermost first, first open one win — and get drag-to-resize from `lib/resizable.js` (CSS `resize: both` do resizing; module only remember size and centre box). Anchor it with `placePop` from `lib/dom.js` and close it with `dismissPop`, never hand-rolled `getBoundingClientRect` maths plus a document listener: ten popovers had own copy before the sweep. `placePop` measure the box, so unhide it *first*; `dismissPop` hand back its teardown, which your own `close()` must call.

`features/preview/preview.js` is `<webview>` dock beside grid, restricted to localhost in renderer *and* re-enforced in `main.js` at attach and at navigate. It expose `onAgentDone(workspaceId)`, called from `app.js`'s `done` status branch: debounced self-reload so agent work show without hand-hitting `⟳`. `lib/confirm.js` own app-wide click-twice-to-confirm state for every destructive control — screens rebuild rows on unrelated events and would otherwise wipe armed button mid-confirm. Reuse it, no second confirm. `lib/icons.js` hold the one 24-box, 1.6-weight stroke set views build buttons from; new chrome use it, not emoji glyph.

**Where logic go.** Self-contained module (`features/palette/`, `features/openrouter/`) own its matching, rendering, keys, and take app state through `init`/`open` argument rather than reach into `state` itself — `app.js` only file that know both state and what entry should *do*, and also file most likely contended. Renderer-only conveniences costing no IPC stay renderer-only (localStorage, not a config field).

**Render cost.** `syncChrome()` fire on every agent status flip — several a second with busy swarm — and everything it call run on that beat. Anything on that path reconcile nodes in place or guard on signature; never rebuild list with `innerHTML = ''` unconditionally. (Wiped node also orphan tooltip of whatever cursor rest on — Chromium fire no mouseout for removed element.)

**IPC** — whole surface enumerated in `preload.js` (`window.swarm`). Request/response via `invoke`/`ipcMain.handle`; push events (`session:data`, `session:state`, `usage:update`, `git:update`, …) go other way via `webContents.send` and `onX` subscribers. Crossing boundary mean touch the right `main/ipc/<domain>.js` + `preload.js` — so check first whether existing channel already carry what you need (see `hooks.js` above: `UsageUpdate` needed no new IPC at all). Handlers resolve paths **server-side from an id** — `diff` take workspace/session id, `skills` take skill id — so renderer never name path and nothing to escape out of. Options main own are mirrored into renderer modules that need them (`Pane.setShowUsagePanel`, `Pane.setSkipPermissions`, …), not read back over IPC — per-keystroke or per-buffer-scan `getConfig()` never the answer.

## Styling

Loaded in this order, and order is whole design:

1. `styles/tokens.css` — design tokens and three colour themes (Dark, Orange, Light).
2. `styles/app.css` — now only chassis: shell, health banner, reattach pill. 121 lines, down from 4497 (update pill and global search moved to own area sheets).
3. `features/<area>/<area>.css` — one sheet per area (rail, pane, preview, message, board, skills), cut out of `app.css`, linked in `app.css`'s own order.
4. `styles/chrome-clean.css` — current design language: flat opaque `--surface`, no glass or blur, 6/8/10/12px radii, one chip shape in three tones, `:focus-visible` on everything. Hold only what genuinely shared — `.pill`, chips, icon sizing, focus rings. Its 229 per-area rules moved to their area sheet in the ponytail sweep, appended at the sheet's end so they still land where chrome-clean sat; what stayed either span two areas or lose a same-specificity race against a shared rule that follow it.
5. `features/settings/settings.css`, `features/notifications/notifications.css`, `features/orchestrator/orchestrator.css` — areas that took **both** halves, so self-contained and belong after chrome-clean, not before.
6. `styles/native-mac.css` — "Native Apple style", every rule scoped to `:root[data-native="on"]`, so with the option off the sheet cost nothing. Last, because its whole job is overriding everything above, tokens included.

**Position in that list load-bearing.** `chrome-clean.css` exist to override `app.css`, so area sheet carrying only app.css's half must load **before** it (slot 3) or every one of those overrides flip at once. Sheet may move to slot 5 only if it took chrome-clean's half too — then watch for *shared* rule it relied on (`#kbd-pop` and `#notif-pop` both sat on chrome-clean "flat popovers" list, had to carry those two declarations themselves).

Bulk CSS moves verified, not reasoned about: drive app over CDP, record every element computed style across all views and both themes, move rules, record again, require diff empty. Run snapshot **twice on identical code** first — usage bars and toggle states drift between runs, that noise floor tell you which differences real. That how 4048-line split shown computed-identical across 22,532 element records, and the ponytail sweep's 229-rule move across 17,685.

So: **new component styled in its area's `features/<area>/*.css`**; `chrome-clean.css` for what genuinely shared across areas; `app.css` only for chassis. New colours belong in tokens, not inline. Anything text-carrying must clear WCAG AA against `--bg` on Light theme too — whole ramp re-picked in 1.35.1 after it failed.

Anything reaching shell command line (terminal dimensions, model names and slugs, paths, branch names, agent names, session ids) re-validated in `main/` even when renderer already checked — see `toDim` and model regex in `sessions.js`, `SLUG_RE` in `providers.js`.

## Verifying a change unattended

Clicking around is the normal check. When that not enough, launch with `--remote-debugging-port=<port>` and drive renderer over CDP (Windows node 24 have native `WebSocket`, so ~50-line `Runtime.evaluate` / `Page.captureScreenshot` script need no dependency). Two things clicking cannot buy:

- **Synthetic input through real code path** — drop hand-written payload into `hook-state/<sessionId>.json`, fire whole hook pipeline without spending agent turn.
- **The launch command that actually resulted** — `ps -eo args | grep swarmeye_<session>`, only honest proof flag built right.

CDP bind *Windows* loopback, so WSL `curl` to it fail — driver must run under `cmd.exe`. Test negative cases too. Kill only own tmux sessions and PIDs after. Re-connect rather than trust stale CDP target that keep answering after reload.

## Where to look

Renderer split by area so a change costs one or two files. **Find your row, open those, stop.** Don't read neighbour areas or `renderer/styles/`.

Almost every row is now one folder — open it and read its `README.md` first.

| Change… | Open |
|---|---|
| ⌨ Options | `features/settings/` |
| notifications | `features/notifications/` |
| which task starts / launch sequence | `features/scheduler/` |
| task board | `features/board/` |
| left rail / top bar / gauges / grips | `features/rail/` |
| Skills | `features/skills/` |
| preview dock | `features/preview/` |
| messenger | `features/message/` |
| command palette | `features/palette/` |
| the + Agent menu | `features/addagent/` |
| coordinator / orchestrator | `features/coordinator/`, `features/orchestrator/` |
| OpenRouter pickers | `features/openrouter/` |
| the launch card | `features/launcher/` |
| agent scoping | `features/scope/` |
| grid layout, splits, maximise | `features/grid/` |
| the updater | `features/update/` |
| agent worktrees | `main/worktree.js` (renderer half is one Options checkbox) |
| quota warnings | `features/usage/` |
| voice / sounds | `features/speech/`, `features/sounds/` |
| an agent pane | `features/pane/*` below |
| a shared helper (`elt`, `placePop`, icons, confirm) | `renderer/lib/` |
| one IPC domain | `main/ipc/<domain>.js` |



**`features/pane/`** — pick the concern:

| Concern | File |
|---|---|
| status, attention, prompts, subagents, hooks | `pane-status.js` |
| cost & context, model/effort chips | `pane-usage.js` |
| git chip, branch menu, model picker | `pane-git.js` |
| palettes, light-theme contrast, font | `pane-theme.js` |
| Options mirrors, mode/model/effort tables | `pane-const.js` |
| class: constructor, header DOM, terminal, statics | `pane.js` |

`pane-status` / `usage` / `git` re-attach with `Object.assign(Pane.prototype, {…})` — move a method as cut-and-paste (watch object-literal commas).

**Leave alone** unless the table sent you there:

- `renderer/app.js` — orchestrator. Touch only for cross-cutting wiring.
- `renderer/index.html` — all markup. `grep` for the id, don't read the whole file.
- `renderer/styles/chrome-clean.css` — shared design language only (`.pill`, chips, icon sizing, focus rings). Per-area styling does not go here.
- `renderer/lib/dom.js` — `elt(tag, class, text)`, `placePop`/`dismissPop` (anchor a box under a button, close it on the press outside), `dragWidth` (drag one edge, remember the width). Globals. Never name a local `elt`.
- `renderer/styles/app.css` — chassis. `tokens.css` for colours.
- `main/main.js` — window lifecycle and the monitors, not handlers.
- `preload.js` — only for new IPC.

"Read the whole target file first" applies to the file you **edit**, not its neighbours.

## Saving tokens

Biggest lever first:

1. **Match model to job.** Haiku for mechanical / short-lived; Opus for hard. `syncRightsize` offers `→ Haiku` on a long read-only Opus streak.
2. **Targeted reads.** Slice + `grep`. Pipe noisy commands through `head`/`tail`.
3. **Skills sparingly.** *Active* skills inject into every new agent, every turn. Enabled ≠ active (`main/skills.js`).
4. **`caveman`** cuts assistant output ~65%.
5. **Close idle agents.** Context lives for the session.

This applies to the app too. Anything injected into an agent is paid every turn of every agent — inject a *pointer*, not a payload. Price launch-prompt additions at "every agent, every turn".
