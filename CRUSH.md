# CRUSH.md: Guidelines for Agentic Coding in Sceencast Extension

## Build, Lint, Test Commands

### Testing (Playwright E2E)
- Run all E2E tests: `npm run e2e`
- Run specific test suite (e.g., stop feature): `npm run e2e:stop`
- Run a single test file: `npx playwright test tests/e2e/stop/stop.spec.ts -c tests/e2e/playwright.config.ts`
- Run a single test case: `npx playwright test tests/e2e/stop/stop.spec.ts --grep 'test title pattern'`
- Config: tests/e2e/playwright.config.ts (headless: false, timeout: 90s, workers: 1)
- Install deps: `npm install`

### Build/Packaging
- Generate icons: `./scripts/gen-icons.sh source.png`
- Package extension: `./scripts/package.sh` (zips for Chrome store upload)
- No automated build; manual reload in chrome://extensions/ for dev

### Lint/Formatting
- No ESLint/Prettier configs or scripts found. Manual formatting advised.
- Use editor (e.g., VS Code) with JS/TS extensions for basic linting.

## Code Style Guidelines

### Imports
- JS files (background.js, popup.js, overlay.js): No imports; use browser APIs directly (chrome.*, window.*).
- TS files (tests): ES modules, one per line, sorted alphabetically. E.g., `import { test, expect } from '@playwright/test';`

### Formatting
- Indentation: 2 spaces
- Semicolons: Omitted (ASI relied upon)
- Line length: ~80-100 chars; wrap long lines naturally
- Whitespace: Single spaces around operators; no trailing spaces
- Braces: Same line for functions/objects: `async function foo() {`
- Comments: `//` for single-line; minimal use

### Types
- Main code: Plain JS, no explicit types/JSDoc
- Tests: Full TypeScript typing via Playwright types

### Naming Conventions
- camelCase for functions/variables/properties: `startRecording()`, `recordingId`
- UPPER_CASE for constants: `STATE`, `STORE_TTL_MS`
- Descriptive names; short vars in scopes (e.g., `res`, `tab`)

### Error Handling
- Try-catch around chrome APIs: Log warnings, ignore non-critical errors
- Return objects: `{ ok: true }` success, `{ ok: false, error: 'msg' }` failure
- User errors: `alert()` in popup
- Logging: `console.log/warn` for debug; no custom logger

### General
- Mimic existing patterns: Self-contained JS, no external libs in extension core
- Security: No secrets; follow manifest permissions
- Browser APIs: chrome.* for background/popup, injected scripts for content

This file aids agents; update as codebase evolves.