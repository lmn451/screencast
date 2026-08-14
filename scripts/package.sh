#!/usr/bin/env bash
set -euo pipefail

# Package the extension into a versioned zip ready for store uploads.
# The ZIP contains manifest.json at the root and no parent folder.
#
# Usage:
#   pnpm run package          # Chrome Web Store package
#   pnpm run package:firefox  # Firefox Add-ons package
#   pnpm run package:all      # Chrome, Firefox, and Firefox review source
#
# Output:
#   dist/screensilo-mv3-<version>.zip
#   dist/screensilo-firefox-mv3-<version>.zip
#   dist/screensilo-firefox-source-<version>.zip (created by package-source.sh)
#
# Layout that ships:
#   manifest.json
#   *.html                    # production extension pages
#   build/*.js                # esbuild output (background, page bundles, overlay)
#   icons/                    # manifest icon sizes
#
# Everything else (src/, tests/, docs/, scripts/, store-assets/, configs,
# node_modules/, .git/) is intentionally excluded.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-chrome}"
case "$TARGET" in
  chrome)
    MANIFEST="manifest.json"
    PACKAGE_PREFIX="screensilo-mv3"
    ;;
  firefox)
    MANIFEST="manifest.firefox.json"
    PACKAGE_PREFIX="screensilo-firefox-mv3"
    ;;
  *)
    echo "Unknown package target: $TARGET (expected chrome or firefox)" >&2
    exit 1
    ;;
esac

if [[ ! -f "$MANIFEST" ]]; then
  echo "$MANIFEST not found at $REPO_ROOT" >&2
  exit 1
fi

VERSION=$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+(\.[0-9]+)*)".*/\1/p' "$MANIFEST" | head -n1)
if [[ -z "$VERSION" ]]; then
  echo "Unable to parse version from manifest.json" >&2
  exit 1
fi

PACKAGE_VERSION=$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+(\.[0-9]+)*)".*/\1/p' package.json | head -n1)
if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
  echo "Version mismatch: manifest.json=$VERSION package.json=$PACKAGE_VERSION" >&2
  exit 1
fi

if [[ ! -d "build" ]] || ! ls build/*.js >/dev/null 2>&1; then
  echo "build/ is missing or empty — run 'pnpm run build' first." >&2
  exit 1
fi

OUT_DIR="dist"
PKG_NAME="${PACKAGE_PREFIX}-${VERSION}.zip"
mkdir -p "$OUT_DIR"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Explicit include list. Add new top-level extension assets here.
cp "$MANIFEST" "$STAGE/manifest.json"
HTML_PAGES=(
  popup
  consent
  recorder
  preview
  recordings
  recovery
  diagnostics
)
if [[ "$TARGET" == "chrome" ]]; then
  HTML_PAGES+=(offscreen)
fi
for page in "${HTML_PAGES[@]}"; do
  source_file="${page}.html"
  if [[ ! -f "$source_file" ]]; then
    echo "Missing production page: $source_file" >&2
    exit 1
  fi
  cp "$source_file" "$STAGE/"
done
mkdir -p "$STAGE/build"
# Production bundles only — strip sourcemaps and reject stale development
# output by using an explicit allowlist instead of a build/*.js glob.
BUNDLES=(
  background
  popup
  consent
  recorder
  preview
  recordings
  recovery
  diagnostics
  overlay
)
if [[ "$TARGET" == "chrome" ]]; then
  BUNDLES+=(offscreen)
fi
for bundle in "${BUNDLES[@]}"; do
  source_file="build/${bundle}.js"
  if [[ ! -f "$source_file" ]]; then
    echo "Missing production bundle: $source_file" >&2
    exit 1
  fi
  cp "$source_file" "$STAGE/build/"
done
mkdir -p "$STAGE/icons"
for size in 16 32 48 128; do
  source_file="icons/icon-${size}.png"
  if [[ ! -f "$source_file" ]]; then
    echo "Missing manifest icon: $source_file" >&2
    exit 1
  fi
  cp "$source_file" "$STAGE/icons/"
done

if [[ ! -f "$STAGE/manifest.json" ]] || [[ ! -f "$STAGE/build/background.js" ]]; then
  echo "Staging failed; required files missing" >&2
  exit 1
fi

( cd "$STAGE" && zip -qr "${PKG_NAME}" . )
mv "$STAGE/${PKG_NAME}" "$OUT_DIR/"

echo "Package created: $OUT_DIR/${PKG_NAME}"
( cd "$OUT_DIR" && unzip -l "${PKG_NAME}" )
