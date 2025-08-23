#!/usr/bin/env bash
set -euo pipefail

# Package the extension directory into a versioned zip ready for store uploads.
# The ZIP must contain manifest.json at the root and no parent folder.
# Usage: ./scripts/package.sh [source_dir]
# Default source_dir is the repo root (this directory).

SRC_DIR=${1:-.}
MANIFEST="$SRC_DIR/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest.json not found under $SRC_DIR" >&2
  exit 1
fi

VERSION=$(grep -E '"version"\s*:\s*"[0-9]+(\.[0-9]+)*"' "$MANIFEST" | sed -E 's/.*"version"\s*:\s*"([0-9]+(\.[0-9]+)*)".*/\1/')
if [[ -z "$VERSION" ]]; then
  echo "Unable to parse version from manifest.json" >&2
  exit 1
fi

OUT_DIR="dist"
PKG_NAME="capturecast-mv3-${VERSION}.zip"
mkdir -p "$OUT_DIR"

# Create a temp staging directory to control included files
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Copy required files
rsync -a --delete \
  --exclude ".git/" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "store-assets/" \
  --exclude "scripts/" \
  "$SRC_DIR/" "$STAGE/"

# Sanity check
if [[ ! -f "$STAGE/manifest.json" ]]; then
  echo "Staging failed; manifest.json missing" >&2
  exit 1
fi

# Zip contents of staging root
( cd "$STAGE" && zip -qr "${PKG_NAME}" . )

# Move package to dist
mv "$STAGE/${PKG_NAME}" "$OUT_DIR/"

echo "Package created: $OUT_DIR/${PKG_NAME}"

