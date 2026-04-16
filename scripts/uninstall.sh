#!/usr/bin/env bash
# Uninstall git-atomic-commit.

set -euo pipefail

INSTALL_PATH="/usr/local/bin/git-atomic-commit"

if [ -f "$INSTALL_PATH" ]; then
  if [ -w "$INSTALL_PATH" ]; then
    rm "$INSTALL_PATH"
  else
    sudo rm "$INSTALL_PATH"
  fi
  echo "[uninstall] Removed $INSTALL_PATH"
else
  echo "[uninstall] $INSTALL_PATH not found — nothing to remove."
fi
