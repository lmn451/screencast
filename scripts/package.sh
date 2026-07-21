#!/usr/bin/env bash
set -euo pipefail

# Package the extension into a versioned, deterministic ZIP ready for store uploads.
# Uses Python's standard-library zipfile module, so system zip/unzip binaries are not required.
#
# Usage:
#   pnpm run build && ./scripts/package.sh
#
# Output: dist/capturecast-mv3-<version>.zip

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$REPO_ROOT/scripts/package.py"
