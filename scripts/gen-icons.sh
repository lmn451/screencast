#!/usr/bin/env bash
set -euo pipefail

# Generate extension icons from a square source PNG.
# Usage: ./scripts/gen-icons.sh path/to/source.png

if [[ ${1:-} == "" ]]; then
  echo "Usage: $0 path/to/source.png" >&2
  exit 1
fi

SRC="$1"
OUT_DIR="icons"
mkdir -p "$OUT_DIR"

has_convert() { command -v convert >/dev/null 2>&1; }
has_sips() { command -v sips >/dev/null 2>&1; }

resize_with_convert() {
  local size="$1"; local in="$2"; local out="$3"
  convert "$in" -resize ${size}x${size} "$out"
}

resize_with_sips() {
  local size="$1"; local in="$2"; local out="$3"
  # sips expects height first, then width with -z
  sips -s format png -z "$size" "$size" "$in" --out "$out" >/dev/null
}

sizes=(16 32 48 128 256)

if has_convert; then
  for s in "${sizes[@]}"; do
    resize_with_convert "$s" "$SRC" "$OUT_DIR/icon-${s}.png"
  done
elif has_sips; then
  echo "'convert' not found; using macOS 'sips' instead"
  for s in "${sizes[@]}"; do
    resize_with_sips "$s" "$SRC" "$OUT_DIR/icon-${s}.png"
  done
else
  echo "Neither ImageMagick 'convert' nor macOS 'sips' is available. Install ImageMagick (brew install imagemagick) or run on macOS with sips." >&2
  exit 1
fi

echo "Generated icons in $OUT_DIR/"

