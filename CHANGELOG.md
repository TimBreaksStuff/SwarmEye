# Changelog

All notable changes to SwarmEye are documented here.

## 1.0.0 — 2026-07-19

First release.

SwarmEye is a desktop cockpit for running many parallel Claude Code sessions, each in its own terminal pane, across selectable workspace folders. One app, two platforms: on Windows the agents run inside WSL, on macOS they run natively. See [README.md](README.md) for the full feature list and setup, and [docs/README.md](docs/README.md) for the complete documentation.

Highlights:

- **Parallel agent grid** — auto-arranging terminal panes, resizable, splittable and swappable, with per-pane search, transcript export, drag-and-drop file paths and voice dictation.
- **Live agent state from Claude Code hooks** — panes show what each agent is doing right now (working, which tool, waiting on you, done) rather than guessing from output timing.
- **Task board** — queue work ahead of time with a workspace, permission mode, model, reasoning effort, priority and category, then start it by hand, on a usage budget, or at the next session window.
- **Skills** — install Claude Code skills from GitHub, symlink them so every agent discovers them natively, and see the ones your agents wrote themselves.
- **Git-aware panes** — each pane's git chip shows branch and dirty state, and doubles as a branch switcher that can create a branch without leaving the app.
- **Sessions survive restarts** — agents live in a dedicated tmux server, so closing SwarmEye only detaches them.
- **Usage widget** — the real 5-hour and weekly limits from Claude's own OAuth usage API, read-only.

No accounts, no backend, no telemetry. SwarmEye rides on your existing Claude Code login and talks to nothing but `api.anthropic.com`.
