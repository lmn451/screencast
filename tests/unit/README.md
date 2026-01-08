# Unit Tests

This directory contains unit tests for CaptureCast utility modules.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Test Structure

- `logger.test.js` - Tests for centralized logging utilities
- `storage-utils.test.js` - Tests for storage quota management
- `media-recorder-utils.test.js` - Tests for MediaRecorder helper functions
- `constants.test.js` - Tests for configuration constants
- `db.test.js` - API contract tests for database operations (requires fake-indexeddb for full testing)

## Coverage

Current test coverage focuses on pure utility functions that don't require browser APIs:
- ✅ `logger.js` - 100% coverage
- ✅ `storage-utils.js` - 100% coverage
- ✅ `media-recorder-utils.js` - 100% coverage
- ✅ `constants.js` - 100% coverage
- ⚠️ `db.js` - API contract tests only (needs fake-indexeddb for full coverage)

## Adding Tests

When adding new utility functions:
1. Create a corresponding `.test.js` file
2. Mock browser APIs as needed (see `setup.js`)
3. Aim for >80% coverage
4. Test both happy paths and error cases

## Browser API Testing

Files that heavily use Chrome extension APIs are tested via E2E tests:
- `background.js`
- `popup.js`
- `recorder.js`
- `offscreen.js`
- `preview.js`
- `recordings.js`

See `tests/e2e/` for end-to-end testing with Playwright.

## Future Improvements

- [ ] Add fake-indexeddb for comprehensive db.js testing
- [ ] Add integration tests for component interactions
- [ ] Increase coverage to 90%+
- [ ] Add visual regression tests for UI components
