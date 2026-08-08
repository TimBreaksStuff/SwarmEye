# SwarmEye — full documentation

Everything SwarmEye does, in detail. For **installation and setup**, see the [main README](../README.md) — it's kept there so there's only ever one copy of the install steps.

---

## Contents

- [Key features](#key-features)
  - [Command palette](#command-palette-ctrlk)
  - [Cost & context panel](#cost--context-panel) · [Swarm view](#swarm-view) · [Swarm timeline](#swarm-timeline) · [History](#history) · [Messages between agents](#messages-between-agents) · [Preview dock](#preview-dock)
- [Isolated agents](#isolated-agents) — [Review, commit, merge](#review-commit-merge)
- [The task board](#the-task-board)
- [Skills](#skills)
- [Voice dictation](#voice-dictation)
- [Spoken notifications](#spoken-notifications)
- [Options reference](#options-reference)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Where things are stored](#where-things-are-stored)
- [Troubleshooting](#troubleshooting)
- [Architecture notes](#architecture-notes)

---

---

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](images/swarmeye.png)

---

## Key features

### Workspaces and the icon rail

A vertical rail runs down the left side: the usage widget at the top, then a `WORKSPACES` group — each workspace as a tile, plus a `+` tile that opens a folder picker — and pinned to the bottom the `SWARM` status strip and a `VIEWS` group holding `Task Board`, `Swarm View`, `History` and `Skills`.

The selected tile decides which folder new agents start in. A tile whose agents need attention turns amber with a pulsing dot; expanded, the row also carries its agent count. Hover a tile for a flyout with the full name, path and agent count — double-click the name there to rename, `📌` to pin it, or `✕` to remove it (running agents are killed after a confirm click); the folder on disk is never touched. Drag tiles to reorder them.

**Pinning** floats a workspace to the top of the rail, marked with a pin beside its name (and lit in its hover flyout), and `Ctrl+Tab` cycles in the order you see rather than the stored one. Inside each group (pinned, then the rest) the drag order is kept, so unpinning drops a workspace back exactly where it was instead of at the end.

The rail comes **Expanded** (full workspace names and tile labels) or **Collapsed** (57px icons only, hover to preview the wider layout as a floating overlay). Both states use the same flat row treatment, and the icons sit in the same column either way, so opening the rail doesn't shift them sideways.

### Agent panes

`+ Coding Agent` opens a small picker and spawns a terminal pane running `claude` in the selected workspace. Each agent gets a random name (Hal Nine Thousand, Artoo Deetoo, Roomba Prime, …) — click to rename. The pool is spelled the way each original is *pronounced* rather than written, because these names are also read out by spoken notifications: `C-3PO` is "See Threepio" in the films' own scripts, `MU-TH-UR` is just "Mother", and a hyphenated model number is what turns an announcement to mush. All agents share one grid regardless of workspace; hover a pane's git chip (or check the rail) to see where it lives.

**Role presets** — the picker's first entry, `Claude`, is a plain agent on your **Default model**. Under it sit four roles:

| Role | Model | What its system prompt says |
|---|---|---|
| **Builder** | Sonnet | Implement exactly what was asked, smallest working diff, this codebase's patterns, then say what changed. |
| **Reviewer** | Opus | Report what's wrong — correctness, then security, then clarity. Don't edit unless asked. One line per finding. |
| **Scout** | Haiku | Locate things and report where they are: paths with line numbers, call sites. Read only, keep it short. |
| **Planner** | Opus | Turn the request into an ordered plan: files touched, steps, risks. Read only, don't write the code. |

A role is launched as `--append-system-prompt`, so it costs no turn and never lands in the conversation as a message; its model tier is a default that the role picks *instead of* the Options default. The pane header wears the role as a chip, `→`/`↓` splits inherit it, and `↻` restart re-applies it (the system prompt belongs to the process, not to the resumed conversation). `Ctrl+N` always spawns a plain agent.

**Those four are a starting point, not the table.** `+ Agent → Edit roles…` opens the editor: reword a preset for your codebase, change the tier it launches on, add your own, or delete one. The list is stored in `config.json` and seeded from the four above the first time it is read, so an existing install keeps exactly what it had.

- A role needs a name and a prompt; one missing either is dropped on save. Delete takes two clicks, and saving an empty list restores the four built-ins rather than leaving the app with no roles.
- The editor's bottom-right corner drags, so a long prompt gets more than two cards' worth of window; the size is kept for next time.
- The name is only a label — the key a saved task refers to is derived once, when the role is created, and does not change when you rename it.
- **Quotes, `$`, backticks and backslashes are stripped from a prompt on save**, and the editor counts them for you as you type. The prompt is passed to the agent inside a single-quoted shell command; a stray apostrophe there would break the launch rather than the sentence.
- Roles are read at launch, so editing one changes the agents you start next, not the ones already running.

Each pane header carries:

- **Status dot + live state** — see below.
- **Mode dropdown** — `manual` (Claude asks before edits), `accept edits`, `plan`, `auto` (bypass permissions). Claude has no set-mode command for a running session, so SwarmEye reads the mode from Claude's own footer and taps `Shift+Tab` through the cycle until yours is active; it stays in sync if you switch modes by hand. `auto` requires the Options toggle below.
- **Model chip** — which model the agent is actually replying with (`Sonnet 5`, `Opus 4.8`, …), read from the session transcript after each turn. A `/model` switch you run yourself shows up instantly.
- **Git chip** — the folder's branch (`⎇ main`), amber with a dot when there are uncommitted changes. Refreshed every 15s; a folder that git can't answer for in time (an unreachable network share, a suspended drive) says so in the tooltip rather than claiming the tree is clean, and one slow workspace no longer holds up the others. The branch list is fetched at most once a minute per workspace, so repeated clicks don't queue up network round-trips. Click it and the popover opens with a **`git diff --stat` summary of the working tree** — staged and unstaged together, which is what "dirty" on the chip actually means — followed by a count of untracked files, which no diff reports. Under that is the branch list (local + remote, fetched fresh from the workspace's git remote): pick one to check it out, or `+ new branch…` to create one off the current HEAD; checkout errors (e.g. uncommitted changes in the way) show as a toast. The diff is read in parallel with the branch fetch, so it is up long before the network call finishes, and a long stat is elided in the middle with git's own "N files changed" line always kept. Above the branch list, `Review changes…` opens the full patch with commit and merge — see [Isolated agents](#isolated-agents). In an isolated workspace this chip reports the agent's *own* worktree branch rather than the workspace's.
- **Buttons** — `↻` restart (on a running agent it arms first — click twice) · `⤓` export transcript · `⌕` in-pane search · mic (dictation) · `−`/`+` text size · `⛶` maximize · `→`/`↓` place a new agent beside/below (only with auto-organize off) · `✕` close (click twice while running).
- **Quick-respond** — while a pane is waiting on a numbered permission prompt (Claude's `1. Yes` / `2. No` style), it grows `✓` approve and `✕` deny buttons right next to the status text — no need to click into the terminal. Shift-click `✓` prefers a "don't ask again" / "allow all" option over a plain yes, if the prompt offers one. The same two buttons show up on `waiting` entries in the notification bell and its docked panel, and on the swarm view's nodes, rows and preview cards. They appear only while a yes/no menu is genuinely on screen: an agent that is merely waiting for you to type something — the commonest kind of `waiting`, and the only kind there is in bypass-permissions mode — says so without offering buttons that have nothing to answer. If the prompt is answered elsewhere between the buttons being drawn and clicked, nothing is sent and a toast says so instead of guessing.
**Opening a workspace with no agents in it** shows the **launch card** over a honeycomb field instead of an empty grid. Pick a swarm size on the tiles — 1, 2, 4, 6, 8, 10, 12 — and `Launch N agents` opens that many panes at once. Tiles are keyboard-first: Tab into the group, arrows move between the ones still selectable, and `Ctrl`/`⌘` plus a size picks it outright.

Under the divider are the four settings those agents start with, each **pre-filled from the matching ⚙ Options default**:

| Field | Options row | How it reaches the agent |
|---|---|---|
| **Model** | Default model | a `--model` launch flag, so it can't bleed into Claude's own saved default |
| **Effort** | Default task effort | an `--effort` launch flag, same reasoning as model (`ultracode`/`auto`, which the flag can't express, are typed as `/effort` once the session is up) |
| **Focus** | Default focus mode | `/focus` typed — but only when Claude's footer disagrees, since it's a toggle |
| **Permissions** | Default start mode | the same `Shift+Tab` cycling the Options default already used |

Changing a field is a **one-off for that launch**: ⚙ Options stays the one place a default is set, and the card goes back to those values the next time it appears. `default` in a field means "let Claude decide" and overrides the Options value with nothing at all — so a card set to `default` launches a bare `claude` even when Options says Opus.

Roles are still the `+ Agent` picker's job, and `+ Agent` / `Ctrl+N` are unchanged — they apply the model and the permission mode only, so a plain agent costs no extra startup turns. The panes are started one after another so the agent cap sees each of them, and only the first takes keyboard focus. Sizes that would break the cap are dimmed and skipped by the keyboard, the selection drops to the largest one still reachable, and with no slots left the button reads `Agent limit reached`. The cap counts every workspace, so three agents running elsewhere under a cap of ten leaves only 1, 2, 4 and 6 offered.

With no workspace selected the card is replaced by the old `No agents here_` hint, since there is nowhere to put the agents.

**The grid** auto-arranges (1 → 2×1 → 2×2 → 3×2 → 3×3 → 4×3) and refits terminals on resize. Turn **Auto-organize agent windows** off in Options to place agents yourself instead: each pane grows `→` and `↓` buttons that open the new agent beside or below it, and the column count stays where you put it. Panes are translucent glass; the focused pane wears a glowing accent border. Drag the gaps between panes to resize rows and columns, and drag a pane by its header onto another to swap them — your arrangement is remembered per workspace while the app runs. Terminals render on the GPU (WebGL, DOM fallback) and URLs in output are clickable. A pane in a workspace you haven't looked at for a minute **gives its GPU context back** — a browser page can only hold about sixteen at once, and every pane in every workspace holds one — and takes it again the moment you switch back. Nothing else changes: the agent, its output and its scrollback are untouched, since only the renderer is swapped for xterm's DOM one while nobody is watching.

**Drag & drop** any file onto a terminal to paste its path — converted to WSL form on Windows (`C:\Users\me\shot.png` → `/mnt/c/Users/me/shot.png`) so Claude can read it. Multiple files paste space-separated; paths with spaces are quoted.

### Live agent state (Claude Code hooks)

Every agent SwarmEye spawns reports its real state through Claude Code's hook system, rather than SwarmEye guessing from output timing:

- **Working** — the dot goes lime and the header reads `vibing...` next to a pulsing equalizer. Which tool is running and what it is on are in the activity popover, which the cost panel's tool trail opens.
- **Waiting on you** — a permission prompt or a question rings the whole pane frame in the theme's accent with a soft glow, shows the reason, and puts the age of the wait beside it (`waiting 4m`).
- **Done** — the pane shows `done` and flags attention.

If the window isn't focused, the taskbar flashes (dock bounces on macOS) and the event lands in the notification bell. Clicking into a pane clears its attention state. Hovering the agent name or its status dot shows the task prompt that started it.

### The attention queue (`Ctrl+.`)

With several agents running, the work is answering whoever is blocked — and finding them meant scanning every pane for a dot that had changed colour. Two things fix that:

- A pane blocked on you carries **how long it has been blocked** (`waiting <1m`, `waiting 4m`, `waiting 1h 12m`). A 40-second block and a 40-minute one no longer look identical.
- **`Ctrl+.`** focuses whoever has waited longest. Press it again for the next one down, and again to come back round. It crosses workspaces — the right workspace is selected on the way — and closes the board or swarm view first, so the agent is actually on screen. With nobody waiting it says so and changes nothing.

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

- Drag the popover's bottom-right corner to size it — a long `cd … && grep …` row needs the width, a busy agent the height. The size is remembered, and clamped back inside the window if you later make the window smaller. The same grip is on the review popover, the role editor, the workspace notebook, the transcript modal and the coordinator; each remembers its own size. Every popover in the app works this way: the workspace notebook, the roles editor, `Review changes…`, the coordinator and the History transcript modal all take a drag and keep the size they were left at, each under its own key.
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
- **Views** — the grid, Task Board, Swarm View, History, Skills.
- **Verbs** — Notes, Message agents, Search across all agents, Options.
- **Acting on an agent** — **Restart \<name\>** and **Close \<name\>** per live agent, plus **Close N idle agents** in one row when any are idle. The palette entry *is* the deliberate act, so unlike the pane's `↻` it fires straight away.
- **Running a task** — **Run now · \<task\>** starts any queued task without finding its card.
- **Themes** — one row per theme, so switching doesn't mean opening Options.
- **Prompts** — the lines you have submitted to agents in the selected workspace (see below).

### Prompt history

Every line you submit to an agent is remembered per workspace — the last 50, newest first, duplicates moved up rather than repeated — and offered back in the palette under **prompt**. Choosing one **types it into the focused agent without submitting**, so you can edit it first.

It is a palette list rather than a key: a pane is a raw terminal and Claude Code already owns `↑`/`↓` inside it, so a second history layered on those keys would fight the first.

The history is stored in the app, never in the workspace, and costs no IPC. **Remember prompt history** in `⚙` Options turns the recording off; what is already stored stays until **Clear prompt history here** — also a palette entry — removes it for that workspace.

### Speaking to the app

The mic in the top bar's action cluster is dictation for SwarmEye itself rather than for one agent: it opens the command palette and fills its box as you speak, so speech reaches every verb the palette already has. Hold the button, say *"task board"*, release, then `Enter`.

It is **push-to-talk** — the mic is open only while the button is held, and releasing it anywhere on screen closes it. A mic for the whole app is not one to leave running: a click-to-toggle button forgotten in the on state listens to the room.

Nothing is run for you — the top match is only selected, since a mishearing would otherwise spawn or close an agent. It needs the same locally-installed dictation engine the pane mics use, and the button is hidden when that isn't available.

Matching is fuzzy, and scored the way people type: hits at the start of a word and runs of adjacent characters count for more, so initials work (`tb` → Task Board) and `swar` puts Swarm View above a workspace that merely contains those letters.

The list is rebuilt every time it opens, so an agent you just closed or a task that just finished is never offered. `↑`/`↓` to move, `Enter` to run, `Esc` to close — and `Esc` reaches it before anything underneath, since it opens over whatever view you were on.

### Workspace notebook

Hover a workspace tile and click `📝` in its flyout to open that folder's notebook, stored as **`.swarmeye/notes.md`** in the workspace itself — so it lives with the repo, and can be committed if you want the team to share it.

It answers "what should the next agent already know?": conventions, gotchas, where things live, decisions that aren't visible in the code. Drag the box's bottom-right corner if a column that narrow is not how you want to write Markdown — the size sticks.

- **Agents are given the path, not the contents.** Every agent launched in a workspace whose notebook has something in it gets one appended line naming `.swarmeye/notes.md` and telling it to read the file before making assumptions. Inlining the notes instead would put all of them in every agent's context and bill for them on every turn, relevant or not — a pointer costs about twenty tokens once.
- **An empty notebook is skipped entirely.** No pointer is added while the file is missing or blank, so nothing is spent sending an agent to read nothing.
- **A role and the notes share one flag.** Both are `--append-system-prompt` text and `claude` keeps only the last such flag, so SwarmEye joins them — a Builder in a workspace with notes keeps its role prompt and its Sonnet tier.
- **Saving is explicit** (`Save`, or `Ctrl+Enter`); closing an edited box saves rather than discarding. Writing on every keystroke would change the file underneath an agent that was reading it.
- The path is resolved in the main process from the workspace id and always sits inside that workspace's folder. Capped at 20,000 characters — the agent pays to read it, so keep it a page, not a book.

Agents already running when you write the notes don't get the pointer; it's added at launch. Restart one, or just tell it to read the file.

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

- **Context meter** — a bar plus `used / window` in tokens. This is the size of the prompt the agent's newest turn actually sent, so it tracks the live conversation, not a running total. The bar turns amber past 70% and red past 90%, giving you warning before Claude Code compacts. It scales against the 200k window, re-scaling itself to 1M for a session that exceeds it. Sub-agent (sidechain) turns run in their own window and never move it.
- **Spend** — estimated cost for this agent at list prices. Its tooltip breaks out input, output, cache-read and cache-write tokens. Cost is computed per transcript entry from that entry's own model and its 1-hour/5-minute cache-write split, so it's exact rather than averaged — but list prices don't know about promotional rates, so treat it as a close estimate.
- **Cache hit rate** — the share of input served from the prompt cache, which bills at a tenth of normal input. High is good and mostly automatic; a number that collapses is a sign something is invalidating the cached prefix.
- **Model** — the live model, same source as the header chip.

Bottom row: a **burn sparkline** (tokens per turn, newest on the right), the **turn count**, a live **`working 2m14s` / `waiting 6m` / `idle` timer**, this agent's **estimated share of the 5-hour limit** — its slice of everything the swarm burned this window, applied to the window's own percentage, so it answers "which pane is eating my quota" — and on the right, under the model, the **last three tools** it ran. Click that tool trail to open the agent's [activity list](#what-an-agent-has-been-doing); it reads `activity` until the first tool runs, so it is a target from the start. The header's status chip opens the same popover, which is how you reach it with this panel off.

Everything comes from the session transcript Claude Code already writes; SwarmEye reads only the bytes appended since the previous turn, so this costs one small file read per turn and no API calls. A `≈` in front of the cost means the session was already long when SwarmEye started counting and the total is a floor.

The panel costs two rows of terminal height in every pane, which is why it's opt-in.

### Swarm view

`Ctrl+Shift+S`, or the `Swarm View` tile (directly above `🗃` in the bottom cluster), swaps the grid for a bird's-eye map of the whole swarm — every agent in every workspace at once, which the grid can't show you because it only ever draws the selected workspace.

Every agent is a node. Its **fill is its workspace's identity colour**, the same colour as that workspace's rail tile, so a project reads as a colour rather than a label. On the light themes that colour is drawn darker — same hue, same swatch, enough lightness taken out of it to read on a white page, which is also what happens to the links, the workspace hubs, the rail tile marks and the swatch picker. With **Theme background overlay** off the chassis stays dark, and so do the colours. Its **ring is its status**, and the ring animates:

| Node | Meaning |
|---|---|
| lime, pulsing every 2.4s | working — the tool it is running is named in the dock |
| amber, pulsing fast | waiting on you (a permission prompt or a question) |
| blue, pulsing slowly | finished its turn, nobody has looked yet |
| grey, static | idle |
| red / amber, dashed and dimmed | exited · detached (agent still alive in tmux) |

A node that is waiting on you or sitting finished also grows a **halo that swells the longer it goes unanswered** (full intensity at five minutes), so a forgotten agent gets louder instead of blending into the map, and its label counts the wait: `waiting 4m23s`.

**Two layouts**, switched in the header and remembered between sessions:

- **Clusters** — one hub per workspace, its agents in orbit around it, the hubs themselves ringing a central swarm core. This is the one to use when you care about which *project* is busy.
- **Ring** — every agent on a single ring around one hub, regardless of workspace. Best with a handful of agents, or when you think of the swarm as one pool.

The **right dock** carries the detail. On top, the **activity list**: one row per agent with its workspace, name, what it is doing right now (the running tool, `vibing...`, the permission message, `done`), how long it has been doing it, and what it has spent and how full its context is. Above that, optionally, a **terminal preview** of the selected agent's last output lines — `▤ Preview` in the header turns it off if you'd rather have a longer list. Agent events live in the bell in the top bar, not on the map. Drag the dock's left edge to resize it, and size the type with the header's two `−`/`+` pairs — the first for the dock and panels, the `map` one for the map's own labels (names, status lines, hubs, legend), 75–200% each. Both stick between sessions.

**Right-click empty map to start an agent there.** The map is laid out by workspace, so the spot you point at already says which project you mean: the form opens with the nearest workspace pre-selected (measured as things currently sit on screen, zoom and pan included) — override it in the picker if the guess is wrong. Type the first prompt in the box, or click the **mic** beside it and dictate it (see [Voice dictation](#voice-dictation)); leave it empty for a bare agent. Tick **auto-close once completed** and the agent is ended as soon as it finishes that turn — the map's equivalent of a task's *close on complete*, for the one-off agents you don't want to remember to close. `Launch agent`, or `Ctrl+Enter`; `Esc` dismisses the form and releases the mic. The view stays on the map, and the new agent simply appears as a node in its workspace's cluster.

An agent blocked on a permission prompt gets `✓` and `✕` buttons on both its node and its row — shift-click `✓` to approve and stop it asking — so a swarm can be unblocked from the map without opening a single pane. Clicking an agent selects it (the dock follows); double-click jumps to its pane. `⤳ Click` in the header flips that: one click jumps straight there, like the rail's swarm-map slots. `+ Agent` starts a new one in the selected workspace, `Esc` or the tile closes the view, and — like the Task Board, Skills and History — it takes over the grid's slot rather than floating above it.

All motion respects `prefers-reduced-motion`.

### Swarm timeline

`▦ Timeline` in the swarm view header docks a **one-hour ribbon** under the map: one lane per agent, banded by what that agent was doing — lime busy, amber waiting on you, grey idle, red exited — with minute labels across the top and `now` at the right edge. Hover a band for the tool it was running and how long it lasted (*"busy · Edit · 10:49 for 15m"*).

Nothing is sampled on a timer: a band runs from the state change that opened it to the next one, so an agent that stays busy for ten minutes costs a single entry. Lanes are reconciled rather than rebuilt on each repaint — the swarm view redraws several times a second with a busy swarm, and a full rebuild would tear out the band the cursor is resting on and orphan its tooltip.

The ribbon is renderer-only and not persisted: it answers "what has this swarm been doing since I sat down", not "what happened last Tuesday". The toggle itself is remembered.

### History

The `History` tile opens a full-screen list of every past Claude conversation for one workspace — Claude Code writes a transcript per session under `~/.claude/projects/<munged-cwd>/<session-id>.jsonl`, and `claude --resume <id>` reopens any of them, so a closed pane stops being a lost thread.

Each row shows the conversation's **opening request**, how long ago it last ran, its transcript size and its session id. The preview deliberately skips the machinery Claude Code records as user turns — an active skill's `/command` envelope, the skill body it injects in reply, `Launching skill: …` — and shows the first turn that was actually you.

- The workspace picker in the header switches folders; `⟳ Refresh` re-reads (the list is re-read on every visit anyway, since agents keep writing to that folder).
- The filter box narrows by preview text or session id.
- Clicking a row reads the transcript in place, in a box you can drag bigger by its bottom-right corner; that size is kept for the next one you open.
- `▶ Resume` spawns a **new** agent (new name, new tmux session) running `claude --resume` on that transcript, switches to its workspace and focuses the pane. Only the conversation comes back; the old process does not.
- `📋` copies the session id, for resuming from a terminal yourself.
- `⤓` saves the conversation as plain text, and `HTML` saves it as a page: one self-contained file with the turns laid out the way the reader modal shows them, no scripts and nothing fetched from anywhere. It carries a light and a dark palette and follows whatever the reader's system is set to — the point of exporting is to hand it to someone who is not going to open SwarmEye.

Newest 60 per workspace. On Windows the transcripts are read from inside WSL through the shell rather than with `fs` — that is where the copy of Claude Code that wrote them lives. A very long conversation is read from its **end**: transcripts run to tens of megabytes and only the last 16 MB is loaded, so what you see is how the session finished.

### Sessions survive restarts

Agents run inside a dedicated tmux server (socket `swarmeye`, its own config at `~/.config/swarmeye/tmux.conf` — your `~/.tmux.conf` is never loaded). Closing SwarmEye only **detaches**; on next launch surviving agents are reattached automatically. Pane `✕` kills an agent for real.

`↻` is on every pane, not only a dead one: on a **running** agent it asks for a second click before it throws the session away (continuing the last conversation, shift-click for a fresh one). An **exited** agent stays visible and dimmed so you can read its scrollback; there `↻` is a single click and restarts it in the same folder continuing the last conversation (`claude --continue`), shift-click starts fresh. If only the connection died while the agent survived, the badge says **detached** and `↻` reconnects without restarting — with a `⟳ reattach all` button in the top bar when several are detached. On Windows, if WSL itself stops answering, a red `⚠ WSL unreachable` banner shows until it's back.

### Notification center

The bell in the top bar keeps a history of agent events — turn finished, waiting on you (with reason), exited, detached — each with agent name, workspace, time, and the task that agent is running. The bell turns amber with a count badge while there are unread events; click an entry to jump to that pane. Closing the popover marks everything read; `clear` empties the list (session-only, last 50).

`details ▸` opens a docked panel on the right edge with the same history in full, untruncated detail — full text, a full date+time stamp, and a meta line giving the model, permission mode and how long the agent had been running when the event fired — plus `🗑 Clear All`.

A short synthesized sound plays with a "turn finished" notification (configurable — see Options).

**Desktop notifications** (on by default) go one step further: while the SwarmEye window isn't focused, an agent finishing its turn or blocking on you raises a real OS notification naming the agent, its workspace and what happened — the thing that reaches you with SwarmEye minimized behind an editor, which neither the bell nor the taskbar flash can do. Clicking it restores and focuses the window. The OS toast is deliberately silent, since SwarmEye already plays the sound you picked; and the `attention` event that always precedes a `done` is suppressed, so a finished turn produces one notification rather than two. Turn it off with **Desktop notifications** in `⚙` Options.

**Double-clicking the bell mutes it** — no OS notifications and no spoken announcements until you double-click it again. It is a temporary silence, not a setting: both options in `⚙` Options are left exactly as you had them, so unmuting restores them. The bell greys out and wears a slash while muted, and the state survives a restart. Everything that doesn't interrupt stays on — the unread count, the notification panel, the taskbar flash and the sound.

### Messages between agents

The `✉` button in the top bar (`Ctrl+Shift+E`) opens a one-line composer that writes straight into a running agent's input:

- Address with `@name` — several are allowed (`@dora @kite run the tests`), and `@all` broadcasts to every running agent.
- The chips under the box list every running agent (plus `@all`); clicking one addresses it, so a name never has to be typed from memory.
- The hint line names who `Enter` will send to, and refuses to send at all while an address matches no agent.
- The swarm view's right-click menu on an agent has **Message it**, which opens the composer with that agent already addressed — the map is where you can see who is idle.

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

Near the top of the icon rail — two mini bars when Collapsed, two radial gauges with percentages and reset countdown when Expanded. These are the real limits from Claude's OAuth usage API (the same data as `/usage` in Claude Code): 5-hour session utilization (accent) and weekly (amber). A gauge turns amber at 75% and red at 90%.

Polls every 90 seconds and backs off exponentially if rate-limited — the endpoint is touchy. Click to refresh manually; repeated clicks within 3 seconds replay the last reading rather than hammering it. The last successful reading survives restarts and shows as `remembered from before restart` until the first live fetch lands.

**Rate-limit warning** — a gauge you aren't looking at can't warn you, and with a swarm running you burn quota several times faster than one session does, so the failure mode is a batch of agents dying mid-turn at once. When a window crosses **75%** or **90%** — the same two thresholds the gauges change colour at — a toast says so, with the reset countdown: *"⚠ 5-hour usage 92% — agents may start failing · resets in 34m"*. It fires once per crossing, not on every poll; dropping back under a threshold (or the window resetting) re-arms it, and a stale or failed reading stays quiet rather than treating "no data" as 0%.

Credentials are read read-only — the macOS Keychain (falling back to `~/.claude/.credentials.json`), or from inside WSL on Windows. Nothing is stored or sent anywhere except `api.anthropic.com`.

### Swarm map

Pinned above the `Task Board` tile, one slot per agent-capacity slot across every workspace: lime = working, pulsing amber = needs attention, gray = idle, dark = free. Collapsed shows a compact 2-column grid of dots; Expanded heads the strip with "Swarm" on the left and the live counts ("`2` busy · `1` waiting", zeros omitted) on the right, and the slots fill one row until there are more than 12, then wrap onto a second. An exited agent frees its slot immediately, same as the session counter in the top bar; if the agent cap is lowered below the number of live agents, every agent still gets a slot rather than being hidden.

---

## Isolated agents

Agents in one workspace share one checkout, so two of them editing the same
tree overwrite each other. **Isolation** is the prevention: hover a
workspace's rail tile and click the branch button in its flyout, and from then
on every agent started in that workspace — `+ Agent`, the launch card, a task
from the board — gets a git worktree of its own.

The worktree is `<workspace>/.swarmeye/wt/<agent name>` on a branch called
`swarmeye/<agent name>`, and it is what the agent's terminal starts in. Nothing
else changes: the pane, the role, the model, the task board and `↻` restart all
behave exactly as before, except that the pane's git chip now reports **that
agent's** branch and dirtiness rather than the workspace's. A restart puts the
agent back in the same worktree; if the worktree has been removed in the
meantime, it falls back to the workspace itself.

Two details worth knowing:

- **Killing an agent never removes its worktree.** Whatever it had not
  committed is still there, and removal is an explicit, click-twice action in
  the review popover below. Nothing you cannot undo happens because a pane was
  closed.
- **The workspace notebook still applies.** `.swarmeye/notes.md` inside a
  worktree is a different file, so an isolated agent is pointed at the
  *workspace's* copy by absolute path instead of the relative name.
- **History files each worktree separately.** Claude Code names its transcript
  folder after the working directory, so an isolated agent's past
  conversations are listed under its worktree, not under the workspace.

SwarmEye adds `.swarmeye/wt/` to the repository's `.git/info/exclude` the first
time it makes a worktree there — a nested worktree is not ignored by git on its
own, and your tracked `.gitignore` is not SwarmEye's to edit.

### Review, commit, merge

`Review changes…` at the top of any pane's git-chip popover — or the diff
button in a workspace's rail flyout — opens the review popover over whatever
view you are on (`Esc` closes it). A patch is the widest thing the app shows, so
the box takes a drag on its bottom-right corner and keeps the size.

- **Left**: the changed files of whatever is being reviewed, untracked ones in
  italic at the bottom, and under them every worktree in the workspace with its
  commits-ahead count, a dot when it is dirty, and `idle` when no agent is
  living in it any more. Click a worktree to review that one instead; click the
  `✕` on an idle one — twice — to remove it.
- **Right**: the full patch of the selected file, coloured by sign. A very
  large patch is cut rather than being allowed to choke the window, and says so.
- **Bottom**: a commit box (which stages everything in that worktree and
  commits it) and **Merge**, which merges the worktree's branch into whatever
  the workspace has checked out, with `--no-ff` so the agent's work stays a
  visible unit.

A merge that conflicts is **aborted**: the workspace is left exactly as it was
and the conflicting paths are named under the patch, rather than leaving you in
a half-merged tree. A workspace with uncommitted changes of its own refuses the
merge for the same reason, and says so.

---

## The task board

`Ctrl+Shift+B`, or the `Task Board` tile, swaps the agent grid for a full-screen dashboard for queuing work ahead of time. The rail tile turns amber while it's open, so you always know which view you're in.

### Creating a task

The board opens straight into the new-task form (`+ New Task` reopens it). A task has:

- **Description** — what the agent should do. Dictate it with the mic button instead of typing, or drop a file onto the box to paste its path. `Ctrl+Enter` (`⌘+Enter` on macOS) submits.
- **Workspace** — which folder its agent runs in.
- **Starting permission mode** — `default` / `accept edits` / `plan` / `auto`.
- **Model** — `default`, Sonnet, Opus, Haiku, Fable. A non-default pick is passed as a `--model` launch flag, so it's scoped to that one agent. (Claude's own `/model` command saves as your default for every future session — a per-task choice must not do that.)
- **Reasoning effort** — `default`, low, medium, high, xhigh, max, ultracode, auto. The five named levels are passed as an `--effort` launch flag, scoped to that one agent for the same reason model is (a typed `/effort` saves as your CLI default and would bleed into every later session); `ultracode`/`auto` have no flag spelling and are typed as `/effort <value>` right after the agent starts. `default` uses the Options "Default task effort".
- **Focus mode** — optional, sent as `/focus`.
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
| **auto** | Holds until Claude usage stays under your ceiling (default 85%) on the 5-hour session window |
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

A completed card also carries the agent's **closing message** — the last thing it said on the turn that finished the task, quoted under the task text and clamped to three lines (hover for the whole thing). It is read from the session's own transcript on the same pass that already records the turn's cost, so it costs no extra call, and it never comes from a sub-agent's answer. Turn it off with **Task summary on completion** in Options.

Completed cards keep two buttons: `▤` opens the agent's **full transcript**, captured the moment it finished and kept even after the pane is long gone (with its own `⤓` export), and `⟳` **re-queues the task** as a fresh *start now* task with the same settings — follow-ups included, so re-running the first task re-runs the whole pipeline.

`✕` (click twice) archives a card. `🗄 Archive` opens a read-only list of archived tasks with search plus category and priority filters, each purgeable individually or all at once.

A **Shipped** stats panel beside the form counts tasks finished today / this week / this month / this year, with a one-line quip that shifts tone with today's count.

---

## Skills

The `Skills` tile opens a third full-screen view for managing Claude Code skills.

**Installing from GitHub** — `+ Add Skill` clones a repo URL into SwarmEye's skills folder, reading each `SKILL.md` frontmatter for a name and description. Skills are grouped into a colour-tinted box per source repo (click the header to collapse; the `owner/repo` name links to GitHub), each with its own `🗑 all` delete button.

**Finding one** — the filter box above the list matches a skill's name, description, invoke command, source repo or on-disk folder. The stat cards keep counting the whole library while you type, so "12 installed" stays honest; `Esc` in the box clears the filter rather than closing the screen.

Each installed skill row has two checkboxes:

- **Enabled** — symlinks the skill into `~/.claude/skills/<id>/` so **every** agent auto-discovers it through Claude Code's own skill resolution (invocable as `/skill-name`, or picked up when the model judges it relevant — no prompt injection involved). Unchecked, a `📋` button instead copies a one-liner to symlink it into just one project.
- **Active in new sessions** — auto-invokes the skill the moment every new agent starts, instead of waiting for the model to notice it.

Toggling only affects agents launched **afterward** — Claude Code reads its skill list once at session start, so a running agent needs a restart.

Opening the screen kicks off a background `git fetch` per skill; anything behind its remote gets a `⟳ update` button (`git pull --ff-only`).

**Skills your agents wrote** — the screen also scans `~/.claude/skills/` and each workspace's `<workspace>/.claude/skills/`, listing what it finds under its own `ON DISK` header. These have no enable checkbox (a skill sitting in a folder Claude Code reads is already loaded) but keep "Active in new sessions" and a `🗑` that deletes the folder from disk. A workspace-local skill only auto-invokes in agents running in that workspace, since its slash command doesn't resolve elsewhere.

> On Windows, only the workspace-local folders are scanned. The global `~/.claude/skills` there belongs to the copy of Claude Code inside WSL, which the Windows-side home directory doesn't point at.

---

## Voice dictation

Install it first — see [Voice dictation in the main README](../README.md#voice-dictation-optional).

Click the mic button in a pane's header (next to `⌕`) to start listening, click again to stop; each finished phrase is pasted at the prompt. The new-task form has its own mic button too, as does the swarm view's right-click launch form.

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

The panel is grouped into five collapsible sections — **Appearance**, **Agents & panes**, **Defaults for new tasks**, **Notifications** and **Setup** — with only Appearance open when the panel first appears. **Setup** holds the things you touch once rather than tune: the version check and the dictation and voice engine installers. Whichever sections you leave open stay open for the rest of the session. The table below lists every option regardless of section.

| Option | Default | What it does |
|---|---|---|
| **SwarmEye version** | — | The running version, and a **Check** button that asks GitHub for the latest release right away instead of waiting for the six-hourly background check. When a newer release exists, the row grows a **Download** button (then **Restart & Update**) and a matching pill appears in the top bar. A check that fails says why — *no release published on GitHub yet*, a rate-limit status, or the missing per-platform asset — rather than falling back to "up to date". Downloading is only possible from a packaged build; running from source it says so immediately and links the release page. |
| **Small left menu** | off | Collapses the icon rail to 57px icons-only; hovering previews the expanded layout as an overlay without reflowing the grid. The rail's right border is the same switch: drag it left or right — or click it — to move between the small and big menu, and this checkbox follows. |
| **Menu bar size** | 100% | Scales the top bar and icon rail, 70–160%. |
| **Task board, Skills & Options text size** | 100% | Scales the board, archive, Skills screen and this panel, 70–160%. |
| **Agent pane text size** | 13px | Default terminal text size, 8–24px. Shared with the per-pane `−`/`+` buttons and `Ctrl +`/`−`, so changing it here live-updates every open pane. |
| **Agent pane text weight** | Semibold on Windows, Normal on macOS | Stroke weight of the terminal text — Light, Normal, Medium or Semibold. The default differs per platform because DirectWrite lays down lighter stems than macOS's CoreText, so the weight that looks right on a Mac reads thin on Windows. Live-updates every open pane. |
| **Max simultaneous agents** | 10 | Cap on running agents — raise it as high as you want, there is no upper limit. The task scheduler respects it too. |
| **Auto-start usage limit** | 85% | The ceiling an **auto** task waits for, on the 5-hour session usage window. 1–100%. |
| **Allow auto mode (bypass permissions)** | off | Launches agents with `--allow-dangerously-skip-permissions` so `auto` becomes selectable in the mode cycle — *without* starting them in bypass mode. Also auto-accepts the one-time "Do you trust the files in this folder?" and "Running in Bypass Permissions mode" dialogs, since neither is covered by the flag itself. Picking `auto` as the default permission below turns this on automatically, as it's a hard prerequisite. |
| **Remember prompt history** | on | Records every line you submit to an agent, per workspace, and offers the last 50 back in the command palette — see [Prompt history](#prompt-history). Off stops recording; nothing already stored is lost. |
| **Show cost & context panel** | off | Adds a two-row footer to every Claude pane — context fullness, spend, cache hit rate, tokens per turn, turn timer, share of the 5-hour limit and the last tools run. See [Cost & context panel](#cost--context-panel). Costs two rows of terminal height per pane. |
| **Show initial command in pane header** | off | Adds a permanent second header row to every pane: the task prompt for a task-started agent, or the first line you typed for a manual one (best-effort — reconstructed from your keystrokes). |
| **Auto-organize agent windows** | on | On: new agents are laid out into the automatic square-ish grid. Off: every pane grows `→` / `↓` buttons that place the next agent beside or below it, and the layout keeps the shape you built. |
| **Default agent permissions** | manual | Presets the new-task form's mode picker, *and* is applied directly to agents started with `+ Coding Agent` / `Ctrl+N`. |
| **Default model** | default | Presets the new-task form's model picker, *and* is applied directly to agents started with `+ Coding Agent` / `Ctrl+N`. |
| **Default task effort** | default | Presets the new-task form's effort picker, *and* is applied directly to agents started with `+ Coding Agent` / `Ctrl+N`. |
| **Default focus mode** | off | Presets the new-task form's focus checkbox. |
| **Task summary on completion** | on | Puts the agent's closing message on the task card when a task finishes, read from its own transcript on the pass that already records the turn's cost. Off leaves Completed cards as they were. |
| **Desktop notifications** | on | Raises a real OS notification — naming the agent, its workspace and what happened — when an agent finishes a turn or needs you while the SwarmEye window isn't focused. Clicking it brings the window back. See [Notification center](#notification-center). |
| **Notification sound** | Chime | Played when an agent finishes a turn — Chime, Ping, Pop, Blip or None. |
| **Spoken notifications** | off | Says which agent just finished and the workspace it was in, for turns that end while you aren't watching that pane. Needs the voice engine below; see [Spoken notifications](#spoken-notifications). |
| **Dictation engine** | not installed | Shows install state and installs the local Whisper engine — see [Voice dictation](#voice-dictation). Deliberately **not** part of `↺ Reset`: an install isn't a preference. |
| **Voice engine** | not installed | Shows install state and installs the local Piper voice used by spoken notifications (~110 MB) — see [Spoken notifications](#spoken-notifications). Deliberately **not** part of `↺ Reset`: an install isn't a preference. |
| **Colour theme** | Dark | Restyles the whole cockpit *and* every terminal's ANSI palette. Six themes: Dark, Light, Orange and three light variants that change only the accent hue — Light Blue, Light Neoblue and Light Purple. |
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
| `Ctrl+Shift+S` | Swarm view |
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
