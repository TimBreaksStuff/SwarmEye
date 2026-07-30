#!/usr/bin/env bash
# Provision SwarmEye's local speech backend: the Piper binary plus one voice,
# installed to ~/.local/share/swarmeye/tts (inside WSL on Windows, or the local
# home on macOS). Safe to re-run.
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

OS=$(uname -s)
ARCH=$(uname -m)
if [ "$OS" = "Darwin" ]; then
  FIX_CURL='xcode-select --install    # or reinstall macOS command line tools'
  case "$ARCH" in
    arm64|aarch64) ASSET=piper_macos_aarch64.tar.gz ;;
    *)             ASSET=piper_macos_x64.tar.gz ;;
  esac
else
  FIX_CURL='sudo apt update && sudo apt install -y curl'
  case "$ARCH" in
    aarch64|arm64) ASSET=piper_linux_aarch64.tar.gz ;;
    armv7l)        ASSET=piper_linux_armv7l.tar.gz ;;
    x86_64)        ASSET=piper_linux_x86_64.tar.gz ;;
    *)             need "no Piper build for $ARCH" "run SwarmEye's agents on an x86_64 or arm64 machine" ;;
  esac
fi

command -v curl >/dev/null 2>&1 || need "curl not found" "$FIX_CURL"
command -v tar >/dev/null 2>&1 || need "tar not found" "${FIX_CURL/curl/tar}"

DIR="$HOME/.local/share/swarmeye/tts"
VOICE="${1:-en_US-hfc_female-medium}"
PIPER_RELEASE=2023.11.14-2

mkdir -p "$DIR"

if [ ! -x "$DIR/piper/piper" ]; then
  echo "step: downloading the Piper engine ($ASSET)"
  curl -fL --progress-bar -o "$DIR/piper.tgz" \
    "https://github.com/rhasspy/piper/releases/download/$PIPER_RELEASE/$ASSET"
  tar xzf "$DIR/piper.tgz" -C "$DIR"
  rm -f "$DIR/piper.tgz"
fi

# en_US-hfc_female-medium -> en/en_US/hfc_female/medium/en_US-hfc_female-medium
LOCALE=${VOICE%%-*}
REST=${VOICE#*-}
SPEAKER=${REST%-*}
QUALITY=${REST##*-}
LANGUAGE=${LOCALE%%_*}

if [ "$(cat "$DIR/.voice" 2>/dev/null)" != "$VOICE" ] || [ ! -f "$DIR/voice.onnx" ]; then
  echo "step: downloading the voice '$VOICE' (~61 MB for a medium one)"
  BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main
  curl -fL --progress-bar -o "$DIR/voice.onnx" \
    "$BASE/$LANGUAGE/$LOCALE/$SPEAKER/$QUALITY/$VOICE.onnx"
  curl -fsSL -o "$DIR/voice.onnx.json" \
    "$BASE/$LANGUAGE/$LOCALE/$SPEAKER/$QUALITY/$VOICE.onnx.json"
  echo "$VOICE" > "$DIR/.voice"
fi

echo "tts ready: $DIR ($VOICE)"
