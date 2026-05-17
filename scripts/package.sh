#!/usr/bin/env bash
set -euo pipefail

# Package the extension into a versioned zip ready for store uploads.
# The ZIP contains manifest.json at the root and no parent folder.
#
# Usage:
#   pnpm run build && ./scripts/package.sh
#
# Output: dist/capturecast-mv3-<version>.zip
#
# Layout that ships:
#   manifest.json
#   *.html                    # popup, consent, recorder, offscreen, preview, recordings, recovery, diagnostics
#   build/*.js                # esbuild output (background, page bundles, overlay)
#   icons/                    # extension icons
#
# Everything else (src/, tests/, docs/, scripts/, store-assets/, configs,
# node_modules/, .git/) is intentionally excluded.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MANIFEST="manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest.json not found at $REPO_ROOT" >&2
  exit 1
fi

VERSION=$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+(\.[0-9]+)*)".*/\1/p' "$MANIFEST" | head -n1)
if [[ -z "$VERSION" ]]; then
  echo "Unable to parse version from manifest.json" >&2
  exit 1
fi

if [[ ! -d "build" ]] || ! ls build/*.js >/dev/null 2>&1; then
  echo "build/ is missing or empty — run 'pnpm run build' first." >&2
  exit 1
fi

OUT_DIR="dist"
PKG_NAME="capturecast-mv3-${VERSION}.zip"
mkdir -p "$OUT_DIR"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Explicit include list. Add new top-level extension assets here.
cp "$MANIFEST" "$STAGE/"
cp ./*.html "$STAGE/"
mkdir -p "$STAGE/build"
# Bundles only — strip sourcemaps from the store package.
for f in build/*.js; do
  cp "$f" "$STAGE/build/"
done
cp -R icons "$STAGE/"

if [[ ! -f "$STAGE/manifest.json" ]] || [[ ! -f "$STAGE/build/background.js" ]]; then
  echo "Staging failed; required files missing" >&2
  exit 1
fi

( cd "$STAGE" && zip -qr "${PKG_NAME}" . )
mv "$STAGE/${PKG_NAME}" "$OUT_DIR/"

echo "Package created: $OUT_DIR/${PKG_NAME}"
( cd "$OUT_DIR" && unzip -l "${PKG_NAME}" )
