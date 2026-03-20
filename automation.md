# CaptureCast Automation API

CaptureCast supports two distinct recording backends:

1. **Media Capture Backend** (`tabCapture`, `displayMedia`) - Real tab/screen/window capture with audio
2. **CDP Screencast Backend** (`cdpScreencast`) - CI video artifacts via Chrome's Page.startScreencast

## Backends

### `tabCapture` (Default)

Uses `chrome.tabCapture.getMediaStreamId()` to capture tab audio/video without showing a picker. This is the only true no-gesture, no-picker capture method.

- **Audio**: Supports tab audio (with `includeSystemAudio: true`)
- **Picker**: None (silent)
- **CI Compatible**: Yes

### `displayMedia`

Uses `getDisplayMedia()` which shows the browser's native share picker.

- **Audio**: Supports system audio via `includeSystemAudio: true`
- **Picker**: Native OS picker (cannot be bypassed)
- **CI Compatible**: No (requires user gesture)

### `cdpScreencast`

Uses Chrome DevTools Protocol's `Page.startScreencast` to capture frames. This is a **video-only** backend (no audio) that paints JPEG frames from CDP into a canvas and records via `canvas.captureStream()`.

- **Audio**: None
- **Picker**: None
- **CI Compatible**: Yes (requires debugger attachment)

## Controller Page API

Open `chrome-extension://<id>/controller.html` in Playwright to control recording:

```js
const { chromium } = '@playwright/test';

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
    targetTabId: null,
  })
);

// Or use tabCapture for audio support
await page.evaluate(() =>
  chrome.runtime.sendMessage({
    type: 'CONTROLLER_START',
    backend: 'tabCapture',
    mode: 'tab',
    targetTabId: null,
  })
);

// Stop recording
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }));

// Get state
const state = await page.evaluate(
  () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve))
);
```

## Runtime Message API

Send messages via `chrome.runtime.sendMessage` from any extension page:

| Message Type            | Params                                                 | Response                                    |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `CONTROLLER_START`      | `backend`, `mode`, `targetTabId`                       | `{ ok, overlayInjected, backend }`          |
| `CONTROLLER_STOP`       | —                                                      | `{ ok }`                                    |
| `CONTROLLER_STATE`      | —                                                      | `{ status, backend, mode, recording, ... }` |
| `START`                 | `mode`, `mic`, `systemAudio`, `backend`, `targetTabId` | `{ ok, overlayInjected, backend }`          |
| `STOP`                  | —                                                      | `{ ok }`                                    |
| `GET_STATE`             | —                                                      | `{ status, backend, mode, recording, ... }` |
| `GET_LAST_RECORDING_ID` | —                                                      | `{ ok, recordingId }`                       |

### START Parameters

| Param         | Type      | Default        | Description                                             |
| ------------- | --------- | -------------- | ------------------------------------------------------- |
| `mode`        | `string`  | `'tab'`        | `'tab'`, `'screen'`, or `'window'`                      |
| `backend`     | `string`  | `'tabCapture'` | `'tabCapture'`, `'displayMedia'`, or `'cdpScreencast'`  |
| `mic`         | `boolean` | `false`        | Include microphone audio (tabCapture/displayMedia only) |
| `systemAudio` | `boolean` | `false`        | Include system audio (tabCapture/displayMedia only)     |
| `targetTabId` | `number`  | `null`         | Specific tab to record (tabCapture/cdpScreencast only)  |

## CDP Screencast Backend (cdpScreencast)

The `cdpScreencast` backend attaches Chrome debugger to the target tab and uses real CDP commands:

```js
// background.js handles this automatically via startCDPScreencast()
await chrome.debugger.attach({ tabId }, '1.3');
await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
  format: 'jpeg',
  quality: 80,
  maxWidth: 1280,
  maxHeight: 720,
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== 'Page.screencastFrame') return;

  // Paint frame to canvas in offscreen document via port
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

For control from another extension, use `chrome.runtime.sendMessage` with the extension ID:

```js
const CAPTURECAST_ID = 'your-extension-id';

chrome.runtime.sendMessage(CAPTURECAST_ID, {
  type: 'START',
  backend: 'tabCapture',
  mode: 'tab',
});
chrome.runtime.sendMessage(CAPTURECAST_ID, { type: 'STOP' });
chrome.runtime.sendMessage(CAPTURECAST_ID, { type: 'GET_LAST_RECORDING_ID' });
```

When controlled via external messages, `isAutomation` is `true` — the preview tab is **not** opened after recording stops.

## State Object

```js
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

## Recording Data

Recordings are stored in IndexedDB:

- **Database:** `CaptureCastDB` (version 3)
- **Chunks store:** `chunks` — key: `['recordingId', 'index']`
- **Metadata store:** `recordings` — key: `id`

### Chunk Record

```js
{ recordingId: string, index: number, chunk: Blob }
```

### Metadata Record

```js
{ id: string, mimeType: string, duration: number, size: number, createdAt: number, name: string }
```

## Backend Selection Guide

| Use Case                      | Backend         | Audio | Picker | CI  |
| ----------------------------- | --------------- | ----- | ------ | --- |
| Real tab recording with audio | `tabCapture`    | ✅    | None   | ✅  |
| Screen/window with picker     | `displayMedia`  | ✅    | Native | ❌  |
| CI video artifact (no audio)  | `cdpScreencast` | ❌    | None   | ✅  |

## Finding the Extension ID

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. The ID is shown on the extension card

## Playwright CI Example

```js
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
