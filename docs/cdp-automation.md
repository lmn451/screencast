# Automation Guide

CaptureCast supports two distinct recording backends for automation:

1. **Media Capture Backend** (`tabCapture`, `displayMedia`) - Real tab/screen/window capture with audio
2. **CDP Screencast Backend** (`cdpScreencast`) - CI video artifacts via Chrome's Page.startScreencast

## Architecture

```
Controller Page (controller.html)
    │
    ├── chrome.runtime.sendMessage ─────────────────┐
    │    CONTROLLER_START/STOP/STATE                │
    │                                               │
    └──────────────────────┐                        │
                           ▼                        │
                  Background Service Worker         │
                           │                        │
        ┌──────────────────┼──────────────────┐     │
        ▼                  ▼                  ▼     │
   tabCapture        displayMedia      cdpScreencast
        │                  │                  │
        │                  │                  ├── chrome.debugger.attach
        │                  │                  ├── Page.startScreencast
        │                  │                  └── Page.screencastFrame
        ▼                  ▼                  ▼
   MediaRecorder     MediaRecorder     canvas.captureStream
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                    IndexedDB Storage
```

## Controller Page API

Open `chrome-extension://<id>/controller.html` in Playwright to control recording:

```javascript
import { chromium } from '@playwright/test';

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=/path/to/capturecast`,
    `--load-extension=/path/to/capturecast`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

const page = await context.newPage();
await page.goto('chrome-extension://<id>/controller.html');

// Start recording (cdpScreencast backend - no picker)
await page.evaluate(() =>
  chrome.runtime.sendMessage({
    type: 'CONTROLLER_START',
    backend: 'cdpScreencast',
    mode: 'tab',
  })
);

// Or use tabCapture for audio support
await page.evaluate(() =>
  chrome.runtime.sendMessage({
    type: 'CONTROLLER_START',
    backend: 'tabCapture',
    mode: 'tab',
  })
);

// Stop recording
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }));

// Get state
const state = await page.evaluate(
  () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve))
);
```

## Available Message Types

Send via `chrome.runtime.sendMessage`:

| Message Type            | Params                                                 | Response                                    |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `CONTROLLER_START`      | `backend`, `mode`, `targetTabId`                       | `{ ok, overlayInjected, backend }`          |
| `CONTROLLER_STOP`       | —                                                      | `{ ok }`                                    |
| `CONTROLLER_STATE`      | —                                                      | `{ status, backend, mode, recording, ... }` |
| `START`                 | `mode`, `mic`, `systemAudio`, `backend`, `targetTabId` | `{ ok, overlayInjected, backend }`          |
| `STOP`                  | —                                                      | `{ ok }`                                    |
| `GET_STATE`             | —                                                      | `{ status, backend, mode, recording, ... }` |
| `GET_LAST_RECORDING_ID` | —                                                      | `{ ok, recordingId }`                       |

## Backend Selection

| Backend         | Audio             | Picker | CI Compatible |
| --------------- | ----------------- | ------ | ------------- |
| `tabCapture`    | ✅ (tab audio)    | None   | ✅            |
| `displayMedia`  | ✅ (system audio) | Native | ❌            |
| `cdpScreencast` | ❌                | None   | ✅            |

## CONTROLLER_START Parameters

| Param         | Type     | Default        | Description                                            |
| ------------- | -------- | -------------- | ------------------------------------------------------ |
| `backend`     | `string` | `'tabCapture'` | `'tabCapture'`, `'displayMedia'`, or `'cdpScreencast'` |
| `mode`        | `string` | `'tab'`        | `'tab'`, `'screen'`, or `'window'`                     |
| `targetTabId` | `number` | `null`         | Specific tab to record (cdpScreencast/tabCapture only) |

## State Object

```javascript
{
  status: 'IDLE' | 'RECORDING' | 'SAVING',
  backend: 'tabCapture' | 'displayMedia' | 'cdpScreencast' | null,
  mode: 'tab' | 'screen' | 'window' | null,
  recordingId: string | null,
  recording: boolean,
  strategy: 'offscreen' | 'page' | null,
  isAutomation: boolean,
  cdpTabId: number | null,
}
```

## CDP Screencast Backend

The `cdpScreencast` backend uses Chrome DevTools Protocol's `Page.startScreencast`:

```javascript
// Background service worker handles this automatically
await chrome.debugger.attach({ tabId }, '1.3');
await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
  format: 'jpeg',
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
});

// Listen for frames
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== 'Page.screencastFrame') return;

  // Send frame to offscreen document via port
  cdpPort.postMessage({
    type: 'FRAME',
    data: params.data,
    metadata: params.metadata,
    ackId: params.sessionId,
  });

  // Acknowledge frame
  await chrome.debugger.sendCommand({ tabId }, 'Page.screencastFrameAck', {
    sessionId: params.sessionId,
  });
});
```

## External Extension API

For control from another extension:

```javascript
const CAPTURECAST_ID = 'your-extension-id';

chrome.runtime.sendMessage(CAPTURECAST_ID, {
  type: 'START',
  backend: 'tabCapture',
  mode: 'tab',
});
chrome.runtime.sendMessage(CAPTURECAST_ID, { type: 'STOP' });
chrome.runtime.sendMessage(CAPTURECAST_ID, { type: 'GET_LAST_RECORDING_ID' });
```

## Recording Data

Recordings are stored in IndexedDB:

- **Database:** `CaptureCastDB` (version 3)
- **Chunks store:** `chunks` — key: `['recordingId', 'index']`
- **Metadata store:** `recordings` — key: `id`

### Chunk Record

```javascript
{ recordingId: string, index: number, chunk: Blob }
```

### Metadata Record

```javascript
{ id: string, mimeType: string, duration: number, size: number, createdAt: number, name: string }
```

## Finding the Extension ID

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. The ID is shown on the extension card

## Playwright CI Example

```javascript
import { chromium } from '@playwright/test';

async function runCI() {
  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--disable-extensions-except=/path/to/capturecast`,
      `--load-extension=/path/to/capturecast`,
      '--use-fake-ui-for-media-stream',
    ],
  });

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = sw.url().split('/')[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/controller.html`);

  // Start CDP screencast
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'CONTROLLER_START',
      backend: 'cdpScreencast',
      mode: 'tab',
    })
  );

  // Wait for recording
  await page.waitForTimeout(5000);

  // Stop and get recording ID
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }));

  const { recordingId } = await page.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: 'GET_LAST_RECORDING_ID' }, resolve)
      )
  );

  console.log('Recording ID:', recordingId);
}
```

## Troubleshooting

### "Extension has not been invoked for the current page"

This is the `isTrusted` issue. `tabCapture` requires a genuine user gesture. Use `cdpScreencast` backend instead for CI.

### CDP Screencast not capturing frames

Ensure:

- The extension has `debugger` permission
- The tab is accessible (not restricted chrome:// page)
- `Page.startScreencast` succeeded

### Browser closes unexpectedly during test

Ensure auto-select flags are set when using displayMedia:

```
--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --auto-select-desktop-capture-source=Entire screen
```
