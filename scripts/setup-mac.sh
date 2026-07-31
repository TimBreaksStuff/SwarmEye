#!/usr/bin/env bash
# One-shot macOS setup for SwarmEye. Reports every missing prerequisite with the
# exact command that fixes it, installs the npm dependencies, then verifies the
# two things npm is known to leave half-done on a Mac: the Electron binary
# (whose download is a postinstall script, and modern npm defers those until you
# approve them) and node-pty's spawn-helper exec bit. Safe to re-run.
# Usage: bash scripts/setup-mac.sh [--check]   (--check verifies, installs nothing)
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say()  { echo "setup-mac: $*"; }
warn() { echo "setup-mac: $*" >&2; }
# Prereqs needing sudo or a GUI are reported, never installed for you — the same
# rule setup-stt.sh follows. Each failure names the exact command to fix it.
need() { warn "$1"; echo "fix: $2" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || need "this script is macOS only" \
  'on Windows, from PowerShell or cmd.exe: npm install'

# 1. Xcode command line tools. Homebrew and node-gyp both need them, and without
#    them the failure surfaces pages deep as a compiler error instead of here.
xcode-select -p >/dev/null 2>&1 || need "Xcode command line tools are missing" \
  'xcode-select --install    # click Install in the pop-up, then re-run this script'

# 2. Homebrew. Usually installed but invisible: its installer does not touch the
#    shell profile on Apple Silicon, so brew sits in /opt/homebrew/bin and zsh
#    never sees it. Hook it up permanently rather than reporting it.
if ! command -v brew >/dev/null 2>&1; then
  for BREW in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$BREW" ] || continue
    eval "$("$BREW" shellenv)"
    if ! grep -qsF "$BREW shellenv" "$HOME/.zprofile"; then
      echo "eval \"\$($BREW shellenv)\"" >> "$HOME/.zprofile"
      say "added brew to your PATH in ~/.zprofile"
    fi
    break
  done
fi
command -v brew >/dev/null 2>&1 || need "Homebrew not found" \
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

# 3. Node. Electron's downloader breaks on brand-new majors — under Node 26 it
#    exits without unpacking anything and leaves a hollow node_modules/electron
#    whose every use throws "Electron failed to install correctly". Even-numbered
#    lines are the LTS ones.
FIX_NODE='brew install node@22 && brew link --overwrite node@22    # then open a new terminal'
command -v node >/dev/null 2>&1 || need "Node.js not found" "$FIX_NODE"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || need "Node $(node -v) is too old — SwarmEye needs 20+" "$FIX_NODE"
if [ "$NODE_MAJOR" -gt 24 ] || [ $((NODE_MAJOR % 2)) -ne 0 ]; then
  warn "Node $(node -v) is not an LTS line — if the Electron download below fails, this is why"
fi

# 4. Runtime prerequisites of the agents themselves. Missing either still leaves
#    a usable app, so these warn rather than stop.
command -v tmux >/dev/null 2>&1 || \
  warn "tmux not found — agents would not survive an app restart. fix: brew install tmux"
command -v claude >/dev/null 2>&1 || \
  warn "claude not found on PATH — install Claude Code and log in once: https://claude.com/claude-code"

if [ "$CHECK_ONLY" = 0 ]; then
  say "installing dependencies"
  npm install
fi

# 5. The Electron binary. require('electron') resolves to the executable's path
#    and throws when the postinstall never downloaded it, which is exactly the
#    state npm leaves behind when it defers install scripts.
electron_ok() {
  local bin
  bin=$(node -p 'require("electron")' 2>/dev/null) || return 1
  [ -n "$bin" ] && [ -e "$bin" ]
}

if ! electron_ok; then
  [ "$CHECK_ONLY" = 0 ] || need "the Electron binary was never downloaded" 'bash scripts/setup-mac.sh'
  say "Electron has no binary (npm skipped its postinstall) — downloading it"
  node node_modules/electron/install.js || true
fi
if ! electron_ok; then
  say "still missing — reinstalling electron from scratch"
  rm -rf node_modules/electron
  npm install --foreground-scripts || true
  electron_ok || node node_modules/electron/install.js || true
fi
electron_ok || need "Electron still has no binary after a clean reinstall" \
  "Node $(node -v) is the likely cause. $FIX_NODE, then: rm -rf node_modules package-lock.json && bash scripts/setup-mac.sh"

# 6. node-pty runs from its prebuilds folder; lose the exec bit on spawn-helper
#    and every agent spawn dies with an opaque posix_spawnp failure.
HELPER="node_modules/node-pty/prebuilds/darwin-$(node -p 'process.arch')/spawn-helper"
[ -f "$HELPER" ] || need "node-pty has no prebuild for darwin-$(node -p 'process.arch')" \
  'rm -rf node_modules && bash scripts/setup-mac.sh'
[ -x "$HELPER" ] || { chmod +x "$HELPER"; say "restored the exec bit on node-pty's spawn-helper"; }

[ -x SwarmEye.command ] || chmod +x SwarmEye.command
say "ready — run npm start, or double-click SwarmEye.command"
