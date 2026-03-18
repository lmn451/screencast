# E2E Tests

This directory contains Playwright end-to-end tests for the extension.

## Test Categories

- Default CI-safe suite: non-interactive tests that stay on the tab-capture path
- Manual picker suite: tests that intentionally exercise `getDisplayMedia()` and require user input

## Why The Split Exists

Chromium's native screen-sharing picker is shown whenever the extension uses
`navigator.mediaDevices.getDisplayMedia()` for `screen` or `window` capture.
That picker is not treated as a normal app dialog in CI, so those scenarios are
kept out of the default automated suite.

For CI, the supported real-capture path is silent tab capture via
`chrome.tabCapture`.

## Running Tests

```bash
# Default non-interactive suite
npm run e2e

# Picker-dependent tests for local/manual verification
npm run e2e:manual
```

## Naming Convention

- Use `@manual-picker` in the test title for scenarios that require a real browser picker
- Leave CI-safe tests untagged so they remain part of the default suite

## Guidance For New Tests

- Prefer `mode: 'tab'` for CI coverage
- Use `mode: 'screen'` or `mode: 'window'` only for manual/local coverage
- If a test can fall back to `getDisplayMedia()`, treat it as picker-dependent
