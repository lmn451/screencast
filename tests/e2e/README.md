# E2E Tests

Playwright end-to-end tests for CaptureCast.

## Tests

- `google-test.spec.ts` - Test Google.com with screen recording
- `yahoo-test.spec.ts` - Test Yahoo.com with screen recording

## Running Tests

```bash
# Run all tests
pnpm test

# Run specific test
pnpm test:google
pnpm test:yahoo
```

## How Recording Works

Tests use `getDisplayMedia()` with `displaySurface: 'browser'` to capture the browser viewport, then encode with VP8 codec via `MediaRecorder`. This produces reliable recordings without green screen issues.

## SwiftShader

Tests use SwiftShader (software GPU) for consistent rendering across environments.
