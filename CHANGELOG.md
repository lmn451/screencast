# Changelog

## 0.2.2 (Unreleased)

### New Features

- Added: Storage quota checking before starting recordings
- Added: `storage-utils.js` - Storage management utilities with quota estimation
- Added: Automatic storage space validation prevents out-of-space errors

### Security

- Added: UUID format validation in preview.js to prevent malformed IDs
- Improved: Input validation across recording flow

### Performance & Stability

- Improved: Reduced stop timeout from 5 minutes to 60 seconds for better UX
- Fixed: Updated KNOWN_ISSUES.md - OOM issue documented as resolved (chunked storage already implemented in v0.2.0)

### Testing

- Added: Unit testing infrastructure with Jest
- Added: Comprehensive test suite for `logger.js` (100% coverage)
- Added: Comprehensive test suite for `storage-utils.js` (100% coverage)
- Added: Comprehensive test suite for `media-recorder-utils.js` (100% coverage)
- Added: Test suite for `constants.js`
- Added: Test placeholders and API contract tests for `db.js`
- Added: npm scripts: `test`, `test:watch`, `test:coverage`

### Developer Experience

- Added: Jest configuration with ESM support
- Added: Test setup with Chrome API mocks
- Improved: Better project documentation and issue tracking

## 0.2.1

### Improvements

- Improved: Centralized logging system with debug mode toggle
- Improved: Reduced production console output by ~90%
- Improved: Database migrations now preserve user data when possible
- Improved: Extracted shared MediaRecorder utilities to reduce code duplication
- Improved: Self-documenting constants for timeouts and configuration values
- Improved: Better error handling with consistent logging
- Added: Input validation for recording IDs (UUID format check)
- Added: Explanatory comments for complex video duration normalization logic

### Developer Experience

- Added: `logger.js` - Centralized logging with debug mode
- Added: `media-recorder-utils.js` - Shared recording utilities
- Added: `constants.js` - Configuration constants
- Refactored: Eliminated ~100 lines of duplicated code
- Improved: Code maintainability and modularity

## 0.2.0

- Fixed: Removed unnecessary `<all_urls>` host permission for better privacy
- Fixed: Removed unused `storage` permission (app uses IndexedDB only)
- Fixed: Database connections now properly closed after operations
- Fixed: Improved error handling in recorder and offscreen documents
- Fixed: Better race condition handling in stop recording flow (increased timeout to 60s)
- Fixed: Added validation for query parameters
- Fixed: Added MIME type validation for MediaRecorder
- Added: Security validation for message senders
- Added: Delete recording button in preview page
- Added: Content Security Policy for extension pages
- Added: Visual feedback on overlay Stop button (prevents multiple clicks)
- Improved: Overlay injection now returns success status
- Improved: Better cleanup of offscreen documents
- Known Issue: Large recordings (>30min) may cause OOM - see docs/KNOWN_ISSUES.md

## 0.1.0

- Initial MVP release: Screen recording via offscreen document and MediaRecorder
- Popup UI to start/stop
- In-page Stop overlay
- Preview page with Download
