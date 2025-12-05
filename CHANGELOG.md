# Changelog

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

