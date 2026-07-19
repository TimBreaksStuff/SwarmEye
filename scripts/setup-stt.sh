#!/usr/bin/env bash
# Provision SwarmEye's local dictation backend: a faster-whisper venv plus a
# Whisper model, installed to ~/.local/share/swarmeye/stt (inside WSL on
# Windows, or the local home on macOS). Safe to re-run; re-running replaces
# an older Vosk install in place.
# Usage: setup-stt.sh [model]   (default: small — multilingual, ~465 MB;
# any faster-whisper size works, e.g. "base" for slower CPUs)
set -euo pipefail

# Prereqs are reported, never installed for you — that would need sudo, and
# guessing a package manager across WSL distros goes wrong more often than it
# goes right. Each failure names the exact command to fix it.
need() {
  echo "setup-stt: $1" >&2
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
# a genuinely stripped python (some minimal images drop it). Debian's split
# python3-venv package is NOT what this catches — the ensurepip fallback below
# handles that case, which is why it's written the way it is.
python3 -c 'import venv' >/dev/null 2>&1 || need "python3 has no venv module" "$FIX_PY"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
  || need "python3 is $(python3 -c 'import platform;print(platform.python_version())'), but faster-whisper needs 3.9+" "$FIX_PY"
command -v curl >/dev/null 2>&1 || need "curl not found" "$FIX_CURL"

DIR="$HOME/.local/share/swarmeye/stt"
MODEL="${1:-small}"

mkdir -p "$DIR"
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
  curl -fsSL "$GETPIP" | "$DIR/venv/bin/python"
fi
"$DIR/venv/bin/python" -m pip uninstall -y -q vosk >/dev/null 2>&1 || true
# not --quiet: pip's own progress is the only sign of life during a multi-
# minute wheel download, and the in-app installer streams this straight into
# its log box
echo "step: installing faster-whisper"
"$DIR/venv/bin/python" -m pip install --upgrade faster-whisper

if [ ! -d "$DIR/model" ] || [ "$(cat "$DIR/model/.name" 2>/dev/null)" != "$MODEL" ]; then
  rm -rf "$DIR/model"
  echo "step: downloading whisper model '$MODEL' (~465 MB for 'small')"
  "$DIR/venv/bin/python" - "$DIR/model" "$MODEL" <<'PY'
import sys
from faster_whisper import download_model
download_model(sys.argv[2], output_dir=sys.argv[1])
PY
  echo "$MODEL" > "$DIR/model/.name"
fi

cp "$(cd "$(dirname "$0")" && pwd)/stt-stream.py" "$DIR/stt-stream.py"
echo "stt ready: $DIR"
