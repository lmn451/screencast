# Chrome DevTools Protocol (CDP) API

CaptureCast exposes a programmatic control surface via the Chrome DevTools Protocol, allowing external applications and automation tools to start/stop recordings and query state.

## Prerequisites

The extension must be loaded and the debugger must be attached. See [Attaching the Debugger](#attaching-the-debugger) below.

## Available Commands

### `CaptureCast.start`

Starts a new recording session.

**Parameters:**

```javascript
{
  mode?: 'tab' | 'screen' | 'window',  // Recording source (default: 'tab')
  mic?: boolean,                         // Include microphone audio (default: false)
  systemAudio?: boolean,                 // Include system audio (default: false)
  silent?: boolean                       // Use silent tab capture (default: true for tab mode)
}
```

**Response:**

```javascript
{ ok: true, overlayInjected: boolean }
```

**Notes:**

- `mode: 'tab'` uses `chrome.tabCapture` for silent capture (no picker required)
- `mode: 'screen'` or `'window'` uses `getDisplayMedia` which requires user selection
- When `silent: true` and `mode: 'tab'`, capture begins immediately without a picker
- Setting `silent: false` forces the picker even for tab mode

### `CaptureCast.stop`

Stops the active recording session.

**Response:**

```javascript
{
  ok: true;
}
```

**Notes:**

- The recording is saved to IndexedDB (`CaptureCastDB` database, `chunks` object store)
- No preview tab is opened when controlled via CDP

### `CaptureCast.getState`

Returns the current recording state.

**Response:**

```javascript
{
  status: 'IDLE' | 'RECORDING' | 'SAVING',
  mode: string | null,
  recordingId: string | null,
  recording: boolean,  // Convenience: true if RECORDING or SAVING
  isAutomation: boolean,
  silentMode: boolean,
  // ... other state fields
}
```

### `CaptureCast.getLastRecordingId`

Returns the ID of the most recently completed recording.

**Response:**

```javascript
{ ok: true, recordingId: string | null }
```

---

## Attaching the Debugger

Before using CDP commands, you must attach the debugger to the extension.

```javascript
const EXTENSION_ID = 'your-extension-id-here';

// Attach to the extension
await chrome.debugger.attach({ tabId: undefined }, '1.3');

// Now you can send commands
chrome.debugger.sendCommand({ tabId: undefined }, 'CaptureCast.start', {
  mode: 'tab',
  silent: true,
});
```

**Notes:**

- `tabId: undefined` targets the extension's service worker background context
- A browser prompt will appear requesting permission to attach
- The debugger must be attached before sending any commands

---

## Example: Full Recording Workflow

```javascript
const EXTENSION_ID = 'your-extension-id-here';

async function recordWithCaptureCast() {
  // 1. Attach debugger
  await chrome.debugger.attach({ tabId: undefined }, '1.3');
  console.log('Debugger attached');

  // 2. Start recording (silent tab capture)
  await chrome.debugger.sendCommand({ tabId: undefined }, 'CaptureCast.start', {
    mode: 'tab',
    silent: true,
  });
  console.log('Recording started');

  // 3. Wait for recording duration
  await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 seconds

  // 4. Stop recording
  await chrome.debugger.sendCommand({ tabId: undefined }, 'CaptureCast.stop');
  console.log('Recording stopped');

  // 5. Get recording ID
  const { result } = await chrome.debugger.sendCommand(
    { tabId: undefined },
    'CaptureCast.getLastRecordingId'
  );
  const recordingId = result.recordingId;
  console.log('Recording ID:', recordingId);

  // 6. Read recording from IndexedDB
  // (Use a library like idb or raw IndexedDB API)
  // Database: 'CaptureCastDB'
  // Store: 'chunks'
  // Schema: { recordingId: string, index: number, chunk: Blob }

  return recordingId;
}
```

---

## IndexedDB Schema

After stopping, the recording chunks are stored in:

- **Database:** `CaptureCastDB`
- **Version:** 3
- **Object Store:** `chunks`
- **Key:** `['recordingId', 'index']` (compound)
- **Index:** `recordingId` (for filtering)

**Record structure:**

```javascript
{
  recordingId: string,  // UUID of the recording
  index: number,        // Chunk order (0, 1, 2, ...)
  chunk: Blob          // Video data chunk (video/webm)
}
```

**Metadata is stored in:**

- **Object Store:** `recordings`
- **Key:** `id`
- **Fields:** `id`, `mimeType`, `duration`, `size`, `createdAt`, `name`

---

## Message Passing Alternative

For simpler integrations, you can use `chrome.runtime.sendMessage` instead of CDP:

```javascript
const EXTENSION_ID = 'your-extension-id-here';

// START
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: 'START',
  mode: 'tab',
  silent: true,
});

// STOP
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: 'STOP',
});

// GET LAST RECORDING ID
chrome.runtime.sendMessage(EXTENSION_ID, {
  type: 'GET_LAST_RECORDING_ID',
});
```

---

## Finding Your Extension ID

The extension ID can be found:

1. Open `chrome://extensions`
2. Find CaptureCast in the list
3. The ID is shown at the bottom of the extension card (e.g., `abcdefghijklmnopqrstuvwxyzabcdef`)

For stable IDs across installations, publish the extension to the Chrome Web Store.
