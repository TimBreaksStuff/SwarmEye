#!/usr/bin/env bash
# Publish this platform's built installer to a GitHub Release, so the
# in-app updater (main/update.js) has something to find. Run this once per
# platform, after that platform's `npm run dist` / `dist:mac` has produced
# a fresh artifact in dist/ — it does not build anything itself.
#
# Talks to the REST API with curl rather than the `gh` CLI: gh is not
# installed on either machine, and the token git already holds for
# github.com (osxkeychain on the Mac, whatever helper WSL uses) is the same
# credential the mirror push in publish-github.sh uses. Set GITHUB_TOKEN to
# override it.
#
# Safe to re-run: an existing release for this version is reused, and an
# asset of the same name on it is replaced.
set -euo pipefail

REPO="TimBreaksStuff/SwarmEye"
API="https://api.github.com/repos/$REPO"
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
ASSET_NAME="$(basename "$ARTIFACT")"

# the credential helper answers without a prompt; a tty is never available here
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill | sed -n 's/^password=//p')"
fi
if [ -z "$TOKEN" ]; then
  echo "publish-release: no GitHub token — set GITHUB_TOKEN, or store one with the credential helper (see scripts/publish-github.sh)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

api() { # api <method> <url> [curl args…] — writes the body to $TMP/out.json, echoes the status
  local method="$1" url="$2"; shift 2
  curl -sS -o "$TMP/out.json" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$@" "$url"
}

code="$(api GET "$API/releases/tags/$TAG")"
if [ "$code" = "404" ]; then
  # the section for this version only, without its own heading
  awk -v want="## $VERSION" '$0 == want {f=1; next} /^## /{f=0} f' CHANGELOG.md > "$TMP/notes.md"
  TAG="$TAG" node -e '
    const fs = require("fs");
    process.stdout.write(JSON.stringify({
      tag_name: process.env.TAG,
      target_commitish: "main",
      name: process.env.TAG,
      body: fs.readFileSync(process.argv[1], "utf8").trim(),
    }));
  ' "$TMP/notes.md" > "$TMP/body.json"
  code="$(api POST "$API/releases" -H 'Content-Type: application/json' -d @"$TMP/body.json")"
  if [ "$code" != "201" ]; then
    echo "publish-release: creating $TAG failed (HTTP $code)" >&2
    cat "$TMP/out.json" >&2
    exit 1
  fi
elif [ "$code" != "200" ]; then
  echo "publish-release: looking up $TAG failed (HTTP $code)" >&2
  cat "$TMP/out.json" >&2
  exit 1
fi

RELEASE_ID="$(node -p "require('$TMP/out.json').id")"
# an upload with a name the release already carries is rejected, not replaced
OLD_ASSET_ID="$(ASSET_NAME="$ASSET_NAME" node -p "(require('$TMP/out.json').assets || []).find((a) => a.name === process.env.ASSET_NAME)?.id ?? ''")"
if [ -n "$OLD_ASSET_ID" ]; then
  api DELETE "$API/releases/assets/$OLD_ASSET_ID" >/dev/null
fi

code="$(curl -sS -o "$TMP/out.json" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$ARTIFACT" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$ASSET_NAME")"
if [ "$code" != "201" ]; then
  echo "publish-release: uploading $ASSET_NAME failed (HTTP $code)" >&2
  cat "$TMP/out.json" >&2
  exit 1
fi

echo "publish-release: uploaded $ARTIFACT to $TAG — https://github.com/$REPO/releases/tag/$TAG"
