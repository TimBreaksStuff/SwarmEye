# SwarmEye

A desktop cockpit for running many parallel [Claude Code](https://claude.com/claude-code) sessions, each in its own terminal pane, across selectable workspace folders. One app, two platforms: on **Windows** agents run inside WSL, on **macOS** they run natively.

No accounts, no backend, no telemetry. SwarmEye rides entirely on your existing Claude Code login; the usage widget reads Claude Code's own OAuth token read-only and talks to nothing but `api.anthropic.com`.

📖 **[Full documentation](docs/README.md)** — features, the task board, skills, every option, shortcuts and troubleshooting.

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](docs/images/swarmeye.png)

---

## What it does

- **Workspaces** — each folder is a colour-coded tile in the left rail; the selected one decides where new agents start.
- **Agent panes** — as many agents as you want, a terminal each, auto-arranged into a grid you can resize, split, search and export.
- **Role presets** — launch an agent as Builder, Reviewer, Scout or Planner: a short system prompt plus the model tier that job is worth.
- **Coordinator** — hand it a whole request and it splits the work into role-assigned subtasks on the task board, editable before anything runs.
- **Task board** — queue work with model, effort, priority and schedule; chain follow-ups so *build → review → fix* runs unattended.
- **Live agent state** — panes read Claude Code's hooks, not output timing: working (naming the tool), waiting on you, or done.
- **Collision guard** — an amber chip in both panes the moment two agents start editing the same file.
- **Swarm view** — a live map of every agent across every workspace, with live terminal previews and a one-hour timeline ribbon.
- **Message your agents** — `Ctrl+Shift+E` sends a prompt to one agent, several, or `@all`.
- **Command palette** — `Ctrl+K` jumps to any agent, workspace, task, skill or view, and runs the verbs too.
- **Cost & context panel** — per-pane context fill, spend, cache hit rate and tokens per turn, read from the transcript with no extra API calls.
- **Model right-sizing** — an Opus agent on a long read-only streak offers `→ Haiku`, conversation kept.
- **Usage widget** — the real 5-hour and weekly limits from Claude's own OAuth usage API, with a warning before the ceiling.
- **Preview dock** — the workspace's dev server beside the grid, started for you, pinned to localhost.
- **History** — read, export or `claude --resume` any past conversation in a workspace.
- **Branch switcher & diff peek** — each pane's git chip: branch, `git diff --stat`, checkout or create.
- **Workspace notebook** — `.swarmeye/notes.md` per folder, which every agent launched there is told to read.
- **Skills** — install Claude Code skills from GitHub, and see the ones your agents wrote themselves.
- **Notifications** — an OS notification (optionally spoken) when an agent finishes or needs you, with approve/deny from the bell.
- **Sessions survive restarts** — agents live in a dedicated tmux server, so quitting only detaches them.
- **In-app updates** — the app checks GitHub Releases and updates in one click.

---

## Requirements

Both platforms need **Node.js 20+** — preferably an even-numbered LTS line, since Electron's installer silently fails to unpack its binary under the newest majors — **Claude Code** installed and logged in with `claude` on the `PATH`, and **tmux** (strongly recommended — it's what lets agents survive an app restart; without it, quitting kills every running agent).

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

One command does all of it:

```
git clone https://github.com/TimBreaksStuff/SwarmEye.git
cd SwarmEye
bash scripts/setup-mac.sh
```

`setup-mac.sh` is the whole install. It checks the Xcode command line tools, puts Homebrew on your `PATH` if its installer never did (the usual reason for `zsh: command not found: brew` on Apple Silicon), checks Node, warns if `tmux` or `claude` are missing, runs `npm install` — and then verifies the two things npm leaves half-done on a Mac. Downloading the Electron binary is a *postinstall script*, and modern npm defers those until you approve them, so a first install often leaves a hollow `node_modules/electron` whose only symptom is `Error: Electron failed to install correctly`; the script downloads it, and if that still fails it names your Node version as the cause. It also restores the exec bit on node-pty's `spawn-helper`, without which every agent dies with an opaque `posix_spawnp failed`.

Nothing is installed with `sudo` on your behalf: anything that needs it — Homebrew itself, the command line tools, `tmux`, `claude` — is reported with the exact command to run. The script is safe to re-run at any time, and `npm run setup:mac` is the same thing once dependencies exist.

Then **run** — or double-click `SwarmEye.command`, which repairs a half-finished install before launching:
```
npm start
```

macOS asks for microphone permission the first time you use dictation. The app is unsigned — if Gatekeeper blocks a built `.app`, right-click it and choose **Open** once.

### First run

Click the `+ Add workspace` row in the left rail to add your first workspace folder. An empty workspace then shows a **launch card**: pick a swarm size — 1, 2, 4, 6, 8, 10, 12 — check the four settings the agents will start with (**Model · Effort · Focus · Permissions**, pre-filled from your ⚙ Options defaults), and `Launch N agents` opens them all at once. `+ Agent` in the top bar still adds them one at a time, with the role picker.

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

Running apps check that release feed every few hours and offer a one-click download-and-restart update from `⚙` Options → **SwarmEye version**, where **Check** also asks on demand. Until that first release is published the feed is empty, and a check reports *no release published on GitHub yet* — the updater has nothing to find. `publish:release` needs the [GitHub CLI](https://cli.github.com) (`brew install gh`, then `gh auth login`).

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
