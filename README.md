# SwarmEye

A desktop cockpit for many parallel [Claude Code](https://claude.com/claude-code) and [OpenRouter](https://openrouter.ai) sessions, each in its own terminal pane, across workspace folders. One app, two platforms: on **Windows** agents run inside WSL, on **macOS** they run natively.

No accounts, no backend, no telemetry. SwarmEye rides your existing Claude Code login; the usage widget reads that OAuth token read-only and talks only to `api.anthropic.com`.

📖 **[Full documentation](docs/README.md)** — features, task board, skills, every option, shortcuts, troubleshooting.

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](docs/images/swarmeye.png)

---

## Status

**1.63.34.** Windows (WSL) and macOS. Claude Code, plus OpenRouter through SwarmEye's own clean agent or [opencode](https://opencode.ai) / [pi](https://pi.dev).

Recently solid:

- **Free-canvas layout** when auto-organize is off — each pane is its own rectangle, resized from any edge, remembered per workspace.
- **OpenRouter harnesses start on Windows.** A missing `node` / `opencode` / `pi` is named in the pane instead of `[exited]`.
- **Paste works** — `Ctrl+V`, right-click and Shift+Insert, bracketed so a multi-line paste is one block.

---

## What it does

**Agents.** As many panes as you want, auto-arranged or placed by hand. Launch as Builder, Reviewer, Scout or Planner — a short prompt plus the model that job is worth — or add your own roles. `Ctrl+M` copies the agent you're in (same model, CLI, effort, role, permissions). Live state comes from Claude Code's hooks: working (tool and file), waiting on you, or done. A blocked pane glows and shows how long it has waited; `Ctrl+.` jumps to whoever has waited longest. Click the status for every tool call. A `▸ n` chip counts Task subagents. Pick `plan` mid-run to stop edits. An Opus pane on a long read-only streak offers `→ Haiku`.

**Work.** Each folder is a colour-coded tile; the selected one is where new agents start. The coordinator splits a request into role-assigned tasks you can edit before anything runs. The orchestrator is one lead that plans and a crew of cheaper workers sharing one pane slot. The task board queues work with model, effort, priority and schedule, and chains follow-ups (`build → review → fix`); three failed starts leaves the task pending with `▶` to retry. `Ctrl+Shift+E` messages one agent, several, or `@all`, with `@` files and pasted screenshots. `Ctrl+K` is the command palette.

**Models.** Every Claude tier in every picker — Sonnet, Opus, Haiku, Fable, `opusplan`, `opus[1m]` / `sonnet[1m]` — each labelled so a subscription tier isn't mistaken for OpenRouter. Paste one openrouter.ai key and every picker grows the catalog (Kimi, Qwen, GLM, GPT, Grok, …). Those agents run through your key, with catalog pricing in the cost panel and today's spend / remaining credits in the rail. Each one is a **clean agent** (SwarmEye's own CLI) unless you hand the same model to opencode or pi. The empty-workspace launch card can start a whole swarm on any of the three.

**Code.** Isolation gives every agent its own git worktree and branch. Review the full patch, commit, and `--no-ff` merge back. Scope an agent to an area (from `.swarmeye/areas.json`) or a folder — it can still read the repo, but Claude Code deny rules block edits outside, even in `auto`. The git chip shows branch, `git diff --stat`, checkout or create. `.swarmeye/notes.md` is the workspace notebook every new agent is told to read.

**Around the swarm.** Swarm view maps every agent across every workspace, with live previews and a one-hour timeline. The preview dock is the workspace's localhost dev server. History reads any past conversation, resumes it, or exports text / HTML. Skills install from GitHub or show the ones agents wrote. Notifications (optionally spoken) fire when an agent finishes or needs you; approve/deny from the bell. Agents live in a dedicated tmux server, so quitting only detaches them. The app checks GitHub Releases and updates in one click.

The left rail shows the real 5-hour and weekly Claude limits, plus OpenRouter spend if you have a key. Each pane has a cost & context panel (fill, spend, cache hit rate, tokens per turn) from the transcript — no extra API calls.

---

## Requirements

Both platforms need **Node.js 20+** — preferably an even-numbered LTS, since Electron's installer silently fails to unpack under the newest majors — **Claude Code** installed and logged in with `claude` on the `PATH`, and **tmux** (strongly recommended: without it, quitting kills every running agent).

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
   From WSL, prefix it: `cmd.exe /c "npm install"`. No Visual Studio build tools are needed — `node-pty` ships prebuilt binaries.

5. **Run** — double-click `SwarmEye.bat`, or `npm start`.

### macOS

```
git clone https://github.com/TimBreaksStuff/SwarmEye.git
cd SwarmEye
bash scripts/setup-mac.sh
```

`setup-mac.sh` checks Xcode CLT, Homebrew, Node, warns if `tmux` or `claude` are missing, runs `npm install`, downloads Electron if npm deferred the postinstall (`Error: Electron failed to install correctly`), and restores the exec bit on node-pty's `spawn-helper` (without it every agent dies with `posix_spawnp failed`). Nothing is installed with `sudo` on your behalf. Safe to re-run; `npm run setup:mac` is the same once dependencies exist.

Then **run** — or double-click `SwarmEye.command`, which repairs a half-finished install before launching:
```
npm start
```

macOS asks for microphone permission the first time you use dictation. The app is unsigned — if Gatekeeper blocks a built `.app`, right-click it and choose **Open** once.

### First run

Click `+ Add workspace` in the left rail. An empty workspace shows a **launch card**: pick a swarm size (1–12), check **Provider · Model · Effort · Focus · Permissions** (pre-filled from ⚙ Options — Provider swaps Claude's tiers and the OpenRouter catalog, and adds **Harness** to launch the whole swarm on clean, opencode or pi), and `Launch N agents`. `+ Agent` still adds them one at a time, with the role picker.

---

## Voice dictation (optional)

Not part of `npm install` — a Python virtualenv plus a ~465 MB [faster-whisper](https://github.com/SYSTRAN/faster-whisper) model. Everything runs locally; **audio never leaves your machine**.

- **In-app:** ⚙ Options → **Dictation engine** → **Install**. The mic works afterwards without restarting.
- **Terminal:** `npm run setup:stt` (macOS) or `npm run setup:stt:win` (runs the same script inside WSL). On a slow CPU, `npm run setup:stt -- base` fetches a smaller model.

Both routes install into `~/.local/share/swarmeye/stt` (~680 MB — delete that folder to undo). Missing prerequisites are reported with the exact command to fix them. [How to use it →](docs/README.md#voice-dictation)

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to use, copy, modify and share for any noncommercial purpose. Selling SwarmEye or using it in a commercial product is not permitted.
