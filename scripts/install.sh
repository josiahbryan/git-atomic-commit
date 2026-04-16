#!/usr/bin/env bash
# Install git-atomic-commit from a local build.
# Usage: bash scripts/install.sh
#
# Expects dist/git-atomic-commit to exist (run `bun run build` first).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY="$PROJECT_DIR/dist/git-atomic-commit"
INSTALL_DIR="/usr/local/bin"
INSTALL_PATH="$INSTALL_DIR/git-atomic-commit"

if [ ! -f "$BINARY" ]; then
  echo "[install] Binary not found at $BINARY"
  echo "[install] Run 'bun run build' first."
  exit 1
fi

# Install
if [ -w "$INSTALL_DIR" ]; then
  cp "$BINARY" "$INSTALL_PATH"
  chmod 755 "$INSTALL_PATH"
else
  echo "[install] $INSTALL_DIR not writable, using sudo..."
  sudo cp "$BINARY" "$INSTALL_PATH"
  sudo chmod 755 "$INSTALL_PATH"
fi

echo "[install] Installed git-atomic-commit to $INSTALL_PATH"

# Verify
VERSION=$("$INSTALL_PATH" --version 2>/dev/null || true)
if [ -n "$VERSION" ]; then
  echo "[install] Version: $VERSION"
else
  echo "[install] Warning: verification failed. Check that $INSTALL_DIR is in your PATH."
fi
