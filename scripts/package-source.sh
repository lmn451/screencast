#!/usr/bin/env bash
set -euo pipefail

# Create the human-readable source archive supplied to Firefox Add-ons review.
# Generated bundles, store assets, logs, local tooling, tests, and unrelated
# worktree files are excluded through this explicit allowlist.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION=$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+(\.[0-9]+)*)".*/\1/p' manifest.firefox.json | head -n1)
if [[ -z "$VERSION" ]]; then
  echo "Unable to parse version from manifest.firefox.json" >&2
  exit 1
fi

OUT_DIR="dist"
ARCHIVE_NAME="screensilo-firefox-source-${VERSION}.zip"
mkdir -p "$OUT_DIR"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

ROOT_FILES=(
  SOURCE_BUILD.md
  LICENSE
  package.json
  pnpm-lock.yaml
  tsconfig.json
  esbuild.config.js
  manifest.json
  manifest.firefox.json
  popup.html
  consent.html
  recorder.html
  offscreen.html
  preview.html
  recordings.html
  recovery.html
  diagnostics.html
)

for source_file in "${ROOT_FILES[@]}"; do
  if [[ ! -f "$source_file" ]]; then
    echo "Missing source-build file: $source_file" >&2
    exit 1
  fi
  cp "$source_file" "$STAGE/"
done

cp -R src "$STAGE/src"
cp -R icons "$STAGE/icons"
mkdir -p "$STAGE/scripts"
cp scripts/package.sh scripts/package-source.sh "$STAGE/scripts/"

(cd "$STAGE" && zip -qr "$ARCHIVE_NAME" .)
mv "$STAGE/$ARCHIVE_NAME" "$OUT_DIR/"

echo "Source package created: $OUT_DIR/$ARCHIVE_NAME"
(cd "$OUT_DIR" && unzip -l "$ARCHIVE_NAME")
