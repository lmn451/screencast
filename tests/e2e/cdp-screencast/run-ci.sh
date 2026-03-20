#!/bin/bash
# CDP Screencast CI Test Runner
# Usage: ./run-ci.sh [test-file]

set -e

EXTENSION_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CI=true

echo "========================================"
echo "CaptureCast CDP Screencast CI Tests"
echo "========================================"
echo "Extension path: $EXTENSION_PATH"
echo "CI mode: $CI"
echo ""

# Check for required dependencies
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found. Please install: npm install -g pnpm"
    exit 1
fi

if ! command -v playwright &> /dev/null; then
    echo "📦 Installing Playwright..."
    pnpm add -D playwright @playwright/test
    pnpm exec playwright install chromium
fi

# Default test file
TEST_FILE="${1:-tests/e2e/cdp-screencast}"
CONFIG_FILE="tests/e2e/playwright.config.ts"

echo "🔧 Running tests..."
echo "Test file: $TEST_FILE"
echo ""

# Run with CI-specific environment
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 \
CI=true \
pnpm exec playwright test \
    "$TEST_FILE" \
    -c "$CONFIG_FILE" \
    --reporter=line \
    --timeout=60000 \
    --workers=1

echo ""
echo "========================================"
echo "✅ Tests completed"
echo "========================================"
