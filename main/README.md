# `main/`

The main process. One module per concern, wired together in `main.js`, which
owns the window, the monitors and nothing else — the `ipcMain` surface lives in
[`ipc/`](ipc/README.md).

`main/platform.js` is the **only** OS-aware module: every `exec`, every spawned
shell and every path translation goes through it. Nothing else may branch on
the platform.

## The modules

| File | Owns |
|---|---|
| `main.js` | window lifecycle, the monitors, crash/runstate logging |
| `ptystream.js` | pty output on its way to the renderer — coalesced per session, two beats |
| `ipc/` | every `ipcMain` channel, one file per domain |
| `config.js` | `config.json` and the blobs split out of it — atomic writes, `DEFAULTS` backfill |
| `tasklogs.js` | one file per completed task's transcript, read on demand |
| `sessions.js` | the tmux/PTY manager and every launch command |
| `hooks.js` | agent state, tokens, cost, summaries — source of truth |
| `providers.js` | OpenRouter key, catalog and slug decoding |
| `roles.js` | the four role presets (prompt + model tier) |
| `models.js` | the one model and effort table — values, labels, and which are launch flags |
| `scope.js` | a workspace's areas and the deny rules a scope becomes |
| `git.js` | branch/dirty per workspace and per agent worktree, branch list and checkout |
| `worktree.js` | one git worktree per agent, and landing its branch when the pane closes |
| `usage.js` | the Claude OAuth usage poll |
| `skills.js` | clone/symlink/update GitHub skills, discover local ones |
| `speech.js` | both voice directions — Whisper in, Piper out |
| `attach.js` | the `@` picker's file list |
| `preview.js` | find or start a dev server for the preview dock |
| `template.js` | the standard `CLAUDE.md` copied into new workspaces |
| `coordinator.js` | one headless `claude -p` call that splits a request |
| `orchestrator.js` | the lead agent's plan file, watched and consumed |
| `health.js` | WSL reachability (Windows only) |
| `update.js` | GitHub release check |
| `names.js` | the agent name pool |
| `platform.js` | the OS shim — `exec`, `spawnShell`, `toShellPath`, `IS_WIN` |

## Rules that bite

- **Everything reaching a shell command line is re-validated here**, even when
  the renderer already checked it. Model names, slugs, dimensions, branch
  names, session ids all land in a single-quoted tmux command.
- **One `--append-system-prompt`.** `claude` keeps only the last such flag, so
  everything appended to the system prompt shares one — see `sessions.js`.
- **Every `exec` is a `wsl.exe` spawn on Windows.** Batch related commands.
- **pty output is batched before it crosses IPC** (`queuePtyData` in
  `main.js`): 16ms for a session whose pane is on screen, 250ms for one behind
  it. The renderer says which is which over `sessions:visible` — until it has,
  every session counts as visible. Anything that drains the queue has to leave
  the slow half armed, or an agent that goes quiet while hidden strands its
  last chunk.
- **No globs in an `exec` string.** These run in the user's login shell, which
  on macOS is zsh, and zsh treats a pattern that matches nothing as a *fatal*
  error — it aborts the whole script, and the caller sees the same `null` it
  would get from an unreachable shell. Use `find` (see `worktree.js`).
- **On Windows the tmux server only lives as long as a Windows-side WSL client
  does.** WSL powers the distro down once its last client exits — a process
  *inside* WSL, tmux included, does not hold it — so closing SwarmEye used to
  kill every agent. `sessions.js` leaves one detached keeper client behind
  (`_ensureKeeper`, via `platform.spawnDetachedShell`); it exits by itself once
  tmux has no sessions left.

## How to test

`npm start` and use the app — there is no test runner. For the launch command
that actually resulted, `ps -eo args | grep swarmeye_<session>`. For hook-driven
state without spending an agent turn, drop a payload into
`<userData>/hook-state/<sessionId>.json` and watch the pane react.

Rationale per module: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
