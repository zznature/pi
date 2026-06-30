#!/usr/bin/env bash
set -euo pipefail

# Run pi agent; this wrapper only controls the launch path and system prompt source.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPEND_SYSTEM_PATH="$SCRIPT_DIR/.pi/APPEND_SYSTEM.md"
TSX_PATH="$SCRIPT_DIR/node_modules/.bin/tsx"
CLI_PATH="$SCRIPT_DIR/packages/coding-agent/src/cli.ts"

if [[ ! -f "$APPEND_SYSTEM_PATH" ]]; then
  echo "Missing append system prompt: $APPEND_SYSTEM_PATH" >&2
  exit 1
fi

if [[ ! -f "$TSX_PATH" ]]; then
  echo "Missing local tsx executable: $TSX_PATH" >&2
  echo "Run npm install --ignore-scripts from the repo root first." >&2
  exit 1
fi

exec "$TSX_PATH" \
  --tsconfig "$SCRIPT_DIR/tsconfig.json" \
  "$CLI_PATH" \
  --no-context-files \
  --append-system-prompt "$APPEND_SYSTEM_PATH" \
  "$@"
