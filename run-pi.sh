#!/usr/bin/env bash
# pi-agent wrapper — disables root AGENTS.md (Codex 专用) so pi only uses .pi/APPEND_SYSTEM.md
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if command -v pi &>/dev/null; then
    exec pi -nc "$@"
elif [ -f "$SCRIPT_DIR/packages/coding-agent/dist/cli.js" ]; then
    exec node "$SCRIPT_DIR/packages/coding-agent/dist/cli.js" -nc "$@"
else
    echo "pi not found. Install via npm link or build coding-agent first." >&2
    exit 1
fi
