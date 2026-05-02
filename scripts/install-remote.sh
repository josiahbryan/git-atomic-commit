#!/usr/bin/env bash
# One-liner installer for git-atomic-commit.
# Downloads the latest pre-compiled binary from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/josiahbryan/git-atomic-commit/main/scripts/install-remote.sh | bash

set -euo pipefail

REPO="josiahbryan/git-atomic-commit"
INSTALL_DIR="/usr/local/bin"
INSTALL_PATH="$INSTALL_DIR/git-atomic-commit"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux" ;;
  *)
    echo "[install] Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *)
    echo "[install] Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

BINARY_NAME="git-atomic-commit-${PLATFORM}-${ARCH}"
echo "[install] Detected platform: ${PLATFORM}-${ARCH}"

# Get latest release tag
echo "[install] Fetching latest release..."
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*: *"//;s/".*//')

if [ -z "$TAG" ]; then
  echo "[install] Error: could not determine latest release."
  echo "[install] Check https://github.com/${REPO}/releases"
  exit 1
fi

echo "[install] Latest release: $TAG"

# Download binary
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY_NAME}"
echo "[install] Downloading ${BINARY_NAME}..."

TMPFILE=$(mktemp)
HTTP_CODE=$(curl -fsSL -w "%{http_code}" -o "$TMPFILE" "$DOWNLOAD_URL" 2>/dev/null || true)

if [ "$HTTP_CODE" != "200" ] || [ ! -s "$TMPFILE" ]; then
  rm -f "$TMPFILE"
  echo "[install] Error: download failed (HTTP $HTTP_CODE)"
  echo "[install] URL: $DOWNLOAD_URL"
  echo "[install] Check https://github.com/${REPO}/releases for available binaries."
  exit 1
fi

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "$INSTALL_PATH"
  chmod 755 "$INSTALL_PATH"
  SUDO=""
else
  echo "[install] $INSTALL_DIR not writable, using sudo..."
  sudo mv "$TMPFILE" "$INSTALL_PATH"
  sudo chmod 755 "$INSTALL_PATH"
  SUDO="sudo"
fi

# macOS Gatekeeper SIGKILLs unsigned binaries on first launch (the symptom
# is exit code 137 with no output). Files downloaded by curl carry
# `com.apple.quarantine`, and a move into a system path also inherits
# `com.apple.provenance` — both can trigger the kill. Ad-hoc re-signing
# stamps a stable cdhash that bypasses the check; this is what `brew`
# does for unsigned bottles. Best-effort: if codesign isn't available or
# fails, warn but keep going so the verification step can still surface
# a useful error.
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
  echo "[install] Done! Run 'git-atomic-commit --help' to get started."
else
  echo "[install] Warning: $INSTALL_PATH did not run cleanly."
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "[install]   On macOS this is usually a Gatekeeper signing issue. Try:"
    echo "[install]     sudo codesign --force --sign - $INSTALL_PATH"
  else
    echo "[install]   Check that $INSTALL_DIR is in your PATH."
  fi
fi
