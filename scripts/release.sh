#!/usr/bin/env bash
# Cross-compile and create a GitHub Release with binaries for all platforms.
#
# Usage: bash scripts/release.sh v1.0.0

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: bash scripts/release.sh <version>"
  echo "  e.g. bash scripts/release.sh v1.1.0"
  exit 1
fi

# Validate version format
if ! echo "$VERSION" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must match vX.Y.Z (e.g. v1.0.0)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"
SRC="$PROJECT_DIR/src/cli.ts"

echo "=== Building git-atomic-commit $VERSION ==="

# Clean dist
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Cross-compile for all targets
TARGETS=(
  "bun-darwin-arm64:git-atomic-commit-darwin-arm64"
  "bun-darwin-x64:git-atomic-commit-darwin-x64"
  "bun-linux-x64:git-atomic-commit-linux-x64"
  "bun-linux-arm64:git-atomic-commit-linux-arm64"
)

for entry in "${TARGETS[@]}"; do
  TARGET="${entry%%:*}"
  OUTPUT="${entry##*:}"
  echo "  Building $OUTPUT ($TARGET)..."
  bun build --compile --target="$TARGET" --outfile "$DIST_DIR/$OUTPUT" "$SRC"
done

echo ""
echo "=== Binaries ==="
ls -lh "$DIST_DIR"/

echo ""
echo "=== Creating GitHub Release ==="

# Tag and push
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

# Create release with all binaries
gh release create "$VERSION" \
  "$DIST_DIR"/git-atomic-commit-* \
  --title "git-atomic-commit $VERSION" \
  --notes "$(cat <<EOF
## Install

### One-liner (recommended)

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/josiahbryan/git-atomic-commit/main/scripts/install-remote.sh | bash
\`\`\`

### From source

\`\`\`bash
git clone https://github.com/josiahbryan/git-atomic-commit.git
cd git-atomic-commit
bun install && bun run build && bun run setup
\`\`\`

### Direct download

| Platform | Binary |
|----------|--------|
| macOS Apple Silicon | git-atomic-commit-darwin-arm64 |
| macOS Intel | git-atomic-commit-darwin-x64 |
| Linux x86_64 | git-atomic-commit-linux-x64 |
| Linux ARM64 | git-atomic-commit-linux-arm64 |

See [README](https://github.com/josiahbryan/git-atomic-commit#readme) for usage.
EOF
)"

echo ""
echo "=== Done! ==="
echo "Release: https://github.com/josiahbryan/git-atomic-commit/releases/tag/$VERSION"
