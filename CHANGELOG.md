# Changelog

All notable changes to SwarmEye are documented here.

## 1.0.1 — 2026-07-19

Added `npm run publish:github` (`scripts/publish-github.sh`, `:win` variant for Windows) to push a curated public mirror of this repo to GitHub — only the files needed to install and run the app, plus `README.md`, `CHANGELOG.md` and the docs/screenshot. Internal-only files (`CLAUDE.md`, `TODO.md`) stay on the private Gitea remote and never reach GitHub. The mirror is a persistent clone kept at `.github-mirror/` (gitignored), so re-running it adds a real commit to GitHub's own history rather than overwriting it each time.

## 1.0.0 — 2026-07-19

First release.

SwarmEye is a desktop cockpit for running parallel Claude Code sessions, each in its own terminal pane, across selectable workspace folders. It runs on Windows (agents run inside WSL) and macOS (agents run natively) from one codebase. See [README.md](README.md) for the full feature list and setup.

Highlights:

- **Parallel agent grid** — auto-arranging terminal panes, resizable and swappable, with per-pane search, transcript export, drag-and-drop file paths and voice dictation. New Options toggle *Auto-organize agent windows* turns off the auto-arrange and grows `→`/`↓` header buttons to place the next agent by hand instead, keeping whatever column count you built.
- **Live agent state from Claude Code hooks** — panes show what each agent is doing right now (working, which tool, waiting on you, done) rather than guessing from output timing.
- **Task board** — queue work ahead of time with a workspace, permission mode, model, reasoning effort, priority and category, then let it start now, on a usage budget, at the next session window, or by hand. Completed tasks keep their transcript. Active cards can be dragged back onto Manual or Scheduled to stop the agent and hand the task back unstarted, and every column's drop zone fills the whole column rather than just the area around its cards. Auto-start's usage gate checks only the 5-hour session window (not the weekly quota, which resets on its own multi-day clock), and exited/crashed panes no longer keep counting against the max-agents cap.
- **Skills** — install Claude Code skills from GitHub, symlink them so every agent discovers them natively, and see the ones your agents wrote themselves. The screen shows four glass stat cards, one colour-tinted box per source repo (hues cycle per repo), state-edged skill rows (accent glow for active, grey for loaded, dimmed for installed-but-off), and compact `branch@commit` provenance with an outline `⟳ update` pill and small icon copy/delete buttons.
- **Git-aware panes** — the pane git chip is a branch switcher (dropdown of local + remote branches, with a quiet `git fetch` first so newly-pushed branches show up) and can create a new branch (`+ new branch…`) straight from the dropdown. It wears the theme accent colour, with the current branch bold in the dropdown; dirty state stays amber.
- **Sessions survive restarts** — agents live in a dedicated tmux server, so closing SwarmEye only detaches them.
- **Usage widget** — the real 5-hour and weekly limits from Claude's own OAuth usage API, read-only.
- **19 colour themes**, restyling both the cockpit and every terminal, each with its own background wash. New Options toggle *Theme background overlay* (on by default) hides that wash when off, pinning the flat background to the default dark shade while buttons, accents and terminal colours keep following the selected theme.
- **No hard agent cap** — *Max simultaneous agents* remains a cap you set yourself (default 10) with no built-in ceiling.
- Security, stability and performance reviewed across the main and renderer processes: command construction, IPC handling, credential reads and skill installation all sanitize/quote attacker-reachable input correctly. Hardened several edge cases along the way — corrupted config is preserved rather than silently replaced, hook events can no longer be dropped by a same-tick write race, killing an agent no longer risks orphaning its tmux session, restarting two exited agents at once can no longer exceed the agent cap, reattaching sessions on startup no longer risks wiping a session created mid-reattach, and a dictation mic is stopped as soon as its agent's process exits unexpectedly.

No accounts, no backend, no telemetry. SwarmEye rides on your existing Claude Code login and talks to nothing but `api.anthropic.com`.
