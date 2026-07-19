#!/usr/bin/env bash
# Publish an allow-listed subset of this repo (everything needed to install
# and run SwarmEye, plus the public README and its screenshot) to the public
# GitHub mirror. Internal-only files (CLAUDE.md, TODO.md, this script itself)
# never leave the Gitea repo. Safe to re-run: the mirror is a persistent
# clone at .github-mirror/, so each run adds one real commit to its own
# history instead of replacing it.
set -euo pipefail

# Push over SSH (works headless, no token); the README tells cloners to use
# HTTPS instead, since anonymous/public clones don't need an SSH key set up.
GITHUB_PUSH_URL="git@github.com:TimBreaksStuff/SwarmEye.git"
GITHUB_CLONE_URL="https://github.com/TimBreaksStuff/SwarmEye.git"
ROOT="$(git rev-parse --show-toplevel)"
MIRROR="$ROOT/.github-mirror"

cd "$ROOT"

if [ ! -d "$MIRROR/.git" ]; then
  git clone "$GITHUB_PUSH_URL" "$MIRROR"
fi

ALLOW=(
  package.json
  package-lock.json
  LICENSE
  README.md
  CHANGELOG.md
  .gitignore
  SwarmEye.bat
  SwarmEye.command
  preload.js
  main
  renderer
  scripts
  docs/README.md
  docs/images/swarmeye.png
)

# Wipe the mirror's working tree (not its .git) so anything dropped from the
# allow-list, or deleted upstream, disappears from GitHub too.
find "$MIRROR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

for path in "${ALLOW[@]}"; do
  mkdir -p "$MIRROR/$(dirname "$path")"
  cp -R "$path" "$MIRROR/$path"
done

# The mirror is what the public clones — its README should point at GitHub,
# not the private Gitea remote.
sed -i.bak "s#https://gitea.homelabproxy.duckdns.org/root/SwarmEye.git#$GITHUB_CLONE_URL#g" "$MIRROR/README.md"
rm -f "$MIRROR/README.md.bak"

# The public changelog only ever shows the 1.0.0 first-release entry —
# later versions track internal-only churn (this script, private tooling)
# that isn't meant for the public mirror. 1.0.0 is always the last (oldest)
# section in the source file, so slicing from its heading to EOF keeps this
# correct automatically as new versions get added above it.
{
  sed -n '1,3p' "$ROOT/CHANGELOG.md"
  echo
  awk '/^## 1\.0\.0 /{f=1} f' "$ROOT/CHANGELOG.md"
} > "$MIRROR/CHANGELOG.md"

cd "$MIRROR"
git add -A
if git diff --cached --quiet; then
  echo "publish-github: nothing changed"
  exit 0
fi
git commit -m "Mirror sync commits now use the source repo's real commit message"
git push origin HEAD:main
