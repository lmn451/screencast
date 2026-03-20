# CaptureCast

Privacy-focused screen recording extension for Chromium browsers.

## Features

- Record any tab, window, or entire screen
- No server uploads - everything stays local
- Uses IndexedDB for storage
- Supports VP8 codec for reliable recording

## Quick Start

1. Open `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the project root folder

## Development

```bash
# Install dependencies
pnpm install

# Build extension
pnpm build:sw

# Run E2E tests
pnpm e2e:record
```

## Architecture

CaptureCast uses **Manifest V2** with a persistent background page for reliable recording.

### Key Files

- `manifest.json` - Extension manifest (MV2)
- `background.js` - Background page with recording logic
- `offscreen.js` - Recording via offscreen document (if available)
- `popup.html/js` - Extension popup UI
- `preview.html/js` - Video preview page

### Recording Backends

1. **tabCapture** - Uses `chrome.tabCapture` API (preferred)
2. **getDisplayMedia** - Uses `getDisplayMedia()` for full screen capture
3. **CDP Screencast** - Uses Chrome DevTools Protocol (background page only)

### Testing

E2E tests use Playwright with SwiftShader for reliable video capture:

```bash
# Run recording tests
pnpm e2e:record

# Run specific test
npx playwright test tests/e2e/record-and-save/google-test.spec.ts
```

## Permissions

- `tabCapture` - Tab capture without picker
- `activeTab` - Access current tab
- `scripting` - Inject overlay
- `tabs` - Tab management
- `<all_urls>` - Required for tabCapture

## License

MIT
