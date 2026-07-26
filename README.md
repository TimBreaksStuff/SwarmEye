# SwarmEye

A desktop cockpit for running many parallel [Claude Code](https://claude.com/claude-code) sessions, each in its own terminal pane, across selectable workspace folders. One app, two platforms: on **Windows** agents run inside WSL, on **macOS** they run natively.

No accounts, no backend, no telemetry. SwarmEye rides entirely on your existing Claude Code login; the usage widget reads Claude Code's own OAuth token read-only and talks to nothing but `api.anthropic.com`.

📖 **[Full documentation](docs/README.md)** — features, the task board, skills, every option, shortcuts and troubleshooting.

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](docs/images/swarmeye.png)

---

## What it does

- **Workspaces** — each folder is a tile in the left rail; the selected one decides where new agents start. Every workspace carries an identity colour (assigned automatically on add, changeable from the tile's hover flyout) shown as a dot on its tile and as the border of that workspace's agents in the swarm map. Pin the ones you live in (📌 in the tile's flyout) and they float to the top of the rail.
- **Agent panes** — launch as many agents as you want, a terminal each, auto-arranged into a grid you can resize and rearrange (or place by hand with auto-organize off), with search, transcript export, dictation, one-click context clearing (`/clear`) and drag-and-drop file paths. Text selection, clickable URLs and Ctrl+C copy work in every pane, even while the agent inside captures the mouse. The mouse wheel scrolls back through an agent's output where you point it — over the transcript it walks the history, over the input box at the bottom it still steps through the prompts you typed before; typing anything drops back to the live view.
- **Role presets** — `+ Coding Agent` opens a picker: a plain agent, or one of four roles — **Builder** (implement, smallest diff, Sonnet), **Reviewer** (report problems, don't edit, Opus), **Scout** (locate code, read-only, Haiku), **Planner** (plan the steps, read-only, Opus). A role is a short system prompt appended at launch plus the model tier that job is worth, so a swarm can be staffed rather than cloned. The pane wears its role as a chip, splits inherit it, and a restart keeps it.
- **Message your agents** — `✉` in the top bar (`Ctrl+Shift+E`): type `@name do the thing`, or address several at once, or `@all` to broadcast to every running agent. It lands in their input the same way a task's prompt does. The swarm map's right-click menu has `Message it`, so you can answer whoever is idle from the map.
- **Preview dock** — a local dev server beside the grid, in the same window: URL bar, back/forward/reload, open-in-browser, and a draggable edge. Each workspace remembers its own address. Restricted to `localhost` / `127.0.0.1` — the top-level page is pinned to your own machine by the main process, not just by the URL box.
- **Live agent state** — panes read Claude Code's hooks, not output timing: working (naming the tool), waiting on you, or done.
- **Cost & context panel** — an optional footer on every agent pane: how full its context window is (with a bar that warns before compaction), what it has spent, its cache hit rate, the model it runs, tokens per turn, how long the current turn has run, its share of the 5-hour limit and the last tools it ran. Read from the transcript Claude Code already writes — no extra API calls. With the panel on it owns the model — and the reasoning effort beside it, on the model's left; with it off, both show as chips in the pane header instead. An agent's totals persist across restarts of SwarmEye — the agent is still alive in tmux, so what it has spent is still true — and reset only when that agent runs `/clear` or its pane is closed.
- **Swarm view** — the `Swarm View` rail tile (`Ctrl+Shift+S`) swaps the grid for a live map of every agent across every workspace: each node coloured by its workspace, its status carried by an animated ring (working, waiting on you, done, idle, exited), clustered per workspace or ringed around one hub, your choice. Scroll the map to zoom, drag it to pan, right-click an agent for its actions (open, approve/deny, interrupt, `/clear`, restart, end) or right-click empty map to launch a new agent — with its first prompt already typed, or dictated into the box, and optionally set to **close itself once it has finished** — into the workspace whose corner of the map you clicked in; the map stays up and the new agent simply appears on it. The header's counts are also the filter — click `waiting` to pin the map to the agents that need you. Beside it, a **live terminal preview of every running agent** stacked one card each — hover one and it opens to the height of the whole column with thirty lines of that agent's output, and hovering an agent *on the map* does the same from there: the dock scrolls to it, opens its preview and highlights its row without a click, so nothing about your selection changes — over the activity list — who is running what, for how long, at what cost. Both columns are ordered by state, so the working and waiting agents sit at the top and the idle ones at the bottom, with `✓`/`✕` on a row to answer a permission prompt without leaving the map. The dock resizes by dragging its left edge, and the header carries two text-size dials: `−`/`+` for the dock and panels, and a second `map` `−`/`+` for the map's own labels, so the agent names can be readable from across the room without the activity list growing with them. All four are remembered. `▦ Timeline` docks a **one-hour ribbon** under the map — one lane per agent, banded busy / waiting / idle / exited, with the tool it was running on hover.
- **Branch switcher & diff peek** — each pane's git chip shows the workspace branch; click it for a `git diff --stat` summary of what's changed (plus the untracked count), then the local and remote branches to check out or a new one to create.
- **History** — the `History` rail tile lists the 15 most recent Claude conversations for a workspace, each with its opening request. Click a row to read the whole thing — every turn, tool call and result — `⭳` saves it as a text file, and `▶ Resume` reopens it in a fresh pane (`claude --resume`). Closing a pane stops being the end of that thread. Everything older sits behind `🗄 Archive` in the top right, still readable and resumable. `🗑 Delete All (n)` above the list (click twice) permanently deletes exactly the conversations listed below it from `~/.claude/projects` — the filter narrows what it takes, and the conversation a running agent is writing is always kept back.
- **Task board** — queue work ahead of time with a model, permission mode, effort, priority and category; start it now, on a usage budget, or at the next session window. Chain follow-up prompts onto a task and *build → review → fix* runs unattended, one agent per step. Set a task to repeat hourly, daily or weekly and it re-queues its own next run when it finishes. A finished card carries the agent's **closing message**, so Completed says what came of a task without opening its transcript.
- **Skills** — install Claude Code skills from GitHub, and see the ones your agents wrote themselves; a filter box narrows the list by name, description or repo.
- **Sessions survive restarts** — agents live in a dedicated tmux server, so quitting only detaches them.
- **Usage widget** — the real 5-hour and weekly limits from Claude's own OAuth usage API, with a warning toast when a window crosses 75% or 90% so a swarm doesn't walk into the ceiling unannounced.
- **Swarm map** — a compact status grid in the left rail, above Archived: one slot per agent showing busy, needs attention, idle, or free at a glance across every workspace, each slot bordered in its workspace's colour. Click any lit slot to jump to that agent and focus its pane; hover for its name.
- **Notifications that reach you** — the bell keeps the history, and while the window isn't focused an OS notification names the agent and what it did (finished its turn, or needs you). Clicking it brings SwarmEye back. On by default, off in `⚙` Options. Every notification — in the bell popover and the docked panel — carries `↗ Agent` to jump to that pane and `☰ Transcript` to read the agent's whole conversation in the History screen's reader, without leaving the view you are on. The panel's left edge drags to resize it, and the width is remembered.
- **Quick permission responses** — approve or deny an agent's numbered permission prompt straight from its pane header or the notification bell, without switching workspaces or opening the pane. The `✓`/`✕` pair only appears while there is a yes/no menu actually on screen to answer.
- **In-app updates** — the app checks GitHub Releases for new versions and offers a one-click download-and-restart update from `⚙` Options.

---

## Requirements

Both platforms need **Node.js 20+**, **Claude Code** installed and logged in with `claude` on the `PATH`, and **tmux** (strongly recommended — it's what lets agents survive an app restart; without it, quitting kills every running agent).

| | Windows | macOS |
|---|---|---|
| Where agents run | Inside WSL2 | Natively |
| `claude` must be installed | **inside WSL** | on the Mac |
| tmux | inside WSL | `brew install tmux` |
| Node for `npm install` | **Windows** Node, not WSL's | any |
| Python (dictation only) | inside WSL | `xcode-select --install` provides it |

---

## Install

### Windows

1. **Install WSL2** and a Linux distro, if you haven't:
   ```
   wsl --install
   ```

2. **Install Claude Code inside WSL** and log in. From a WSL shell:
   ```
   claude
   ```
   `claude` must be on the PATH *inside WSL* — SwarmEye launches agents there, not on the Windows side.

3. **Install tmux inside WSL** (recommended):
   ```
   sudo apt install -y tmux
   ```

4. **Clone and install.** `npm install` must run with **Windows** Node — from PowerShell or `cmd.exe`, *not* from a WSL shell:
   ```
   git clone https://github.com/TimBreaksStuff/SwarmEye.git
   cd SwarmEye
   npm install
   ```
   From WSL, prefix it: `cmd.exe /c "npm install"`.

   No Visual Studio build tools are needed — `node-pty` ships prebuilt binaries and the native rebuild step is disabled.

5. **Run** — double-click `SwarmEye.bat`, or:
   ```
   npm start
   ```

### macOS

1. **Install Claude Code** and log in:
   ```
   claude
   ```

2. **Install tmux** (recommended):
   ```
   brew install tmux
   ```

3. **Clone and install:**
   ```
   git clone https://github.com/TimBreaksStuff/SwarmEye.git
   cd SwarmEye
   npm install
   ```

4. **Run** — or double-click `SwarmEye.command` (`chmod +x SwarmEye.command` once first):
   ```
   npm start
   ```

macOS asks for microphone permission the first time you use dictation. The app is unsigned — if Gatekeeper blocks a built `.app`, right-click it and choose **Open** once.

### First run

Click the dashed `+` tile in the left rail to add your first workspace folder, then `+ Coding Agent` in the top bar to spawn an agent in it.

---

## Voice dictation (optional)

Dictation is **not** installed by `npm install` — it's a Python virtualenv plus a ~465 MB speech model, far too heavy to force on everyone. Everything runs locally via [faster-whisper](https://github.com/SYSTRAN/faster-whisper); **audio never leaves your machine**.

Install it either way:

- **From inside the app** — `⚙` Options → **Dictation engine** → **Install**. Progress streams into a log box, and the mic works immediately afterwards without restarting.
- **From a terminal:**
  ```
  npm run setup:stt          # macOS
  npm run setup:stt:win      # Windows (runs the same script inside WSL)
  ```

On a slow CPU, `npm run setup:stt -- base` fetches a smaller, faster, less accurate model.

Both routes run the same script, both are safe to re-run, and both install into `~/.local/share/swarmeye/stt` (~680 MB total — delete that folder to undo it). Missing prerequisites are reported with the exact command to fix them rather than failing cryptically, and nothing is ever installed with `sudo` on your behalf.

[How to use it →](docs/README.md#voice-dictation)

---

## Building a release

```
npm run dist       # Windows → dist/SwarmEye-portable.exe (single portable executable)
npm run dist:mac   # macOS   → dist/SwarmEye-mac.zip
```

Build each on its own platform. To make the build available to the in-app updater, publish it as a GitHub release afterwards:

```
npm run publish:release       # macOS / WSL shell
npm run publish:release:win   # Windows, runs the same script inside WSL
```

Running apps check that release feed every few hours and offer a one-click download-and-restart update from `⚙` Options → **SwarmEye version**.

---

## Publishing the public mirror

```
npm run publish:github       # macOS / WSL shell
npm run publish:github:win   # Windows, runs the same script inside WSL
```

Pushes a curated copy of this repo — everything needed to install and run SwarmEye, plus this README, the changelog and the docs/screenshot — to the public GitHub mirror. Internal-only files and dev tooling stay in the private source repository.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for anyone to use, copy, modify and share for any noncommercial purpose. Selling SwarmEye or using it in a commercial product is not permitted.
