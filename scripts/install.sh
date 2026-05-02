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
  SUDO=""
else
  echo "[install] $INSTALL_DIR not writable, using sudo..."
  sudo cp "$BINARY" "$INSTALL_PATH"
  sudo chmod 755 "$INSTALL_PATH"
  SUDO="sudo"
fi

# macOS Gatekeeper SIGKILLs unsigned binaries on first launch (the symptom
# is exit code 137 with no output). `cp` into a system path inherits the
# `com.apple.provenance` xattr, which is what triggers the kill — and that
# attr can't be removed even with sudo. The reliable fix is to ad-hoc
# re-sign the binary in place. Bun's compile output is otherwise unsigned.
# Best-effort: if codesign isn't available or fails, warn but keep going
# so the verification step can still surface a useful error.
if [ "$(uname -s)" = "Darwin" ]; then
  if command -v codesign >/dev/null 2>&1; then
    if $SUDO codesign --force --sign - "$INSTALL_PATH" >/dev/null 2>&1; then
      echo "[install] Ad-hoc codesigned for macOS Gatekeeper."
    else
      echo "[install] Warning: ad-hoc codesign failed; binary may be killed by Gatekeeper on launch."
    fi
  fi
fi

echo "[install] Installed git-atomic-commit to $INSTALL_PATH"

# Verify
VERSION=$("$INSTALL_PATH" --version 2>/dev/null || true)
if [ -n "$VERSION" ]; then
  echo "[install] Version: $VERSION"
else
  echo "[install] Warning: $INSTALL_PATH did not run cleanly."
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "[install]   On macOS this is usually a Gatekeeper signing issue. Try:"
    echo "[install]     sudo codesign --force --sign - $INSTALL_PATH"
  else
    echo "[install]   Check that $INSTALL_DIR is in your PATH."
  fi
fi
