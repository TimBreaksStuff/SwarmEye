#!/bin/zsh
# Double-click launcher for SwarmEye (macOS). Repairs a half-finished install
# before launching, so a fresh clone starts by double-clicking this file.
cd "$(dirname "$0")" || exit 1
bash scripts/setup-mac.sh --check >/dev/null 2>&1 || bash scripts/setup-mac.sh || exit 1
npm start
