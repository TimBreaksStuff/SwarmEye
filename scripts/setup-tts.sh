#!/usr/bin/env bash
# Provision SwarmEye's local speech backend: a Piper venv plus one voice,
# installed to ~/.local/share/swarmeye/tts (inside WSL on Windows, or the local
# home on macOS). Safe to re-run; re-running replaces an older tarball install
# in place.
# Usage: setup-tts.sh [voice]   (default: en_US-hfc_female-medium, ~61 MB; any
# voice from https://huggingface.co/rhasspy/piper-voices works, e.g.
# "en_GB-alba-medium")
set -euo pipefail

# Prereqs are reported, never installed for you — same rule as setup-stt.sh:
# guessing a package manager across WSL distros goes wrong more often than it
# goes right. Each failure names the exact command to fix it.
need() {
  echo "setup-tts: $1" >&2
  echo "fix: $2" >&2
  exit 1
}

if [ "$(uname -s)" = "Darwin" ]; then
  FIX_PY='xcode-select --install    # Apple ships python3 with the command line tools'
  FIX_CURL='xcode-select --install    # or reinstall macOS command line tools'
else
  FIX_PY='sudo apt update && sudo apt install -y python3 python3-venv'
  FIX_CURL='sudo apt update && sudo apt install -y curl'
fi

command -v python3 >/dev/null 2>&1 || need "python3 not found" "$FIX_PY"
python3 -c 'import venv' >/dev/null 2>&1 || need "python3 has no venv module" "$FIX_PY"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
  || need "python3 is $(python3 -c 'import platform;print(platform.python_version())'), but piper-tts needs 3.9+" "$FIX_PY"
command -v curl >/dev/null 2>&1 || need "curl not found" "$FIX_CURL"

DIR="$HOME/.local/share/swarmeye/tts"
VOICE="${1:-en_US-hfc_female-medium}"

mkdir -p "$DIR"

# The old rhasspy/piper 2023.11 tarballs are gone: the macOS aarch64 asset ships
# an x86_64 binary, and neither macOS asset contains the dylibs that binary
# links against — so it could never run on an Apple Silicon Mac. piper-tts on
# PyPI is the maintained build and has real wheels for every platform we target.
rm -rf "$DIR/piper"

echo "step: creating venv"
# Prefer ensurepip. Debian splits it into python3-venv, and there may be no
# root to apt-install it — so fall back to --without-pip + get-pip.py there.
if [ ! -x "$DIR/venv/bin/python" ]; then
  if python3 -c 'import ensurepip' >/dev/null 2>&1; then
    python3 -m venv "$DIR/venv"
  else
    python3 -m venv --without-pip "$DIR/venv"
  fi
fi
if ! "$DIR/venv/bin/python" -m pip --version >/dev/null 2>&1; then
  # get-pip.py's default URL dropped everything below 3.10, which includes the
  # python3 macOS ships (3.9) — those need the version-pinned copy instead
  PYMM=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  case "$PYMM" in
    3.9) GETPIP="https://bootstrap.pypa.io/pip/$PYMM/get-pip.py" ;;
    *)   GETPIP="https://bootstrap.pypa.io/get-pip.py" ;;
  esac
  # every curl here is bounded: a stall would otherwise hang the in-app
  # installer forever, and its one-install-at-a-time lock with it
  curl -fsSL --retry 3 --max-time 120 "$GETPIP" | "$DIR/venv/bin/python"
fi
# not --quiet: pip's own progress is the only sign of life during a multi-
# minute wheel download, and the in-app installer streams this straight into
# its log box
echo "step: installing piper-tts"
"$DIR/venv/bin/python" -m pip install --upgrade piper-tts

# en_US-hfc_female-medium -> en/en_US/hfc_female/medium/en_US-hfc_female-medium
LOCALE=${VOICE%%-*}
REST=${VOICE#*-}
SPEAKER=${REST%-*}
QUALITY=${REST##*-}
LANGUAGE=${LOCALE%%_*}

if [ "$(cat "$DIR/.voice" 2>/dev/null)" != "$VOICE" ] || [ ! -f "$DIR/voice.onnx" ]; then
  echo "step: downloading the voice '$VOICE' (~61 MB for a medium one)"
  BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main
  # download beside the real names and move into place only once both halves
  # have landed: main/speech.js's install check is "voice.onnx exists", so a
  # half-written file would report TTS installed and then say nothing at all
  curl -fL --progress-bar --retry 3 --max-time 900 -o "$DIR/voice.onnx.part" \
    "$BASE/$LANGUAGE/$LOCALE/$SPEAKER/$QUALITY/$VOICE.onnx"
  curl -fsSL --retry 3 --max-time 60 -o "$DIR/voice.onnx.json.part" \
    "$BASE/$LANGUAGE/$LOCALE/$SPEAKER/$QUALITY/$VOICE.onnx.json"
  mv "$DIR/voice.onnx.part" "$DIR/voice.onnx"
  mv "$DIR/voice.onnx.json.part" "$DIR/voice.onnx.json"
  echo "$VOICE" > "$DIR/.voice"
fi

echo "tts ready: $DIR ($VOICE)"
