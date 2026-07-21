#!/usr/bin/env bash
# Publish this platform's built installer to a GitHub Release, so the
# in-app updater (main/update.js) has something to find. Run this once per
# platform, after that platform's `npm run dist` / `dist:mac` has produced
# a fresh artifact in dist/ — it does not build anything itself.
#
# Safe to re-run: if the release for this version already exists (e.g. the
# other platform published first), the asset is just uploaded/replaced on
# it instead of failing.
set -euo pipefail

REPO="TimBreaksStuff/SwarmEye"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

ARTIFACT=""
for candidate in dist/SwarmEye-portable.exe dist/SwarmEye-mac.zip; do
  if [ -f "$candidate" ]; then
    ARTIFACT="$candidate"
    break
  fi
done

if [ -z "$ARTIFACT" ]; then
  echo "publish-release: no dist/SwarmEye-portable.exe or dist/SwarmEye-mac.zip found — run npm run dist (or dist:mac) first" >&2
  exit 1
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$ARTIFACT" --repo "$REPO" --clobber
else
  NOTES="$(awk -v tag="## $VERSION " 'index($0, tag) == 1 {f=1; next} /^## /{f=0} f' CHANGELOG.md)"
  gh release create "$TAG" "$ARTIFACT" --repo "$REPO" --title "$TAG" --notes "$NOTES"
fi

echo "publish-release: uploaded $ARTIFACT to $TAG"
