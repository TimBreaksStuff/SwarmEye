# SwarmEye

A desktop cockpit for running many parallel [Claude Code](https://claude.com/claude-code) sessions, each in its own terminal pane, across selectable workspace folders. One app, two platforms: on **Windows** agents run inside WSL, on **macOS** they run natively.

No accounts, no backend, no telemetry. SwarmEye rides entirely on your existing Claude Code login; the usage widget reads Claude Code's own OAuth token read-only and talks to nothing but `api.anthropic.com`.

📖 **[Full documentation](docs/README.md)** — features, the task board, skills, every option, shortcuts and troubleshooting.

![SwarmEye running four Claude Code agents in a 2x2 grid of terminal panes, with the workspace rail and usage gauges down the left side](docs/images/swarmeye.png)

---

## What it does

- **Workspaces** — each folder is a tile in the left rail; the selected one decides where new agents start.
- **Agent panes** — launch as many agents as you want, a terminal each, auto-arranged into a grid you can resize and rearrange (or place by hand with auto-organize off), with search, transcript export, dictation and drag-and-drop file paths.
- **Live agent state** — panes read Claude Code's hooks, not output timing: working (naming the tool), waiting on you, or done.
- **Branch switcher** — each pane's git chip shows the workspace branch; click it to list local and remote branches, check one out, or create a new one.
- **Task board** — queue work ahead of time with a model, permission mode, effort, priority and category; start it now, on a usage budget, or at the next session window.
- **Skills** — install Claude Code skills from GitHub, and see the ones your agents wrote themselves.
- **Sessions survive restarts** — agents live in a dedicated tmux server, so quitting only detaches them.
- **Usage widget** — the real 5-hour and weekly limits from Claude's own OAuth usage API.

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
npm run dist       # Windows → dist/SwarmEye <version>.exe (single portable executable)
npm run dist:mac   # macOS   → dist/SwarmEye-<version>-*.zip
```

Build each on its own platform.

---

## Publishing the public mirror

```
npm run publish:github       # macOS / WSL shell
npm run publish:github:win   # Windows, runs the same script inside WSL
```

Pushes a curated copy of this repo — everything needed to install and run SwarmEye, plus this README, the changelog and the docs/screenshot — to the public GitHub mirror. Internal-only files stay on the private Gitea remote.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for anyone to use, copy, modify and share for any noncommercial purpose. Selling SwarmEye or using it in a commercial product is not permitted.
