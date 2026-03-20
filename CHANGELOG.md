# Changelog

## 0.3.0

### Breaking Changes

- **Downgraded to Manifest V2** - Changed from MV3 to MV2 for reliable background page
- Uses persistent background page instead of service worker

### Bug Fixes

- **Fixed green screen issue** - Screen recording now captures actual browser content
- Uses `getDisplayMedia()` with `displaySurface: 'browser'` for proper capture
- Added SwiftShader for software GPU rendering

### Testing

- Added E2E tests for Google.com and Yahoo.com with working video recording
- Tests use canvas + VP8 codec for reliable recording

## 0.2.2

### New Features

- Added: Storage quota checking before starting recordings
- Added: `storage-utils.js` - Storage management utilities with quota estimation
- Added: Automatic storage space validation prevents out-of-space errors

### Security

- Added: UUID format validation in preview.js to prevent malformed IDs
- Improved: Input validation across recording flow

### Performance & Stability

- Improved: Reduced stop timeout from 5 minutes to 60 seconds for better UX
- Fixed: Chunked storage prevents OOM for large recordings

## 0.2.1

### Improvements

- Improved: Centralized logging system with debug mode toggle
- Improved: Reduced production console output by ~90%
- Improved: Database migrations now preserve user data when possible
- Improved: Extracted shared MediaRecorder utilities to reduce code duplication

## 0.2.0

- Fixed: Removed unnecessary `<all_urls>` host permission
- Fixed: Database connections now properly closed
- Fixed: Better race condition handling in stop recording flow
- Added: Delete recording button in preview page
- Added: Content Security Policy for extension pages

## 0.1.0

- Initial MVP release
