# SwarmEye — full documentation

Everything SwarmEye does, in detail. For **installation and setup**, see the [main README](../README.md) — it's kept there so there's only ever one copy of the install steps.

---

## Contents

- [Key features](#key-features)
  - [Command palette](#command-palette-ctrlk)
  - [Cost & context panel](#cost--context-panel) · [Messages between agents](#messages-between-agents) · [Preview dock](#preview-dock)
- [Isolated agents](#isolated-agents)
- [Scoping an agent to a folder](#scoping-an-agent-to-a-folder)
- [The task board](#the-task-board)
- [Orchestrator — a lead agent and its workers](#orchestrator--a-lead-agent-and-its-workers)
- [Skills](#skills)
- [OpenRouter models](#openrouter-models)
- [Voice dictation](#voice-dictation)
- [Spoken notifications](#spoken-notifications)
- [Options reference](#options-reference)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Where things are stored](#where-things-are-stored)
- [Troubleshooting](#troubleshooting)
- [Architecture notes](#architecture-notes)

---

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](images/swarmeye.png)

---

## Key features

### Workspaces and the icon rail

A vertical rail runs down the left side: the usage widget at the top, then a `WORKSPACES` group — each workspace as a tile, plus a `+` tile that opens a folder picker — and pinned to the bottom a `VIEWS` group holding `Task Board` and `Skills`.

The selected tile decides which folder new agents start in. A tile whose agents need attention turns amber with a pulsing dot; expanded, the row also carries its agent count. Hover a tile for a flyout with the full name, path and agent count — double-click the name there to rename, `📌` to pin it, or `✕` to remove it (running agents are killed after a confirm click); the folder on disk is never touched. Drag tiles to reorder them.

**Pinning** floats a workspace to the top of the rail, marked with a pin beside its name (and lit in its hover flyout), and `Ctrl+Tab` cycles in the order you see rather than the stored one. Inside each group (pinned, then the rest) the drag order is kept, so unpinning drops a workspace back exactly where it was instead of at the end.

The rail comes **Expanded** (full workspace names and tile labels) or **Collapsed** (57px icons only, hover to preview the wider layout as a floating overlay). Both states use the same flat row treatment, and the icons sit in the same column either way, so opening the rail doesn't shift them sideways. Collapsed, a workspace tile is its identity colour and nothing else — a centred bar of it; the initial that used to sit beside it told you little (two folders starting with the same letter looked identical) and the name is one hover away.

### Agent panes

`+ Coding Agent` opens a small picker and spawns a terminal pane running `claude` in the selected workspace. Each agent gets a random name (Hal Nine Thousand, Artoo Deetoo, Roomba Prime, …) — click to rename. The pool is spelled the way each original is *pronounced* rather than written, because these names are also read out by spoken notifications: `C-3PO` is "See Threepio" in the films' own scripts, `MU-TH-UR` is just "Mother", and a hyphenated model number is what turns an announcement to mush. All agents share one grid regardless of workspace; hover a pane's git chip (or check the rail) to see where it lives.

**Role presets** — the picker's first entry, `Claude`, is a plain agent on your **Default model**. Under it sit four roles:

| Role | Model | What its system prompt says |
|---|---|---|
| **Builder** | Sonnet | Implement exactly what was asked, smallest working diff, this codebase's patterns, then say what changed. |
| **Reviewer** | Opus | Report what's wrong — correctness, then security, then clarity. Don't edit unless asked. One line per finding. |
| **Scout** | Haiku | Locate things and report where they are: paths with line numbers, call sites. Read only, keep it short. |
| **Planner** | Opus | Turn the request into an ordered plan: files touched, steps, risks. Read only, don't write the code. |

A role is launched as `--append-system-prompt`, so it costs no turn and never lands in the conversation as a message; its model tier is a default that the role picks *instead of* the Options default. The pane header wears the role as a chip, `→`/`↓` splits inherit it, and a restart re-applies it (the system prompt belongs to the process, not to the resumed conversation). `Ctrl+N` always spawns a plain agent.

**Those four are a starting point, not the table.** `+ Agent → Edit roles…` opens the editor: reword a preset for your codebase, change the tier it launches on, add your own, or delete one. The list is stored in `config.json` and seeded from the four above the first time it is read, so an existing install keeps exactly what it had.

- A role needs a name and a prompt; one missing either is dropped on save. Delete takes two clicks, and saving an empty list restores the four built-ins rather than leaving the app with no roles.
- The editor's bottom-right corner drags, so a long prompt gets more than two cards' worth of window; the size is kept for next time.
- The name is only a label — the key a saved task refers to is derived once, when the role is created, and does not change when you rename it.
- **Quotes, `$`, backticks and backslashes are stripped from a prompt on save**, and the editor counts them for you as you type. The prompt is passed to the agent inside a single-quoted shell command; a stray apostrophe there would break the launch rather than the sentence.
- Roles are read at launch, so editing one changes the agents you start next, not the ones already running.

Each pane header carries:

- **Status dot + live state** — see below.
- **Mode dropdown** — `manual` (Claude asks before edits), `accept edits`, `plan`, `auto` (bypass permissions). Claude has no set-mode command for a running session, so SwarmEye reads the mode from Claude's own footer and taps `Shift+Tab` through the cycle until yours is active; it stays in sync if you switch modes by hand. `auto` requires the Options toggle below.
- **Model chip** — which model the agent is actually replying with (`Sonnet 5`, `Opus 4.8`, …), read from the session transcript after each turn. It starts out reading the tier the agent was *launched* on (`Opus`, or the model an OpenRouter agent was picked with) and sharpens to the exact version after the first turn; an agent launched on your account default has nothing to show until then. A `/model` switch you run yourself shows up instantly. **Click it to change model** — the Claude tiers and, with a key saved, the whole OpenRouter catalog, in one filterable list; see [Switching model inside an agent](#openrouter-models).
- **Git chip** — the folder's branch (`⎇ main`), amber with a dot when there are uncommitted changes. Refreshed every 15s; a folder that git can't answer for in time (an unreachable network share, a suspended drive) says so in the tooltip rather than claiming the tree is clean, and one slow workspace no longer holds up the others. The branch list is fetched at most once a minute per workspace, so repeated clicks don't queue up network round-trips. Click it and the popover opens with a **`git diff --stat` summary of the working tree** — staged and unstaged together, which is what "dirty" on the chip actually means — followed by a count of untracked files, which no diff reports. Under that is the branch list (local + remote, fetched fresh from the workspace's git remote): pick one to check it out, or `+ new branch…` to create one off the current HEAD; checkout errors (e.g. uncommitted changes in the way) show as a toast. The diff is read in parallel with the branch fetch, so it is up long before the network call finishes, and a long stat is elided in the middle with git's own "N files changed" line always kept. In an isolated workspace this chip reports the agent's *own* worktree branch rather than the workspace's.
- **Buttons** — mic (dictation) · `−`/`+` text size · `⛶` maximize · `→`/`↓` place a new agent beside/below (only with auto-organize off) · `✕` close (click twice while running). In-pane search has no button: it opens with `Ctrl+Shift+F`.
- **Quick-respond** — while a pane is waiting on a numbered permission prompt (Claude's `1. Yes` / `2. No` style), it grows `✓` approve and `✕` deny buttons right next to the status text — no need to click into the terminal. Shift-click `✓` prefers a "don't ask again" / "allow all" option over a plain yes, if the prompt offers one. The same two buttons show up on `waiting` entries in the notification bell and its docked panel. They appear only while a yes/no menu is genuinely on screen: an agent that is merely waiting for you to type something — the commonest kind of `waiting`, and the only kind there is in bypass-permissions mode — says so without offering buttons that have nothing to answer. If the prompt is answered elsewhere between the buttons being drawn and clicked, nothing is sent and a toast says so instead of guessing.
**Opening a workspace with no agents in it** shows the **launch card** over a honeycomb field instead of an empty grid. Pick a swarm size on the tiles — 1, 2, 4, 6, 8, 10, 12 — and `Launch N agents` opens that many panes at once. Tiles are keyboard-first: Tab into the group, arrows move between the ones still selectable, and `Ctrl`/`⌘` plus a size picks it outright.

Under the divider are the settings those agents start with, each **pre-filled from the matching ⚙ Options default**:

| Field | Options row | How it reaches the agent |
|---|---|---|
| **Provider** | — (derived from the model) | picks which list the Model field shows: **Claude**'s tiers, or the **OpenRouter** catalog. Greyed out until an OpenRouter key is saved; an OpenRouter default model opens the card on OpenRouter |
| **Harness** | — (the picker's own remembered toggle) | only shown while Provider is **OpenRouter**: which CLI runs the model — **clean**, **opencode** or **pi** (pi gates nothing, so it is always auto). Opens on whatever the `+ Agent` catalog picker last remembered, and a change here is a one-off like every other field, so it never rewrites that |
| **Model** | Default model | a `--model` launch flag, so it can't bleed into Claude's own saved default (an OpenRouter model rides the env prefix instead) |
| **Effort** | Default task effort | an `--effort` launch flag, same reasoning as model (`ultracode`/`auto`, which the flag can't express, are typed as `/effort` once the session is up). Greyed out on OpenRouter — those models ignore it |
| **Focus** | Default focus mode | `/focus` typed — but only when Claude's footer disagrees, since it's a toggle |
| **Permissions** | Default start mode | the same `Shift+Tab` cycling the Options default already used |

Changing a field is a **one-off for that launch**: ⚙ Options stays the one place a default is set, and the card goes back to those values the next time it appears. `default` in a field means "let Claude decide" and overrides the Options value with nothing at all — so a card set to `default` launches a bare `claude` even when Options says Opus.

Roles are still the `+ Agent` picker's job, and `+ Agent` / `Ctrl+N` are unchanged — they apply the model and the permission mode only, so a plain agent costs no extra startup turns. The panes are started one after another so the agent cap sees each of them, and only the first takes keyboard focus. Sizes that would break the cap are dimmed and skipped by the keyboard, the selection drops to the largest one still reachable, and with no slots left the button reads `Agent limit reached`. The cap counts every workspace, so three agents running elsewhere under a cap of ten leaves only 1, 2, 4 and 6 offered.

With no workspace selected the card is replaced by the old `No agents here_` hint, since there is nowhere to put the agents.

**The grid** auto-arranges (1 → 2×1 → 2×2 → 3×2 → 3×3 → 4×3) and refits terminals on resize. Turn **Auto-organize agent windows** off in Options to place agents yourself instead: the grid becomes a free canvas on which every pane owns a rectangle of its own. Each pane grows `→` and `↓` buttons that open the next agent beside or below it — out of the free space on that side, or out of half of that one pane when there is none — and handles on its right edge, its bottom edge and the corner between them. Dragging one of those resizes **that pane and nothing else**: no other pane moves, shrinks or slides down, and closing a pane leaves every pane that stays exactly where it was. Gaps and overlaps are yours to arrange, the arrangement scales with the window, and switching auto-organize back on tidies the lot into the even grid again. Panes are translucent glass; the focused pane wears a glowing accent border. With auto-organize on, drag the gaps between panes to resize rows and columns; the grid's own bottom and right edges are handles too, so a single row of panes side by side can be made shorter than the window, and a single column of them narrower (what an edge drags out is empty space, and dragging it back gives the size up again). Drag a pane by its header onto the **middle** of another to swap them, or onto one of its **edges** to move it to that side — dropping the lower of two stacked panes on the upper one's right edge puts them side by side, and the bar down the edge under the cursor shows where it will land. With auto-organize on the grid still computes its own shape, so a drop there only reorders the panes; with it off the dragged pane takes a rectangle beside the target and the target itself is left alone — your arrangement is remembered per workspace while the app runs. Terminals render on the GPU (WebGL, DOM fallback) and URLs in output are clickable. A pane in a workspace you haven't looked at for a minute **gives its GPU context back** — a browser page can only hold about sixteen at once, and every pane in every workspace holds one — and takes it again the moment you switch back. Nothing else changes: the agent, its output and its scrollback are untouched, since only the renderer is swapped for xterm's DOM one while nobody is watching. The GPU renderer keeps its rasterised characters in a texture atlas, and a long, colourful answer in a big pane can fill it — past which xterm merges pages and, on the version shipped here, loses some of the glyphs it merged, so a screen draws with (say) every bold `f` blank. SwarmEye rebuilds the atlas before that point, and again on every resize, so it corrects itself. That rebuild covers every open pane at once, because xterm hands all terminals sharing a font, size and theme the *same* atlas: a pane that did not ask for the clear would otherwise keep drawing from the coordinates its glyphs used to sit on, and paint shredded pieces of other characters. The buffer was never affected either way, only the GPU's cache of already-drawn characters.

**Drag & drop** any file onto a terminal to paste its path — converted to WSL form on Windows (`C:\Users\me\shot.png` → `/mnt/c/Users/me/shot.png`) so Claude can read it. Multiple files paste space-separated; paths with spaces are quoted.

### Copying an agent (`Ctrl+M`)

`Ctrl+N` starts a new agent from your Options defaults, as it always has. **`Ctrl+M`** gives you a copy of the agent you are working in instead: same model *and the CLI behind it* — Claude Code, clean, opencode or pi — same effort, same role, and the permission mode that pane is currently in. Setting up an opencode agent on the model you want and then filling the workspace with four more of it is four keypresses, with no trip through a picker and no chance of the Options default quietly launching something else.

The copy is the **focused pane** when it belongs to the selected workspace, otherwise the newest live agent there; with nothing running to copy it just does what `Ctrl+N` does. A bare harness (clean, opencode, pi) has no permission mode to carry, and the copy is a *launch* config, not the conversation: the new agent starts empty, like every other new agent.

### Live agent state (Claude Code hooks)

Every agent SwarmEye spawns reports its real state through Claude Code's hook system, rather than SwarmEye guessing from output timing:

- **Working** — the dot goes lime and the header reads `vibing...` next to a pulsing equalizer. Which tool is running and what it is on are in the activity popover, which the cost panel's tool trail opens.
- **Waiting on you** — a permission prompt or a question rings the whole pane frame in the theme's accent with a soft glow, shows the reason, and puts the age of the wait beside it (`waiting 4m`).
- **Done** — the pane shows `done` and flags attention.

If the window isn't focused, the taskbar flashes (dock bounces on macOS) and the event lands in the notification bell. Clicking into a pane clears its attention state. Hovering the agent name or its status dot shows the task prompt that started it.

### The attention queue (`Ctrl+.`)

With several agents running, the work is answering whoever is blocked — and finding them meant scanning every pane for a dot that had changed colour. Two things fix that:

- A pane blocked on you carries **how long it has been blocked** (`waiting <1m`, `waiting 4m`, `waiting 1h 12m`). A 40-second block and a 40-minute one no longer look identical.
- **`Ctrl+.`** focuses whoever has waited longest. Press it again for the next one down, and again to come back round. It crosses workspaces — the right workspace is selected on the way — and closes the board first, so the agent is actually on screen. With nobody waiting it says so and changes nothing.

The ring around a waiting pane replaces the old dot-only signal: a 10px dot is invisible in peripheral vision at eight panes, which is the only vision spare while reading another pane. It is the theme's accent plus a glow rather than a colour of its own, and it clears the moment you click into the pane.

### Subagents

Claude Code can spawn its own `Task` subagents, and in a terminal they are invisible: everything a subagent does scrolls past as one line of its parent's output. A pane running them now carries a `▸ n` chip counting the live ones, and the activity popover lists them by description with how long each took.

That is as fine-grained as it can be — a subagent runs in its own context and fires no hooks of its own, so "it is still running" is the most that is knowable from here. Several subagents run in parallel, and each is matched to its own completion rather than to whichever finished first.

### Asking an agent to stop editing

Picking **plan** in the pane header's mode dropdown stops an agent editing mid-run, without restarting it.

That is the same `Shift+Tab` cycle the dropdown drives for every other mode, verified against Claude's footer, and plan mode is a rule the agent cannot talk itself out of. What is different about `plan` is the fallback: when the switch cannot be made (a dialog is up, or the agent is mid-turn), SwarmEye sends the agent a plain-English request to stop editing instead, and the dropdown then reads **`plan (asked)`** in amber rather than claiming a mode it did not get — a request, not a rule; the agent can still write. Picking any other mode lifts it, in words if that is how it was asked — and so does moving the mode inside the agent with `Shift+Tab`, since Claude's footer is then the newer answer: reaching plan mode by hand turns the request into the rule it asked for, anything else takes it back.

This used to be a separate `read-only` chip beside the dropdown. Two controls set one state and could disagree — the dropdown re-reads Claude's footer every scan, the chip held what you asked for — so the fallback moved into the dropdown and the chip went.

Real per-tool enforcement (deny `Edit` outright for one agent) would have to be set at launch, since that is when an agent's settings are written.

### What an agent has been doing

Click the status text in any pane header — or the tool trail in the [cost & context panel](#cost--context-panel), under the model — for that agent's activity: every tool call it has made this session, newest first, with what the call was on, how long it took, and red if it failed. Under it, two lists — the files it has **read** and the files it has **written**.

- Drag the popover's bottom-right corner to size it — a long `cd … && grep …` row needs the width, a busy agent the height. The size is remembered, and clamped back inside the window if you later make the window smaller. The same grip is on the coordinator; each remembers its own size.
- Calls come from the same hook stream everything else reads, now including `PostToolUse`, which is what gives a finished call its duration and its pass/fail.
- A call that never reported back — a denied permission prompt, an interrupt — is retired as `not run` when the agent's next call or next turn starts, rather than reading as "running" forever.
- The hook state file holds one event at a time, so a burst of very fast calls can lose a row. The list says so, and the terminal is always the record.
- Only tools that genuinely name a file feed the read/written lists (`Read`, `NotebookRead`; `Edit`, `Write`, `MultiEdit`, `NotebookEdit`). A Grep pattern is not a path.

Agents that were already running when you updated report no `PostToolUse` until they are restarted — the hook settings an agent runs with are written at launch.

Agents that were already running when you updated to 1.40.0 report no paths until they're restarted — the hook settings an agent runs with are written at launch.

### Command palette (`Ctrl+K`)

With ten panes across five workspaces, the rail plus `Tab` cycling is the bottleneck. `Ctrl+K` opens one box that reaches everything:

- **Agents** — jump to one by name; it switches workspace and swaps back to the grid on the way, so it works from any view.
- **Workspaces** — select one. **New agent in \<workspace\>** spawns there without selecting it first.
- **Tasks** still open, and **installed skills** — both open the screen that owns them.
- **Views** — the grid, Task Board, Skills.
- **Verbs** — Message agents, Search across all agents, Options & shortcuts.
- **Acting on an agent** — **Restart \<name\>** and **Close \<name\>** per live agent, plus **Close N idle agents** in one row when any are idle. The palette entry *is* the deliberate act, so it fires straight away.
- **Running a task** — **Run now · \<task\>** starts any queued task without finding its card.
- **Themes** — one row per theme, so switching doesn't mean opening Options.

### Speaking to the app

The mic in the top bar's action cluster is dictation for SwarmEye itself rather than for one agent: it opens the command palette and fills its box as you speak, so speech reaches every verb the palette already has. Hold the button, say *"task board"*, release, then `Enter`.

It is **push-to-talk** — the mic is open only while the button is held, and releasing it anywhere on screen closes it. A mic for the whole app is not one to leave running: a click-to-toggle button forgotten in the on state listens to the room.

Nothing is run for you — the top match is only selected, since a mishearing would otherwise spawn or close an agent. It needs the same locally-installed dictation engine the pane mics use, and the button is hidden when that isn't available.

Matching is fuzzy, and scored the way people type: hits at the start of a word and runs of adjacent characters count for more, so initials work (`tb` → Task Board) and `ski` puts Skills above a workspace that merely contains those letters.

The list is rebuilt every time it opens, so an agent you just closed or a task that just finished is never offered. `↑`/`↓` to move, `Enter` to run, `Esc` to close — and `Esc` reaches it before anything underneath, since it opens over whatever view you were on.

### Model right-sizing

Matching the model to the job is the biggest cost lever there is — cost per token differs by an order of magnitude across tiers — and until now SwarmEye only documented it. When a pane running **Opus** makes **12 read-only tool calls in a row** (`Read`, `Grep`, `Glob`, `NotebookRead`, `WebFetch`, `WebSearch`), its header grows a `→ Haiku` button.

- **Two clicks**, the same confirm every destructive control uses. The tooltip says which agent, how long the streak is, and what will happen, before you commit.
- The agent is **restarted with `--continue`**, so the conversation is kept and it picks up where it left off. The thread so far is re-sent once at the cheaper rate, so the saving starts from the next turn rather than retroactively.
- It is a **streak, not a turn count**. Anything that could touch a file — including `Bash`, which can do anything — resets it to zero and withdraws the offer, so an agent that reads for a while and then starts building is never nudged to downgrade mid-edit.
- **Reviewers and Planners never get it.** Those roles run on Opus *because* they read and judge; a long read-only streak from them is the job being done right.

The same plumbing means a restart can move any agent between tiers: `session:restart` now carries a model, validated against the same whitelist the task board uses.

### Cost & context panel

Off by default — turn on **Show cost & context panel** in `⚙` Options and every Claude pane grows a two-row footer under its terminal. It answers the two questions you can't get from the terminal itself: *how close is this agent to compacting?* and *what is it costing me?*

Top row:

- **Context meter** — a bar plus `used / window` in tokens. This is the size of the prompt the agent's newest turn actually sent, so it tracks the live conversation, not a running total. The bar turns amber past 70% and red past 90%, giving you warning before Claude Code compacts. It scales against the 200k window, re-scaling itself to 1M for a session that exceeds it. An OpenRouter agent instead scales against its own model's context window, straight from the catalog — the same figure its launch environment caps the CLI at, so a 262k or 1M model reads honestly rather than pinned to Claude's 200k. Sub-agent (sidechain) turns run in their own window and never move it.
- **Spend** — estimated cost for this agent at list prices. Its tooltip breaks out input, output, cache-read and cache-write tokens. Cost is computed per transcript entry from that entry's own model and its 1-hour/5-minute cache-write split, so it's exact rather than averaged — but list prices don't know about promotional rates, so treat it as a close estimate.
- **Cache hit rate** — the share of input served from the prompt cache, which bills at a tenth of normal input. High is good and mostly automatic; a number that collapses is a sign something is invalidating the cached prefix.
- **Provider / effort / model** — the panel's right edge, read as one run: `Anthropic / HIGH / Opus 4.8`. The **provider** is which upstream this agent talks to — `Anthropic`, `OpenRouter`, or `OpenRouter · clean` / `· opencode` / `· pi` for a foreign harness — and is fixed when the agent is launched (an OpenRouter agent rides an env prefix, so it can't change mid-session). The **model** is the live one, same source and same picker as the header chip. This is the only place the provider is shown, so a mixed swarm is a reason to leave the panel on.

Bottom row: a **burn sparkline** (tokens per turn, newest on the right), the **turn count**, a live **`working 2m14s` / `waiting 6m` / `idle` timer**, this agent's **estimated share of the 5-hour limit** — its slice of everything the swarm burned this window, applied to the window's own percentage, so it answers "which pane is eating my quota" (OpenRouter agents spend no Anthropic quota, so they show no share and count towards nobody else's) — and on the right, under the model, the **last three tools** it ran. Click that tool trail to open the agent's [activity list](#what-an-agent-has-been-doing); it reads `activity` until the first tool runs, so it is a target from the start. The header's status chip opens the same popover, which is how you reach it with this panel off.

Everything comes from the session transcript Claude Code already writes; SwarmEye reads only the bytes appended since the previous turn, so this costs one small file read per turn and no API calls. A `≈` in front of the cost means the session was already long when SwarmEye started counting and the total is a floor.

The panel costs two rows of terminal height in every pane, which is why it's opt-in.

### Sessions survive restarts

Agents run inside a dedicated tmux server (socket `swarmeye`, its own config at `~/.config/swarmeye/tmux.conf` — your `~/.tmux.conf` is never loaded). Closing SwarmEye only **detaches**; on next launch surviving agents are reattached automatically. Pane `✕` kills an agent for real. A copy of SwarmEye started on its own `--user-data-dir` gets its own socket, so a development or test instance can never reattach to — or clean up — the agents of the one you actually use.

Startup also tidies the server it owns: an agent that never received a prompt has nothing to come back to and is killed rather than restored as a blank pane, and a `swarmeye_*` session no session metadata points at — a leak, unreachable from any pane but still holding its workspace and, on Windows, a WSL process — is killed too. A session another SwarmEye is attached to is never touched, which is what keeps the two instances above independent.

Restarting is not a pane button — it lives in the command palette (**Restart \<name\>**), which keeps a running agent's session from being thrown away by a stray click on the header. A restart continues the last conversation (`claude --continue`) in the same folder. An **exited** agent stays visible and dimmed so you can read its scrollback. If only the connection died while the agent survived, the badge says **detached** and reattaching reconnects without restarting — with a `⟳ reattach all` button in the top bar when several are detached. On Windows, if WSL itself stops answering, a red `⚠ WSL unreachable` banner shows until it's back.

### Notification center

The bell in the top bar keeps a history of agent events — turn finished, waiting on you (with reason), exited, detached — each with agent name, workspace, time, and the task that agent is running. The history **survives a restart**: agents outlive the app in tmux, so what happened while SwarmEye was closed is restored on launch, already marked read. The same event firing again on the same agent bumps a `×N` on its newest row instead of adding another (the list caps at 50), and rows you can still act on — `waiting` entries whose prompt is still answerable — sort to the top. The bell turns amber with a count badge while there are unread events, and on macOS the dock icon carries the same count; click an entry to jump to that pane. Times read as "5m" / "2h" / "3d" ago, with the full timestamp in the tooltip. Closing the popover marks everything read; hovering a row reveals a `✕` that dismisses just that row, and `clear` empties the list.

`details ▸` opens a docked panel on the right edge with the same history in full, untruncated detail — full text, a full date+time stamp, and a meta line giving the model, permission mode and how long the agent had been running when the event fired — plus `🗑 Clear All`. Filter chips at the top narrow it to **All / Needs input / Done / Exited** (which folds detached agents in).

A short synthesized sound plays with a "turn finished" notification (configurable — see Options). An agent **blocking on you** plays a different, falling two-tone instead, so the ear can tell a blocked agent from a finished one; it follows the same mute and the same `None` setting.

**Desktop notifications** (on by default) go one step further: while the SwarmEye window isn't focused, an agent finishing its turn or blocking on you raises a real OS notification naming the agent, its workspace and what happened — the thing that reaches you with SwarmEye minimized behind an editor, which neither the bell nor the taskbar flash can do. Clicking it restores and focuses the window. The OS toast is deliberately silent, since SwarmEye already plays the sound you picked; and the `attention` event that always precedes a `done` is suppressed, so a finished turn produces one notification rather than two. Turn it off with **Desktop notifications** in `⚙` Options.

**Double-clicking the bell mutes it** — no OS notifications and no spoken announcements until you double-click it again. It is a temporary silence, not a setting: both options in `⚙` Options are left exactly as you had them, so unmuting restores them. The bell greys out and wears a slash while muted, and the state survives a restart. Everything that doesn't interrupt stays on — the unread count, the notification panel, the taskbar flash and the sound.

### Messages between agents

The `✉` button in the top bar (`Ctrl+Shift+E`) opens a one-line composer that writes straight into a running agent's input:

- Address with `@name` — several are allowed (`@dora @kite run the tests`), and `@all` broadcasts to every running agent.
- The chips under the box list every running agent (plus `@all`); clicking one addresses it, so a name never has to be typed from memory.
- The hint line names who `Enter` will send to, and refuses to send at all while an address matches no agent.

Delivery is the same channel a task's prompt uses: the text, a beat, then `Enter`, so Claude's input box sees a real keystroke rather than a pasted chunk. Sessions are tmux-backed, so this is one write per agent — nothing is queued or stored.

**Attaching a file or an image.** Typing `@` *after* some text opens a picker over this workspace's files — fuzzy, so `@rap` finds `renderer/app.js` — and `↑`/`↓`, `Enter` or `Tab` insert the path. A leading `@` still addresses an agent, so the two never fight. The list comes from `git ls-files` (tracked plus untracked-but-not-ignored), which is why a folder that isn't a repo offers nothing rather than being crawled.

Paste or drop an **image** into the box and it is written to the app's own data directory and its path inserted, because that is what Claude Code takes: a prompt that names an image file gets the image. On Windows the path inserted is the WSL one, since that is where the agent is. Screenshots land in `pasted/` under the user-data dir, never in your workspace, so they can't turn up in a `git status`.

### Preview dock

The monitor button in the top bar docks a browser to the right of the grid: URL bar, `‹` `›` back/forward, `⟳` reload, `↗` open in your usual browser, `✕` close. Drag its left edge to resize (remembered), and each **workspace keeps its own address**, so switching to the API repo doesn't leave the web app's page up. Typing a bare port is enough — `3000` becomes `http://localhost:3000`.

**It starts the dev server for you.** Opening the dock doesn't assume anything is already running: the main process probes the address this workspace last had up, then the usual dev ports (3000, 5173, 8080, 4200, 8000, 1420), and loads the first one that answers. Only if none do does it start the workspace's own dev server — `npm run dev`, or `start`, or `serve`, whichever `package.json` has first — in its own tmux session (`swarmeye_preview_<workspace>`) on the same tmux server as the agents. It then watches that pane for the address the server prints and loads it, which is what makes a Vite that hopped to the next free port still work. Probing before starting is the point: an agent that already ran the dev server in its pane keeps it, and the dock never launches a second copy. That session outlives the app like any agent's does; a workspace with no dev script, or a server that prints no address within ~15s, says so in the dock, and typing an address by hand always overrides all of this.

It is deliberately **local-only**. The URL box refuses anything that isn't `localhost` / `127.0.0.1`, and the main process enforces the same rule twice more — at attach, and on the top-level document request of any navigation the page starts on its own — in the webview's own session partition, so nothing else in the app is filtered. A page that fails to load says so ("is the dev server running?") rather than showing a browser error page. Subresources are left alone: a local page can still pull a font or a script from wherever it normally would.

### Search across all agents

`Ctrl+Shift+G` (or `⌕` in the top bar) searches every agent's scrollback in every workspace. Click a match to jump — SwarmEye switches workspace if needed, scrolls to the line, and opens the in-pane search prefilled.

### Usage widget

Near the top of the icon rail — two mini bars when Collapsed, two labelled bars with percentages and a reset countdown under an **Anthropic Usage** heading when Expanded. These are the real limits from Claude's OAuth usage API (the same data as `/usage` in Claude Code): 5-hour session utilization (accent) and weekly (amber). A bar turns amber at 75% and red at 90%.

**OpenRouter Usage** — with a key saved, a second heading and two more rows sit below (the Collapsed rail carries the Credits bar too, stacked under the Claude pair as one more mini bar; there is no room for the headings at 57px, so each block's tooltip names it):

| Row | Bar | Right-hand figure |
| --- | --- | --- |
| **Today** | none — a share of the credits you happen to have bought says nothing | today's spend in dollars |
| **Credits** | credits used as a share of credits bought | what is left, `$2.08 left` |

Either section can be switched out of the rail entirely in `⌨ Options → Appearance` (**Anthropic usage in the left menu** / **OpenRouter usage in the left menu**, both on by default) — heading and bars, in both menu sizes.

**Credits** takes the same amber-at-75%, red-at-90% colouring as the Claude bars. The figures come from OpenRouter's `key` and `credits` endpoints on a five-minute poll (click the block to re-read it), and the tooltip adds the week and the month. A key with no readable account balance falls back to that key's own spend limit; with neither, the dollar figures still show and the bars stay empty. No key saved means neither the heading nor the bars appear at all.

Polls every 90 seconds and backs off exponentially if rate-limited — the endpoint is touchy. Click to refresh manually; repeated clicks within 3 seconds replay the last reading rather than hammering it. The last successful reading survives restarts and shows as `remembered from before restart` until the first live fetch lands.

**Rate-limit warning** — a gauge you aren't looking at can't warn you, and with a swarm running you burn quota several times faster than one session does, so the failure mode is a batch of agents dying mid-turn at once. When a window crosses **75%** or **90%** — the same two thresholds the gauges change colour at — a toast says so, with the reset countdown: *"⚠ 5-hour usage 92% — agents may start failing · resets in 34m"*. It fires once per crossing, not on every poll; dropping back under a threshold (or the window resetting) re-arms it, and a stale or failed reading stays quiet rather than treating "no data" as 0%.

Credentials are read read-only — the macOS Keychain (falling back to `~/.claude/.credentials.json`), or from inside WSL on Windows. Nothing is stored or sent anywhere except `api.anthropic.com`.

---

## Isolated agents

Agents in one workspace share one checkout, so two of them editing the same
tree overwrite each other. **Isolation** is the prevention: hover a
workspace's rail tile and click the branch button in its flyout, and from then
on every agent started in that workspace — `+ Agent`, the launch card, a task
from the board — gets a git worktree of its own.

The worktree is `<workspace>/.swarmeye/wt/<agent name>` on a branch called
`swarmeye/<agent name>`, and it is what the agent's terminal starts in. Nothing
else changes: the pane, the role, the model, the task board and restart all
behave exactly as before, except that the pane's git chip now reports **that
agent's** branch and dirtiness rather than the workspace's. A restart puts the
agent back in the same worktree; if the worktree has been removed in the
meantime, it falls back to the workspace itself.

Two details worth knowing:

- **Killing an agent never removes its worktree.** Whatever it had not
  committed is still there; reviewing, committing, merging and removing a
  worktree all happen in the agent's own terminal. Nothing you cannot undo
  happens because a pane was closed.

SwarmEye adds `.swarmeye/wt/` to the repository's `.git/info/exclude` the first
time it makes a worktree there — a nested worktree is not ignored by git on its
own, and your tracked `.gitignore` is not SwarmEye's to edit.

---

## Scoping an agent to a folder

Isolation stops two agents clobbering each other's **checkout**. Scoping stops
them duplicating each other's **work**: an agent scoped to `renderer/` may edit
only inside that folder, so a swarm can be split across a repo by area.

Pick one in the **Scope** field of the launch card that fills an empty
workspace — it applies to every agent in that launch — or set one on a running
agent from its pane's **scope chip**, which offers the same list. `whole
workspace` is the default and means no boundary at all.

Two kinds of thing to pick, under a heading each:

- **Areas** — what the workspace itself says it is made of, from
  `.swarmeye/areas.json` (see below). An area is usually several paths at
  once, because that is how work actually arrives: "Task board" is a view file
  *and* its stylesheet.
- **Folders** — every directory in the workspace, from `git ls-files`, so the
  list follows `.gitignore` and never offers `node_modules`. Four levels deep.

Every Claude pane's header carries a scope chip: the area or folder name once
the agent is bounded, with the exact paths in its tooltip, or a dimmed
`⊘ unscoped` while it isn't. **Click the chip to switch, add or lift the
boundary on a running agent** — the same list opens, `whole workspace` lifts
it. The pick is a restart that continues the conversation (the deny rules were
read by claude at startup and cannot change under the running process — the
same mechanism as switching model from its chip), so picking the boundary the
agent already has does nothing. Bare-harness agents (clean, opencode, pi)
carry no chip: there is no permission layer to deny with.

### Defining areas

`.swarmeye/areas.json` — a name-to-paths map the
repo carries, so it is versioned with the code and an agent can rewrite it:

```json
{
  "Agent pane": ["renderer/features/pane"],
  "Task board": ["renderer/board.js", "renderer/features/board"],
  "Main process": ["main"]
}
```

Each path is a folder or a single file, relative to the workspace. A workspace
without the file simply has no Areas heading. Anything malformed — a path that
isn't there, a name with no paths — is dropped on its own rather than voiding
the file, and the list is re-read on every open.

An area gets **only its own paths**. Files several areas share — `index.html`
holding all the markup, `app.js` holding the wiring — are denied to every
scoped agent, because two agents editing exactly those is what this prevents.
An agent that needs one line in a shared file will tell you instead of taking
it.

**Reads are not restricted.** An agent scoped to one folder still has to read
the rest of the repo to work in it — grep it, follow an import, read a
neighbouring module. Only edits, writes and file creation are bounded.

The boundary is a set of Claude Code permission `deny` rules written into that
agent's own settings file at launch: one walk down from the workspace root,
denying every entry that is neither one of the scope's paths nor on the way to
one. That matters in three ways:

- **It holds in `auto` mode.** Deny rules are evaluated before anything else,
  so bypass permissions does not lift them. An edit outside the folder comes
  back as *Permission denied* and the agent is told to ask you instead.
- **It is fixed for the running process.** Widening or narrowing goes through
  a restart: the scope chip's picker does exactly that, continuing the
  conversation. `↻` restarts it inside the same folder, and either way the
  rules are rebuilt against the tree as it is then; if the folder has since
  been deleted, the restart refuses rather than coming back unbounded.
- **Entries that did not exist at launch are not covered.** The rules name what
  was there, so an agent can still create a *brand-new* top-level file or
  folder outside its scope. Everything that already exists — which is what two
  agents actually collide over — is denied.

A scope needs a Claude agent: clean, opencode and pi agents have no permission
layer to deny with, so asking for one refuses the launch instead of pretending.
An isolated agent is scoped inside its own worktree, at the same relative path.

---

## The task board

`Ctrl+Shift+B`, or the `Task Board` tile, swaps the agent grid for a full-screen dashboard for queuing work ahead of time. The rail tile turns amber while it's open, so you always know which view you're in.

### Creating a task

The board opens straight into the new-task form (`+ New Task` reopens it). A task has:

- **Description** — what the agent should do. Dictate it with the mic button instead of typing, or drop a file onto the box to paste its path. `Ctrl+Enter` (`⌘+Enter` on macOS) submits.
- **Workspace** — which folder its agent runs in.
- **Starting permission mode** — `default` / `accept edits` / `plan` / `auto`.
- **Model** — `default`, Sonnet, Opus, Haiku, Fable, `opusplan` (Opus plans, Sonnet executes), the 1M-context spellings `opus[1m]` and `sonnet[1m]`, and with an OpenRouter key saved the whole catalog under an **OpenRouter** group. A non-default pick is passed as a `--model` launch flag, so it's scoped to that one agent. (Claude's own `/model` command saves as your default for every future session — a per-task choice must not do that.)
- **Harness** — appears beside Model only on an OpenRouter pick: which CLI runs it — **clean**, **opencode** or **pi**, the same three the `+ Agent` picker offers. It opens on whatever that picker last remembered, and a change here counts for this task alone.
- **Reasoning effort** — `default`, low, medium, high, xhigh, max, ultracode, auto. The five named levels are passed as an `--effort` launch flag, scoped to that one agent for the same reason model is (a typed `/effort` saves as your CLI default and would bleed into every later session); `ultracode`/`auto` have no flag spelling and are typed as `/effort <value>` right after the agent starts. `default` uses the Options "Default task effort". Greyed out on an OpenRouter model — those ignore it.
- **Focus mode** — optional, sent as `/focus`. Greyed out on an OpenRouter model, which has no Claude Code footer to toggle.
- **Priority** — low / **medium** / high / critical, shown as a colour-tinted chip.
- **Category** — **maintenance** / bugfix / features by default; the `⚙` beside the picker adds or removes categories per workspace.
- **Close on complete** — checked by default; the agent's pane closes itself when the task finishes.
- **Repeat** — `no repeat` by default, or hourly / daily / weekly. A repeating task queues its own next run the moment its agent finishes: a fresh card in Scheduled, same prompt and settings, due one interval later, badged `⟳ daily` with the due time on hover. Until then the scheduler skips it; from then on it runs like an `auto` task, so it waits for usage headroom rather than eating the window. Delete the queued card to end the series.
- **Follow-up agents** — the box under the options turns one task into a pipeline. Each step is a prompt; separate them with a line containing `---`. When the task completes, its first follow-up is queued as a fresh task in the same workspace with the same model, effort, permission mode, priority and category, carrying the rest of the steps — so *build → review → fix* runs unattended, one agent per step. Up to 10 steps. Stopping an agent by hand ends the pipeline with it, and a card carrying follow-ups shows a `+N next` badge (hover it to read them).

### When it runs

Four scheduling modes:

| Mode | Behavior |
|---|---|
| **start now** (default) | Spawns an agent immediately, or leaves the task in Scheduled with a toast if the agent cap is full |
| **auto** | Holds until Claude usage stays under your ceiling (default 85%) on the 5-hour session window. An OpenRouter task skips that wait — it is billed to OpenRouter, so it starts as soon as an agent slot is free |
| **next session** | Holds until the current 5-hour usage window ends, using the exact reset time Claude's API reports |
| **manual** | Drops straight into the Manual column, untouched by the scheduler, until you move it yourself |

Whenever a slot frees up, usage drops, or a new session begins, as many queued tasks start as the cap allows — **highest priority first**, oldest first within a priority.

### Working the board

Cards sit in **Manual / Scheduled / Active / Completed** columns. Once a task has run, a meta row shows which agent ran it (`▸ name`) and the branch (`⎇ branch`).

- `→` moves a Manual card to Scheduled; `←` moves it back; `▶ start` runs a Scheduled task now.
- **Drag** cards between columns instead — Manual and Scheduled onto each other or onto Active to start immediately, and Active back onto Manual or Scheduled to stop its agent and hand the task back unstarted. You can drop anywhere in a column, not just on top of an existing card. Completed cards don't drag, and nothing drops onto Completed: a task gets there by actually running.
- On Manual and Scheduled cards the **priority and category chips are dropdowns** — change either straight on the board without retyping the task. (They're read-only labels once Active or Completed, where neither value changes anything.)
- Clicking an Active or Completed card jumps to its pane.

A task **completes** automatically when its agent finishes a turn, and returns to Scheduled if the agent exits first. Closing a running task's agent yourself moves it to Completed with a red `■ stopped` badge, so it reads as cut short rather than finished.

A completed card also carries the agent's **closing message** — the last thing it said on the turn that finished the task, quoted under the task text and clamped to three lines (hover for the whole thing). It is read from the session's own transcript, and it never comes from a sub-agent's answer. Claude Code fires the hook that ends a turn *before* it writes that turn's message into the transcript, so the file is read once more shortly after — the card takes its summary from that second read, which is why a task started with active skills says what the agent did rather than the skill preamble it opened with. Turn it off with **Task summary on completion** in Options.

Completed cards keep two buttons: `▤` opens the agent's **full transcript**, captured the moment it finished and kept even after the pane is long gone (with its own `⤓` export), and `⟳` **re-queues the task** as a fresh *start now* task with the same settings — follow-ups included, so re-running the first task re-runs the whole pipeline.

`✕` (click twice) archives a card. `🗄 Archive` opens a read-only list of archived tasks with search plus category and priority filters, each purgeable individually or all at once.

A **Shipped** stats panel beside the form counts tasks finished today / this week / this month / this year, with a one-line quip that shifts tone with today's count.

---

## Orchestrator — a lead agent and its workers

`+ Agent → Orchestrator…` starts **one agent that plans and delegates** instead of doing the work. You give it the job, pick the model it thinks on, and pick a second model its workers run on — a strong lead reading the code, cheap workers writing it.

The card has three fields: the job, **lead** (any Claude tier or OpenRouter model) and **workers** (the same list, plus a **Harness** select when the pick is an OpenRouter model, exactly like the task board's). Launching starts the lead as an ordinary board task, so it appears in the grid as a normal pane you can talk to — the only difference is that it keeps its pane when its turn ends, and it carries a `workers: <model>` chip in its header.

**How it delegates.** The lead is told, in its opening brief, to write `.swarmeye/plan.json` in the workspace: a JSON array of `{ text, role }` objects. SwarmEye watches that file, **consumes it** (reads it, then deletes it) and turns each row into a task on the board, on the worker model, with the role preset the row named. Writing the file again is what queues the next wave — there is nothing else to learn and no command to remember, which is why a file was chosen over a CLI or a scraped transcript.

Worker tasks land as **auto** tasks, so everything the board already does applies unchanged: the agent cap decides how many run at once, the usage gate holds Claude-tier workers until there is headroom (OpenRouter workers skip that gate — they spend no Anthropic quota), and each worker closes when it finishes.

**How it hears back.** As each worker completes, one line is typed into the lead's pane naming the task and quoting what the worker said last — its closing summary when one has landed, otherwise the last thing it printed. Reports are never typed while the lead is mid-turn, and several finishing together arrive as one message rather than three. The last one adds *(that was the last one still running)*, which is the lead's cue to review the work and either queue another wave or stop.

**Its workers don't notify you.** The bell, the OS toast and the spoken announcement are for agents you started yourself; a worker was started by a lead and reports to that lead, so a wave of them no longer buries the notification list or talks over you. The lead announces itself normally, for the whole crew — and everything else still shows every worker: the grid's crew switcher and the task board.

**How many workers one job may have.** Twelve, however many waves the lead writes — it is told the number in its brief, and a wave past the budget is refused with a line saying so rather than silently dropped. A workspace also has one lead at a time: they share a single plan file, so launching a second orchestrator there hands it that file, and the first keeps its pane and crew but stops delegating.

**One cell for the whole crew.** A lead and every worker it starts share a single pane slot rather than filling the grid: the pane header carries a select — at its left end, right after the status dot — naming the lead and each worker, and picking one puts that agent's terminal in the slot. It appears the moment the lead queues a wave: a worker that hasn't started yet is listed by the first words of its task and its state (`queued`), greyed out because there is nothing to show yet, and turns into a normal entry when its agent comes up. The others are still running the whole time — they are simply not mounted, the same way the panes of a workspace you aren't looking at aren't — so ten workers make no difference to the layout. Each entry reads its agent's state (`working`, `needs you`, `idle`, `done`), a finished worker stays in the list so its output remains reviewable until you close its pane with `✕`, and the choice survives a restart. Everything else still counts every worker: the agent cap and the task board.

**Changing the worker model mid-run.** Click the `workers:` chip on the lead's pane for the same filterable picker `+ Agent` uses — Claude tiers and the OpenRouter catalog in one list. It applies to waves queued from then on; workers already running are untouched.

A wave is capped at **8 rows**, and the lead is told so: each row costs a whole agent. It is also told the rule that keeps a parallel swarm from tearing the working copy apart — never give two workers the same file — because all of them share one checkout.

**A worker that can't start.** A task whose agent dies before it finishes goes back on the board and the queue starts it again — but only three times. After that the card is left alone (press `▶` to try again yourself) and the lead is told the worker never started, so it isn't left waiting for a report that will never come. Without that limit a launch that can never succeed loops: the agent exits, the queue restarts it, and every lap leaves a dead pane behind.

Watching stops when the lead's pane goes, so a plan file written after that starts nothing. If the app is restarted while a swarm is running, the lead is picked back up with its agents (they live in tmux) and keeps delegating.

**Orchestrator or Coordinator?** The coordinator is one headless `haiku` call that splits a *sentence* into subtasks you approve by hand; it never sees the code. The orchestrator is a real agent that reads the repo first, delegates on its own judgement, and stays to review. Use the coordinator when you already know the split, the orchestrator when working out the split is the job.

---

## Skills

The `Skills` tile opens a third full-screen view for managing Claude Code skills.

**Installing from GitHub** — `+ Add Skill` clones a repo URL into SwarmEye's skills folder, reading each `SKILL.md` frontmatter for a name and description. Skills are grouped into a colour-tinted box per source repo (click the header to collapse; the `owner/repo` name links to GitHub), each with its own `🗑 all` delete button.

**Finding one** — the filter box above the list matches a skill's name, description, invoke command, source repo or on-disk folder. The stat cards keep counting the whole library while you type, so "12 installed" stays honest; `Esc` in the box clears the filter rather than closing the screen.

Each installed skill row has three checkboxes:

- **Enabled** — symlinks the skill into `~/.claude/skills/<id>/` so **every** agent auto-discovers it through Claude Code's own skill resolution (invocable as `/skill-name`, or picked up when the model judges it relevant — no prompt injection involved). Unchecked, a `📋` button instead copies a one-liner to symlink it into just one project.
- **Active in new sessions** — auto-invokes the skill the moment every new agent starts, instead of waiting for the model to notice it. **Claude agents only**: it works by typing `/skill-name` into the pane, which means nothing to a clean, opencode or pi agent.
- **In OpenRouter agents** — the equivalent for exactly those three ([below](#skills-in-an-openrouter-agent)): the skill's full `SKILL.md` is loaded into the agent's system prompt at launch.

Toggling only affects agents launched **afterward** — Claude Code reads its skill list once at session start, so a running agent needs a restart.

Opening the screen kicks off a background `git fetch` per skill; anything behind its remote gets a `⟳ update` button (`git pull --ff-only`).

**Skills your agents wrote** — the screen also scans `~/.claude/skills/` and each workspace's `<workspace>/.claude/skills/`, listing what it finds under its own `ON DISK` header. These have no enable checkbox (a skill sitting in a folder Claude Code reads is already loaded) but keep "Active in new sessions", "In OpenRouter agents" and a `🗑` that deletes the folder from disk. A workspace-local skill only auto-invokes in agents running in that workspace, since its slash command doesn't resolve elsewhere.

> On Windows, only the workspace-local folders are scanned. The global `~/.claude/skills` there belongs to the copy of Claude Code inside WSL, which the Windows-side home directory doesn't point at.

---

## OpenRouter models

One key from [openrouter.ai](https://openrouter.ai/) puts the whole OpenRouter catalog — Kimi, Qwen, GLM, DeepSeek, GPT, Grok, Gemini and the rest — into every place SwarmEye picks a model. Claude agents are untouched: this adds a second kind of agent beside them, in the same grid, mixed freely.

**Setup** — paste the key into `⌨ Options → Setup → OpenRouter API key` and **Save**. SwarmEye fetches the catalog (a few hundred models, with each one's prices and context window), the row flips to a model count with `↻` refresh and a click-twice `✕` forget, and an **OpenRouter** group appears at the bottom of the model pickers — the task board's model select and the Options default — while the empty-workspace card's **Provider** field unlocks its OpenRouter choice. No restart needed.

Every picker names who pays for the row: the five Claude tiers read **Anthropic Subscription: Sonnet**, **…: Opus** and so on, and a catalog row carries its bare slug (`x-ai/grok-code-fast`). The same wording is used wherever the *provider* itself is chosen — `+ Agent`'s first row, the `Ctrl+N` menu, the launch card's **Provider** field and the Options *New agent shortcut* setting.

**Starting one** — `+ Agent → OpenRouter…` opens a filterable catalog picker (hover a model for its context window and per-million prices); picking a model starts a plain agent on it, with your default permission mode. `Ctrl+N` joins in too: with a key saved it first asks **Claude or OpenRouter** in a small menu — a *remember for future agents* checkbox makes the answer stick, and `⌨ Options → New agent shortcut` holds the same choice (ask every time / Claude / OpenRouter). **`Ctrl+M`** skips all of that and copies the agent you are working in instead — see [Copying an agent](#copying-an-agent-ctrlm). The other route is any of the model selects above: an OpenRouter pick in the Options default makes every new agent an OpenRouter agent, one in the task board's select applies to that task only (with its own **Harness** field beside it, so a scheduled task can run opencode or pi too) — and the launch card asks directly, with its **Provider** field swapping the Model list between Claude's tiers and the catalog for that launch. Choosing OpenRouter there also reveals a **Harness** field — *clean · opencode · pi*, the same three the picker offers — so a whole swarm can be launched on one of them in a click. It opens on the harness the picker last remembered, but a change made in the card counts for that launch only: like every other field on it, it is back to your defaults the next time the card appears.

**How those agents run** — every OpenRouter agent is a **clean agent** (next section): SwarmEye's own minimal CLI talking straight to openrouter.ai, no Claude Code involved at all. The tier-slot `/model` notes further down are about a Claude Code pane with its traffic rerouted, which is what an OpenRouter model handed to Claude Code still is.

### Clean agents — no Claude Code at all

An OpenRouter pick starts SwarmEye's own minimal agent CLI (`agent/clean.js`) instead of Claude Code: a dependency-free program that talks the native OpenAI format straight to openrouter.ai. Nothing Anthropic runs in that pane — no Claude binary, no Claude system prompt colouring answers (ask it what model it is and it answers honestly), no traffic to anyone but OpenRouter. The system prompt is ~200 tokens instead of Claude Code's many thousands, paid every turn.

What it has: four tools (`bash`, read, write, exact-string replace), streamed output with the model's reasoning shown dim, and a permission gate — every bash/write asks `[y]es [n]o [a]lways` in the pane, `a` remembers per tool, and the Options skip-permissions toggle launches it with the gate off. `/model <slug>` switches the model mid-conversation (any catalog slug, no restart), `/clear` starts the conversation over, `/help` lists the rest. A pane restart with resume — the model-chip switch included — continues the conversation where it left off. The pane is a full citizen: status, the activity list, the cost & context panel with catalog prices, and Task Board scheduling all work — the panel's provider label reads **OpenRouter · clean**.

#### Skills in an OpenRouter agent

**Skills** reach the three harnesses that run without Claude Code — clean, [opencode and pi](#opencode-and-pi-agents--somebody-elses-cli-same-pane) — through their own switch: every skill row in the Skills screen carries an **In OpenRouter agents** checkbox next to *Active in new sessions*. Ticked, that skill's full `SKILL.md` is loaded into the agent's system prompt at launch (workspace-local skills only into agents of their workspace) — and, like an active skill on Claude agents, its text is paid on every turn, so give the tick only to skills that earn it.

*Active in new sessions* cannot do this job: it types `/skill-name` into the pane, and none of the three has a slash-command mechanism to answer it — the line would simply be submitted to the model as a prompt. Each takes the skill its own way instead (the clean agent's `--skill`, an `instructions` entry in the config file opencode is launched with, a repeated `--append-system-prompt` for pi), but the effect is the same in all three, and only ever a *path* is handed over — the harness reads the file itself, so nothing of the skill's text touches a command line.

What it deliberately lacks (the point is *lean*): MCP, subagents, auto-compaction — a conversation that outgrows the model's window errors plainly and `/clear` is the reset. Task start modes and `/focus` don't apply; the gate and the skip-permissions toggle are the whole permission model. Its transcripts live in the user-data folder under `clean-transcripts/` rather than in `~/.claude/projects`.

### opencode and pi agents — somebody else's CLI, same pane

The clean agent is not the only way to run a catalog model without Claude Code. The same picker can launch **[opencode](https://opencode.ai)** or **[pi](https://pi.dev)** — two third-party coding CLIs — inside a SwarmEye pane, with SwarmEye supplying the OpenRouter key and the model. The toggle sits at the top of the model list: **clean · opencode · pi**, and it is remembered, so picking a model after that launches it in the harness you chose. Both binaries are expected on the agent shell's `PATH` (`npm i -g opencode-ai`, `npm i -g @earendil-works/pi-coding-agent`); SwarmEye checks for them once at startup, in the very shell a launch gets, and a pane asked for one that isn't there says so and waits on the message rather than falling back to something you didn't pick. That shell is a login shell but not an interactive one, so it never reads your `.bashrc` — a binary installed only onto the `PATH` you set there counts as missing (the clean agent's `node` is the exception: nvm's install is looked up directly).

They are **full citizens, not embedded terminals**. Each runs with a small SwarmEye adapter — an opencode plugin, a pi extension — that translates the tool's own events into exactly the files the rest of the app already reads, so busy/waiting/done status, the activity list with tool names and durations, the cost & context panel at catalog prices, and a completed task's closing summary all work as they do for any agent. The panel's provider label reads **OpenRouter · opencode** or **OpenRouter · pi**. Neither tool's own configuration is touched: opencode is pointed at a config file SwarmEye writes per launch, and pi takes its extension as a launch flag, so the setup you use outside SwarmEye is left exactly as it is. One tmux setting exists for their sake and every agent's: SwarmEye's own `tmux.conf` sets `extended-keys on` (tmux 3.2+), because tmux will not forward a modified key like `Shift+Enter` to anything running under it otherwise — pi says as much in every pane it starts in. It is applied to an already-running server too, so it lands at the next app start rather than needing your agents killed.

Two differences worth knowing before you pick one. **pi has no permission prompts at all** — its author considers them security theatre — so a pi agent always runs its tools unattended, whatever the skip-permissions option says; the provider label in its cost panel says so in its tooltip. **opencode** does have permissions, and follows the option: on, it launches with `--auto`; off, it asks before edits and shell commands, and the pane reads *waiting* while the question is on screen. pi also accepts a system prompt, so role presets reach it; opencode has no flag for one, so a role there supplies only its model.

**Restarting one keeps its conversation.** Each harness names its own conversation, and only that name can reopen it, so the adapter parks the id beside the transcript and a restart-with-resume hands it back — `--session` for both, plus the pane's previous id so the *same* transcript keeps growing and the cost panel carries on rather than resetting to zero. A restart without resume starts clean, and a pane that never got far enough to have an id simply launches fresh instead of failing.

**Skills reach them** the same way they reach a clean agent — the *In OpenRouter agents* checkbox, [described above](#skills-in-an-openrouter-agent). opencode takes them as `instructions` in the config file SwarmEye writes for it, pi as a repeated `--append-system-prompt`; either way the full `SKILL.md` is in the system prompt from the agent's first turn, and a restart brings it back.

What they deliberately lack in this version: they are **manual panes only** — the Task Board's model list does not offer them, because the scheduler cannot inject a prompt into their TUIs yet. Their transcripts are kept beside the clean agent's, under `opencode-transcripts/` and `pi-transcripts/`. Expect the first launch of either to sit quiet for up to a minute while it fetches its own runtime bits.

**Switching model inside an agent** — click the pane's **model chip** (or the model at the right edge of its cost panel). That opens the same filterable picker `+ Agent` uses, listing the four Claude tiers and every catalog model; picking one restarts the agent on it and continues the conversation, so an OpenRouter pane can move anywhere in the catalog and back onto a Claude tier. It is a restart rather than a typed command on purpose: `/model` saves your pick as Claude Code's default for *new* sessions, so an OpenRouter slug chosen that way becomes the default of the next **Claude** agent you start, which then fails with *"There's an issue with the selected model … it may not exist or you may not have access to it"*. A launch flag can't leak like that. The agent has to be attached — a detached pane reconnects instead.

Typing `/model` still works, and against a non-Anthropic upstream Claude Code's own picker has room for exactly four models: the four custom tier slots (`opus`/`fable`/`sonnet`/`haiku`) the launch environment fills. SwarmEye puts the model the agent was launched with in the first, and `⌨ Options → Setup → Models an agent can switch to` fills the other three from the catalog (`＋` opens the same filterable picker, a chip's `✕` drops it). `/model` then lists those alongside the launched one; `s` uses the pick for this session only, `Enter` also makes it the default for new sessions. Slots you leave empty keep pointing at the launched model, so the list is never wrong, only shorter. The setting applies to agents started afterwards — the environment is written at launch. A model that is in the catalog but not in your three can still be typed in full: `/model qwen/qwen3-max`.

**Costs** — the cost panel prices OpenRouter turns from the catalog's exact per-token rates, including each model's published cache rates. The expanded rail carries today's spend and the credits left as a labelled **OpenRouter Usage** block under the Claude bars, refreshed every five minutes from OpenRouter's key API; its tooltip adds the week and the month — see [Usage widget](#usage-widget).

Worth knowing:

- **Asking the agent "what model are you?" is not a routing test** — Claude Code writes its own identity ("You are Claude…") into every session's system prompt, so whatever model sits behind it will earnestly answer that it is Claude. The banner keeps saying "Claude Code" too, because it *is* Claude Code — only its API traffic is rerouted. Proof the pick took: the model slug in the banner, the rail's OpenRouter Usage bars moving, or your [openrouter.ai activity page](https://openrouter.ai/activity).
- **The launch model rides environment variables**, not a `--model` flag, and a restart keeps it. What the agent can switch to mid-session is whatever those variables carry — see *Switching model inside an agent* above.
- **A tier alias is not a tier** in an OpenRouter pane: `opus`, `fable`, `sonnet` and `haiku` are just the four slots the picker reads, each pointing at whichever catalog model you put there. Anything the CLI resolves through the haiku alias on its own follows that slot too; subagents stay on the launched model.
- The effort picker's `ultracode`/`auto` levels and the `→ Haiku` right-sizing offer are Claude-only and never touch OpenRouter panes.
- Claude's 5-hour/weekly usage bars don't apply to these agents — the rail's **OpenRouter Usage** block is their budget view.
- The key lives in `config.json` in your user-data folder, plain text — the same trust level as the rest of that file. It is never sent to the renderer, and never sent anywhere but openrouter.ai.
- **OpenRouter's `~vendor/model-latest` aliases are left out of the catalog.** Eleven of the ~345 models it publishes are rolling pointers — `~moonshotai/kimi-latest` answers as whatever Moonshot's newest model is that week — so the model you picked is not the model you get, and each one duplicates a concrete entry already in the list. They are filtered on the way out of the saved catalog, so an older one is cleaned up without a `↻` refresh.
- Some catalog models carry account-level gates on OpenRouter's side (Meta's Muse models, for example, need the 18+ confirmation in your OpenRouter account settings) — those fail at launch until toggled there.

---

## Voice dictation

Install it first — see [Voice dictation in the main README](../README.md#voice-dictation-optional).

Click the mic button in a pane's header (next to `⌕`) to start listening, click again to stop; each finished phrase is pasted at the prompt. The new-task form has its own mic button too.

Language is auto-detected per phrase (German and English mix freely), with punctuation and capitalization included. Interim text updates about once a second, and a phrase finalizes when you pause. Everything runs locally via [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — audio never leaves your machine.

---

## Spoken notifications

The other direction: SwarmEye telling *you* something. Turn **Spoken notifications** on in `⚙` Options and every turn that ends while you aren't watching that pane is said out loud — one short sentence naming the agent and the workspace it is working in, e.g. *"Bender finished in Payments API."* A session with no workspace name says *"Bender finished."*

That is the whole announcement. It carries nothing from the agent's closing message, so it is said on the turn boundary itself rather than waiting for the transcript read behind it, and it is the same shape every time — which is what makes it recognisable across a room without listening to it. It is also deliberately short: about two seconds, because a busy swarm cuts one announcement off with the next, and a long one is only ever heard in fragments.

A workspace name is a folder name rather than a phrase, and it is the only free text in that sentence, so two shapes are fixed before it is read: a sort prefix is dropped (`03 - SwarmEye` would otherwise be said as "zero three dash SwarmEye") and a camelCase run is split (`DisruptiveNegotiations` comes out as one mangled word). Everything else a folder can be called is left alone.

It needs the **Voice engine** row installed first — a [Piper](https://github.com/OHF-Voice/piper1-gpl) venv plus one voice, about 110 MB, installed into `~/.local/share/swarmeye/tts` (inside WSL on Windows) by `scripts/setup-tts.sh`. That means `python3` has to be present on the shell's side of the boundary, the same prerequisite dictation already has; the script says so and names the fix if it is missing. (Up to 1.48.0 the engine came from the old `rhasspy/piper` release tarballs instead. Those never worked on an Apple Silicon Mac: the `aarch64` asset contains an x86_64 binary, and neither macOS asset ships the three dylibs that binary links against, so every announcement died with `bad CPU type in executable`. Re-running the installer replaces the tarball in place.) `npm run setup:tts` (`setup:tts:win` from a Windows shell) does the same thing from the command line, and takes a voice name if you want a different one: any of the ~50 English voices at [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), e.g. `npm run setup:tts en_GB-alba-medium`. The default is `en_US-hfc_female-medium`.

Synthesis runs locally and takes about a third of a second per announcement; nothing is uploaded, and no audio device is needed inside WSL — the sound is generated as raw samples and played by the app itself. Only *finished* turns speak. "Needs attention" deliberately stays silent: it already flashes the taskbar, raises a toast and rings the bell, and a busy swarm would talk without pause. Several agents finishing at once announce the newest rather than queueing.

---

## Options reference

The `⚙` tile at the bottom of the icon rail opens the Options panel. `↺ Reset` in its header restores every option below to its default in one click.

The panel is two columns wide, every section always visible under its header — **Appearance**, **Agents & panes**, **Defaults for new tasks**, **Notifications** and **Setup**. **Setup** holds the things you touch once rather than tune: the version check, the dictation and voice engine installers, and the OpenRouter API key. A **filter box** under the title searches every option by its label and tooltip — matching rows stay, empty sections disappear, and clearing it (or `Esc`) brings everything back. The table below lists every option regardless of section.

| Option | Default | What it does |
|---|---|---|
| **SwarmEye version** | — | The running version, and a **Check** button that asks GitHub for the latest release right away instead of waiting for the six-hourly background check. When a newer release exists, the row grows a **Download** button (then **Restart & Update**) and a matching pill appears in the top bar. A check that fails says why — *no release published on GitHub yet*, a rate-limit status, or the missing per-platform asset — rather than falling back to "up to date". Downloading is only possible from a packaged build; running from source it says so immediately and links the release page. |
| **Small left menu** | off | Collapses the icon rail to 57px icons-only; hovering previews the expanded layout as an overlay without reflowing the grid. The rail's right border is the same switch: drag it left or right — or click it — to move between the small and big menu, and this checkbox follows. |
| **Anthropic usage in the left menu** | on | Shows the **Anthropic Usage** section — the Session and Weekly bars. Off removes the heading and the bars from the rail in both menu sizes; the data keeps being polled, so the rate-limit warnings still fire. |
| **OpenRouter usage in the left menu** | on | Shows the **OpenRouter Usage** section — today's spend and the credits left. Off removes it and stops its five-minute poll — the only OpenRouter spend request the app makes. Without a saved OpenRouter key the section is hidden whatever this says. |
| **Menu bar size** | 100% | Scales the top bar and icon rail, 70–160%. |
| **Task board, Skills & Options text size** | 100% | Scales the board, archive, Skills screen and this panel, 70–160%. |
| **Agent pane text size** | 13px | Default terminal text size, 8–24px. Shared with the per-pane `−`/`+` buttons and `Ctrl +`/`−`, so changing it here live-updates every open pane. |
| **Agent pane text weight** | Semibold on Windows, Normal on macOS | Stroke weight of the terminal text — Light, Normal, Medium or Semibold. The default differs per platform because DirectWrite lays down lighter stems than macOS's CoreText, so the weight that looks right on a Mac reads thin on Windows. Live-updates every open pane. |
| **Max simultaneous agents** | 10 | Cap on running agents — raise it as high as you want, there is no upper limit. The task scheduler respects it too. |
| **Auto-start usage limit** | 85% | The ceiling an **auto** task waits for, on the 5-hour session usage window. 1–100%. |
| **Allow auto mode (bypass permissions)** | off | Launches agents with `--allow-dangerously-skip-permissions` so `auto` becomes selectable in the mode cycle — *without* starting them in bypass mode. Also auto-accepts the one-time "Do you trust the files in this folder?" and "Running in Bypass Permissions mode" dialogs, since neither is covered by the flag itself. Picking `auto` as the default permission below turns this on automatically, as it's a hard prerequisite. |
| **Show cost & context panel** | off | Adds a two-row footer to every Claude pane — context fullness, spend, cache hit rate, tokens per turn, turn timer, share of the 5-hour limit and the last tools run. See [Cost & context panel](#cost--context-panel). Costs two rows of terminal height per pane. |
| **Show initial command in pane header** | off | Adds a permanent second header row to every pane: the task prompt for a task-started agent, or the first line you typed for a manual one (best-effort — reconstructed from your keystrokes). |
| **Auto-organize agent windows** | on | On: new agents are laid out into the automatic square-ish grid. Off: a free canvas — every pane grows `→` / `↓` buttons that place the next agent beside or below it, plus right/bottom/corner resize handles that move that pane alone. Nothing a pane does moves any other pane. |
| **Default agent permissions** | manual | Presets the new-task form's mode picker, *and* is applied directly to agents started with `+ Coding Agent` / `Ctrl+N`. |
| **Default model** | default | Presets the new-task form's model picker, *and* is applied directly to agents started with `+ Coding Agent` / `Ctrl+N`. `Ctrl+M` ignores it and copies the active agent's model instead. |
| **New agent shortcut** | ask every time | What `Ctrl+N` launches once an OpenRouter key is saved: *ask every time* opens a small Claude / OpenRouter menu under `+ Agent` (its *remember for future agents* checkbox writes this same setting), *Claude* skips the question, and *OpenRouter* goes straight to the catalog picker. Without a key, `Ctrl+N` launches Claude directly whatever this says. `Ctrl+M` copies the active agent and never consults this. |
| **Default task effort** | default | Presets the new-task form's effort picker, *and* is applied directly to agents started with `+ Coding Agent` / `Ctrl+N`. |
| **Default focus mode** | off | Presets the new-task form's focus checkbox. |
| **Task summary on completion** | on | Puts the agent's closing message on the task card when a task finishes, read from its own transcript on the pass that already records the turn's cost. Off leaves Completed cards as they were. |
| **Desktop notifications** | on | Raises a real OS notification — naming the agent, its workspace and what happened — when an agent finishes a turn or needs you while the SwarmEye window isn't focused. Clicking it brings the window back. See [Notification center](#notification-center). |
| **Notification sound** | Chime | Played when an agent finishes a turn — Chime, Ping, Pop, Blip or None. |
| **Spoken notifications** | off | Says which agent just finished and the workspace it was in, for turns that end while you aren't watching that pane. Needs the voice engine below; see [Spoken notifications](#spoken-notifications). |
| **Dictation engine** | not installed | Shows install state and installs the local Whisper engine — see [Voice dictation](#voice-dictation). Deliberately **not** part of `↺ Reset`: an install isn't a preference. |
| **Voice engine** | not installed | Shows install state and installs the local Piper voice used by spoken notifications (~110 MB) — see [Spoken notifications](#spoken-notifications). Deliberately **not** part of `↺ Reset`: an install isn't a preference. |
| **OpenRouter API key** | unset | Paste a key and **Save** to fetch the model catalog and unlock the **OpenRouter** group in every model picker; the row then shows the model count with `↻` (re-fetch the catalog) and a click-twice `✕` (forget the key and catalog). See [OpenRouter models](#openrouter-models). Deliberately **not** part of `↺ Reset`: a key isn't a preference. |
| **Models an agent can switch to** | none | Up to three catalog models that `/model` offers inside an OpenRouter agent, next to the one it was launched with — `＋` opens the filterable catalog picker, a chip's `✕` drops it. Only shown with a key saved; applies to agents started afterwards. See [OpenRouter models](#openrouter-models). |
| **Colour theme** | Dark | Restyles the whole cockpit *and* every terminal's ANSI palette. Fifteen themes: the two dark pages first — Dark and Orange — then Light and twelve light variants that change only the accent hue: Light Blue, Neoblue, Purple, Teal, Rose, Violet, Sky, Indigo, Fuchsia, Emerald, Amber and Slate. Any light one goes dark with **Theme background overlay** off. |
| **Theme background overlay** | on | The selected theme colours everything, including the faint background grid, the app background, the left bar and the agent panes. Off: the grid is hidden and the whole chassis — background, left bar, pane and terminal surfaces — stays the default dark shade, and only the theme's own colours (borders, text, accents, terminal ramp) still follow the theme. Light swaps to a light-on-dark ramp when it is off, so its near-black text stays readable. |

---

## Keyboard shortcuts

On macOS the modifier is **`Cmd`** wherever `Ctrl` appears below — except `Ctrl+Tab` and `Ctrl+I`, which stay `Ctrl` on both platforms (`Cmd+Tab` is the macOS app switcher, and `Ctrl+I` types a literal tab). The in-app list relabels itself to match.

| Shortcut | Action |
|---|---|
| `Tab` | Next agent in this workspace |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous workspace |
| `Ctrl+K` | Command palette — jump to anything |
| `Ctrl+N` | New agent |
| `Ctrl+M` | New agent copying the active one — model, harness, effort, role, permission mode |
| `Ctrl+.` | Go to whoever has been blocked longest (again: the next one down) |
| `Ctrl+X` | Close focused agent (again within 5s: confirm kill) |
| `Ctrl+T` | Task board, new-task form |
| `Ctrl+R` | Dictate — mic in the focused pane, or the task-board form's mic if the board is open |
| `Ctrl+Shift+1…9`, `0` | Focus visible pane N (again: maximize) |
| `Ctrl+Shift+M` | Maximize / restore focused pane |
| `Ctrl+Shift+F` | Search in focused pane |
| `Ctrl+Shift+G` | Search across all agents |
| `Ctrl+Shift+E` | Message agents — `@name`, or `@all` to broadcast |
| `Ctrl+Shift+B` | Task board |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Font size of the focused pane |
| `Ctrl+I` | Type a literal tab into the terminal |
| `Esc` | Close the innermost open panel |

`Shift+Tab` always reaches the terminal — Claude Code uses it to cycle permission modes.

---

## Where things are stored

| | Windows | macOS |
|---|---|---|
| Config, logs, hook state | `%APPDATA%\swarmeye\` | `~/Library/Application Support/SwarmEye/` |
| Dictation engine | `~/.local/share/swarmeye/stt` (inside WSL) | `~/.local/share/swarmeye/stt` |
| Voice engine | `~/.local/share/swarmeye/tts` (inside WSL) | `~/.local/share/swarmeye/tts` |
| Past conversations (read-only, Claude Code's) | `~/.claude/projects/` (inside WSL) | `~/.claude/projects/` |
| tmux config | `~/.config/swarmeye/tmux.conf` (inside WSL) | `~/.config/swarmeye/tmux.conf` |

One thing lives in the workspace itself rather than in the app: `.swarmeye/areas.json`, the areas the [scope picker](#scoping-an-agent-to-a-folder) offers. It is the repo's file — commit it if the rest of the team should have it.

Workspaces, sessions, tasks, skills and every option live in a single `config.json`, written atomically. Two things that change on their own beat are kept out of it so a routine poll never rewrites the whole file: `usage.json` (per-agent cost and context totals) and `usage-snapshot.json` (the last reading from Claude's usage API, so the widget has a number to show before the first poll of a new run answers).

---

## Troubleshooting

**Agents die when I quit.** tmux isn't installed where agents run — inside WSL on Windows, on the Mac otherwise. SwarmEye warns before quitting when this is the case.

**`posix_spawnp failed` on macOS.** SwarmEye re-asserts the executable bit on `node-pty`'s bundled `spawn-helper` at startup, so this self-heals on relaunch. If it persists, fix it by hand:
```
chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper
```

**Everything says "detached" at once (Windows).** WSL stopped answering — the `⚠ WSL unreachable` banner confirms it. Agents usually come back with WSL; their metadata is kept.

**`auto` mode does nothing.** Turn on **Allow auto mode (bypass permissions)** in Options and restart the agent — Claude only offers bypass in its cycle when launched with the flag.

**Dictation says "not installed".** It's an opt-in install — see [Voice dictation](#voice-dictation).

**Debug logging.** Set `SWARMEYE_DEBUG=1` before launching to append renderer console messages and usage snapshots to `swarmeye.log`; `SWARMEYE_TEST=1` additionally dumps renderer state once the window loads. Crash diagnostics are always on regardless: renderer/GPU crashes, unresponsive windows and uncaught main-process errors are logged, a crashed renderer auto-reloads, and local minidumps (never uploaded) are written to `Crashpad/`.

---

## Architecture notes

- One Electron app for both platforms. `main/platform.js` is the only module that knows which OS it's on: agents and every helper command (git, find, ln, whisper) run in a POSIX shell — reached through `wsl.exe` on Windows, the login shell on macOS. The command strings are identical on both; only the argv carrying them differs. The renderer's single platform check picks the shortcut modifier and relabels the shortcut list.
- Sessions run under tmux (`tmux -L swarmeye new-session -A -s swarmeye_<id> claude`); the node-pty terminal only hosts the attach client, which is what makes restarts safe. Session metadata is persisted and reconciled against `tmux list-sessions` at boot; stale entries self-heal.
- `node-pty@1.1.0` is pinned: it ships N-API prebuilds for win32 (ConPTY included) and darwin, so no Visual Studio build tools, Xcode toolchain or electron-rebuild are needed.
- Agent state comes from Claude Code hooks: spawned agents run with `--settings <userData>/hook-settings.json`, whose hooks `cat` their JSON into `hook-state/<sessionId>.json`; the main process fs-watches that directory and relays events to the renderer. Agents reattached from an older version, or hook failures, fall back to output-timing heuristics.
- The model chip isn't a hook field — verified absent from the real payload — so on every `Stop` event SwarmEye tails the session's transcript JSONL for the newest assistant `message.model`.
- No bundler; xterm.js and its addons (fit, webgl, search, web-links) load straight from `node_modules` as UMD.
- `renderer/resizable.js` is the shared half of a drag-the-corner popover: the stylesheet does the resizing (`resize: both` plus a min/max pair, which is also what clamps a restored size into a window that has since shrunk), and the module only remembers the size and centres the box on whatever size it comes back as. Position is set in JS rather than by a centring transform, because a transform-centred box grows in both directions under the grip and the cursor slides off it.
- The preview dock is an Electron `<webview>` in its own session partition. Main allows it at all (`webviewTag`), strips node access and any preload from it at attach, and pins its top-level document to `localhost` — at attach, at `will-navigate`, and at the main-frame request itself, which is the one that also catches a `src` set from the renderer.
- Main process modules: `platform.js` (OS shim), `sessions.js` (PTY/tmux), `usage.js` (usage poller), `config.js` (persistence), `hooks.js` (hook settings + state watcher), `git.js`, `health.js` (WSL probe, Windows only), `update.js`, `skills.js`, `speech.js`, `names.js`. The IPC surface is enumerated in `preload.js`.
