# SwarmEye

A desktop cockpit for running many parallel [Claude Code](https://claude.com/claude-code) sessions, each in its own terminal pane, across selectable workspace folders. One app, two platforms: on **Windows** agents run inside WSL, on **macOS** they run natively.

No accounts, no backend, no telemetry. SwarmEye rides entirely on your existing Claude Code login; the usage widget reads Claude Code's own OAuth token read-only and talks to nothing but `api.anthropic.com`.

📖 **[Full documentation](docs/README.md)** — features, the task board, skills, every option, shortcuts and troubleshooting.

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](docs/images/swarmeye.png)

---

## What it does

- **Workspaces** — each folder is a colour-coded tile in the left rail; the selected one decides where new agents start.
- **Agent panes** — as many agents as you want, a terminal each, auto-arranged into a grid you can resize, split, search and export.
- **Role presets** — launch an agent as Builder, Reviewer, Scout or Planner: a short system prompt plus the model tier that job is worth. Editable, and you can add your own.
- **Copy the agent you're in** — `Ctrl+M` spawns another one exactly like it: same model and CLI (Claude Code, clean, opencode, pi), same effort, role and permission mode.
- **Coordinator** — hand it a whole request and it splits the work into role-assigned subtasks on the task board, editable before anything runs.
- **Orchestrator** — one agent reads the code and plans, its workers run on a model of their own: pick a strong lead and cheap workers, and it delegates wave after wave, reviewing each one. The lead and its whole crew share one pane slot, switched with a select in the header, so ten workers never break up the grid.
- **Every subscription tier in every picker** — Sonnet, Opus, Haiku, Fable, `opusplan` (Opus plans, Sonnet executes) and the 1M-context spellings `opus[1m]` and `sonnet[1m]`, wherever a Claude model is chosen: the launch card, the task form, role presets, the orchestrator and a pane's own model menu. Each one names who is billed, so a subscription tier can't be mistaken for an OpenRouter model in the same dropdown.
- **Task board** — queue work with model, effort, priority and schedule; chain follow-ups so *build → review → fix* runs unattended. A task whose agent keeps failing to start is given up on after three tries and left on the board as pending, with `▶` as the retry — no launch failure can spend your agents in a loop.
- **Live agent state** — panes read Claude Code's hooks, not output timing: working (naming the tool *and the file*), waiting on you, or done.
- **Attention queue** — a blocked pane glows and shows how long it has waited; `Ctrl+.` goes to whoever has waited longest.
- **Activity** — click a pane's status for every tool call it has made, with durations, failures, and the files it read and wrote.
- **Subagents, visible** — a `▸ n` chip counts the Task subagents a pane is running; the activity popover names them.
- **Read-only, mid-run** — picking `plan` in a pane's mode dropdown puts a live agent into plan mode, or asks it to stop editing if that can't be set from here.
- **Swarm view** — a live map of every agent across every workspace, with live terminal previews and a one-hour timeline ribbon.
- **Message your agents** — `Ctrl+Shift+E` sends a prompt to one agent, several, or `@all`, with `@` file mentions and pasted screenshots.
- **Command palette** — `Ctrl+K` jumps to any agent, workspace, task, skill or view, and runs the verbs too.
- **Cost & context panel** — per-pane context fill, spend, cache hit rate and tokens per turn, read from the transcript with no extra API calls.
- **Model right-sizing** — an Opus agent on a long read-only streak offers `→ Haiku`, conversation kept.
- **Usage widget** — the real 5-hour and weekly limits from Claude's own OAuth usage API, with a warning before the ceiling.
- **OpenRouter models** — paste one openrouter.ai key and every model picker grows the whole catalog (Kimi, Qwen, GLM, GPT, Grok, …), with a dedicated `+ Agent → OpenRouter…` picker to start an agent on any of them — and `Ctrl+N` asks Claude-or-OpenRouter, with a remember option. Name up to three more catalog models in Options and `/model` inside those agents can switch between them mid-session. Those agents run through your key, with exact catalog pricing in the cost panel and an **OpenRouter Usage** block in the left rail — today's spend and the credits you have left — under the Claude bars; Claude agents run beside them unchanged. Every OpenRouter agent is a **clean agent**: SwarmEye's own minimal agent CLI — no Claude Code, no Anthropic system prompt, native OpenAI wire format, four tools and a y/n permission gate — while status, cost panel and Task Board scheduling keep working, and each skill row offers an "In OpenRouter agents" tick to preload it. The model list's **clean · opencode · pi** toggle can hand the same model to [opencode](https://opencode.ai) or [pi](https://pi.dev) instead — those CLIs run inside a SwarmEye pane as full citizens (status, activity, cost, summaries) with your key and model supplied for them, as manual panes — the empty-workspace launch card offers the same three, so a whole swarm can start on one of them.
- **Preview dock** — the workspace's dev server beside the grid, started for you, pinned to localhost.
- **History** — read any past conversation in a workspace, `claude --resume` it, or export it as text or a self-contained HTML page.
- **Branch switcher & diff peek** — each pane's git chip: branch, `git diff --stat`, checkout or create.
- **Isolated agents** — switch a workspace to isolation and every agent started there gets its own git worktree and branch, so they stop clobbering each other.
- **Review, commit, merge** — the full patch of an agent's worktree in a popover, with a commit box and a `--no-ff` merge back into the workspace.
- **Scope an agent to an area** — pick an area of the codebase ("Agent pane", "Task board") or a plain folder on the launch card, or from `+ Agent → Scoped to a folder…`, and that agent may edit only inside it while still reading the whole repo. Areas are the repo's own, from `.swarmeye/areas.json`. Enforced with Claude Code deny rules, so it holds even in `auto` mode. Switch, add or lift the boundary on a running agent from its pane's scope chip — a restart that continues the conversation.
- **Workspace notebook** — `.swarmeye/notes.md` per folder, which every agent launched there is told to read.
- **Skills** — install Claude Code skills from GitHub, and see the ones your agents wrote themselves.
- **Notifications** — an OS notification (optionally spoken) when an agent finishes or needs you, with approve/deny from the bell; the history persists across restarts, filters by kind, and shows unread as a macOS dock badge.
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

Click the `+ Add workspace` row in the left rail to add your first workspace folder. An empty workspace then shows a **launch card**: pick a swarm size — 1, 2, 4, 6, 8, 10, 12 — check the settings the agents will start with (**Provider · Model · Effort · Focus · Permissions**, pre-filled from your ⚙ Options defaults — Provider swaps the Model list between Claude's tiers and the OpenRouter catalog, and adds a **Harness** field there to launch the whole swarm on clean, opencode or pi), and `Launch N agents` opens them all at once. `+ Agent` in the top bar still adds them one at a time, with the role picker.

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

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for anyone to use, copy, modify and share for any noncommercial purpose. Selling SwarmEye or using it in a commercial product is not permitted.
