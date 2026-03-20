# CI/CDP Testing Plan for CaptureCast

## Overview

This plan outlines how to implement automated E2E tests for CaptureCast using Playwright/Puppeteer with Chrome DevTools Protocol (CDP) integration.

## Key Challenges & Solutions

### Challenge 1: User Gesture Requirement

**Problem**: Browser security requires user click to start `getDisplayMedia()`. In CI, there's no user to click.

**Solution**: We use **tab capture**, NOT screen capture!

```
┌─────────────────────────────────────────────────────────────┐
│  For TAB Recording (our use case):                         │
│                                                             │
│  1. chrome.tabCapture.getMediaStreamId()                    │
│     └── Captures TAB directly, no picker needed ✅         │
│                                                             │
│  2. Page.startScreencast (CDP)                              │
│     └── Captures TAB via debugger, no picker needed ✅     │
│                                                             │
│  Chrome Flags (for tab capture - NOT screen capture):       │
│  ─────────────────────────────────────────────────────      │
│  --use-fake-ui-for-media-stream     # Fake device for tests │
│  --use-fake-device-for-media-stream # Allows fake media      │
│                                                             │
│  ❌ NO --auto-select-desktop-capture-source needed!        │
│     (That's only for getDisplayMedia which we don't use)    │
└─────────────────────────────────────────────────────────────┘
```

**Status**: ✅ Solved - using tabCapture/cdpScreencast, no picker needed

---

### Challenge 2: Manifest V3 Service Workers

**Problem**: MV3 uses Service Workers, which have no DOM access → no MediaRecorder API.

**Solution**: Use `chrome.offscreen` API to create hidden document with DOM access:

```
┌─────────────────┐      Message       ┌────────────────────┐
│ Service Worker  │ ──────────────────► │  Offscreen Document │
│ (background.js) │                    │  (offscreen.html)   │
│                 │                    │                     │
│ - No DOM        │ ◄───────────────── │  - Has DOM          │
│ - No MediaRecorder│    Response     │  - Has MediaRecorder│
└─────────────────┘                    └────────────────────┘
```

**Status**: ✅ Solved - `offscreen.js` already handles this

---

### Challenge 3: CSP of Target Site

**Problem**: Target websites may have strict Content-Security-Policy blocking blobs/media.

**Solution**: Extension runs in isolated context with `host_permissions: ["<all_urls>"]`

**Status**: ✅ Solved - already in manifest.json

---

### Challenge 4: Green Screen in Recording

**Problem**: Green screen in recorded video = **GPU encoder failure**. Chrome tries to use GPU for video encoding (VP9/H.264), but in CI/Docker/headless there's no GPU. The encoder fails silently, outputs empty buffer → green color in YUV→RGB conversion.

**Solution**: Disable GPU acceleration, force software encoding:

```javascript
// In fixtures.ts - disable ALL GPU acceleration
args: [
  '--disable-gpu',                    // Base GPU disable
  '--disable-accelerated-video-decode', // Disable hardware decode
  '--disable-accelerated-video-encode', // Disable hardware encode (KEY!)
  '--disable-software-rasterizer',    // Prevent rendering conflicts
]
```

**Also**: Use VP8 codec in MediaRecorder (most reliable software codec):

```javascript
// In media-recorder-utils.js or offscreen.js
const mimeType = 'video/webm;codecs=vp8'; // NOT vp9, not av1
const recorder = new MediaRecorder(stream, { mimeType });
```

**Background tab throttling** (prevents green/black screen on inactive tabs):

```javascript
args: [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', 
  '--disable-renderer-backgrounding',
]
```

**Status**: ✅ Solved - GPU flags added to fixtures.ts

---

### Challenge 5: ES Modules in Service Workers

**Problem**: Chrome Service Workers don't reliably support ES module imports (`import {} from './module.js'`).

**Investigation Results**:
- Simple SW scripts (IIFE/no imports) work fine ✅
- ES module imports fail silently ❌
- `chrome.runtime.sendMessage` callbacks hang when ESM is used ❌

**Root Cause**: ES module imports cause SW initialization to fail or hang.

**Solution Options**:

| Option | Pros | Cons |
|--------|------|------|
| **A. Bundle for Testing** | Simple, works | Extra build step |
| **B. Inline Code** | No build needed | Code duplication |
| **C. Dynamic Imports** | Gradual migration | Still has issues |

**Recommended**: **Option A** - Bundle background.js for test environment.

---

## Implementation Plan

### Phase 1: Test Infrastructure Setup

- [ ] Add esbuild/rollup for bundling
- [ ] Create test-specific bundle of background.js
- [ ] Update fixtures.ts to use bundled version
- [ ] Add CI-specific Playwright config

### Phase 2: Basic E2E Tests

- [ ] Extension loads correctly
- [ ] Background script initializes
- [ ] Message passing works
- [ ] State management works

### Phase 3: Recording Flow Tests

- [ ] Start recording via controller
- [ ] Recording state is correct
- [ ] Stop recording works
- [ ] Recording saved to IndexedDB

### Phase 4: CDP Backend Tests

- [ ] CDP debugger attaches
- [ ] Page.startScreencast works
- [ ] Frames are captured
- [ ] Video is encoded correctly

### Phase 5: CI Integration

- [ ] GitHub Actions workflow
- [ ] Parallel test execution
- [ ] Artifact collection (recorded videos)
- [ ] Test reports

---

## Technical Architecture

### Test Runner Flow

```
┌──────────────────────────────────────────────────────────────┐
│                      Playwright Test                          │
│                                                               │
│  1. Launch browser with extension loaded                       │
│     └── chrome://extensions + --load-extension=               │
│                                                               │
│  2. Navigate to controller.html                                │
│     └── chrome-extension://<id>/controller.html               │
│                                                               │
│  3. Send commands via chrome.runtime.sendMessage              │
│     └── CONTROLLER_START, CONTROLLER_STOP, etc.              │
│                                                               │
│  4. Service Worker delegates to offscreen document             │
│     └── chrome.offscreen.createDocument()                     │
│                                                               │
│  5. Offscreen document uses MediaRecorder                     │
│     └── getUserMedia() or canvas.captureStream()             │
│                                                               │
│  6. Recording saved to IndexedDB                              │
│     └── chunks + metadata                                     │
│                                                               │
│  7. Verify recording exists in DB                             │
│     └── query IndexedDB, check blob size                      │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### File Structure

```
tests/
├── e2e/
│   ├── lib/
│   │   ├── fixtures.ts           # Playwright fixtures
│   │   └── build.ts             # Build test bundle
│   ├── cdp-screencast/
│   │   ├── basics.spec.ts       # Extension loads, SW works
│   │   ├── recording.spec.ts     # Start/stop recording
│   │   ├── offscreen.spec.ts    # Offscreen document tests
│   │   └── fixtures/             # Test fixtures
│   └── run-ci.sh                # CI runner script
│
├── build/
│   ├── background-test.js       # Bundled for tests (gitignored)
│   └── background-test.js.map   # Source map
│
├── .github/
│   └── workflows/
│       └── e2e-tests.yml        # GitHub Actions
│
└── package.json                 # Add build scripts
```

---

## Build Configuration

### esbuild config (build/background.js)

```javascript
import * as esbuild from 'esbuild';

// Bundle for test environment
await esbuild.build({
  entryPoints: ['background.js'],
  bundle: true,
  format: 'iife',           // No modules, works in SW
  outfile: 'build/background-test.js',
  minify: false,
  sourcemap: true,
  // Stub imports that don't work in SW
  define: {
    'import.meta.url': 'undefined',
  },
});
```

### Package.json scripts

```json
{
  "scripts": {
    "build:test": "node build/background.js",
    "test:e2e": "pnpm build:test && playwright test -c tests/e2e/playwright.config.ts",
    "test:e2e:ci": "CI=true pnpm test:e2e --reporter=github"
  }
}
```

---

## Test Examples

### Basic Test: Extension Loads

```typescript
test('extension loads and background initializes', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  // Verify page loaded
  await expect(page).toHaveTitle('CaptureCast Controller');
  
  // Verify background script responds
  const state = await page.evaluate(() => 
    new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
      setTimeout(() => resolve({ timeout: true }), 3000);
    })
  );
  
  expect(state).toHaveProperty('status', 'IDLE');
});
```

### Recording Test: CDP Screencast

```typescript
test('CDP screencast records frames', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  // Start recording
  await page.evaluate(() => {
    chrome.runtime.sendMessage({ 
      type: 'CONTROLLER_START', 
      backend: 'cdpScreencast' 
    });
  });
  
  // Wait for recording
  await page.waitForTimeout(2000);
  
  // Stop recording
  await page.evaluate(() => {
    chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' });
  });
  
  // Wait for save
  await page.waitForTimeout(1000);
  
  // Verify recording saved
  const { recordingId } = await page.evaluate(() => 
    new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_LAST_RECORDING_ID' }, resolve);
    })
  );
  
  expect(recordingId).toBeTruthy();
  
  // Navigate to preview to verify video
  const previewPage = await context.newPage();
  await previewPage.goto(`chrome-extension://${extensionId}/preview.html?id=${recordingId}`);
  
  // Video element should exist
  const video = previewPage.locator('#video');
  await expect(video).toBeVisible();
});
```

---

## CI Configuration

### GitHub Actions (.github/workflows/e2e-tests.yml)

```yaml
name: E2E Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          
      - name: Install dependencies
        run: pnpm install
        
      - name: Build test bundle
        run: pnpm build:test
        
      - name: Install Playwright
        run: pnpm exec playwright install chromium
        
      - name: Run E2E tests
        run: pnpm test:e2e
        env:
          CI: true
          
      - name: Upload artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results/
```

---

## Verification Checklist

Before considering this feature complete, verify:

- [ ] Extension loads in headless Chrome
- [ ] Service Worker initializes without errors
- [ ] `chrome.runtime.sendMessage` callbacks resolve
- [ ] `CONTROLLER_START` triggers recording
- [ ] `CONTROLLER_STOP` stops and saves recording
- [ ] Recording exists in IndexedDB after stop
- [ ] Recorded video plays in preview.html
- [ ] GitHub Actions workflow passes
- [ ] Tests run in < 5 minutes

---

## Resources

- [Chrome Extension Service Workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)
- [Offscreen Documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Chrome Debugger Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Playwright Extensions API](https://playwright.dev/docs/api/class-fragment)
