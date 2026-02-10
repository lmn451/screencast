# CaptureCast Architecture

## Overview

CaptureCast is a privacy-focused browser extension for screen recording built on Chrome Extension Manifest V3. All processing happens client-side with no external servers.

## Components

### 1. Background Service Worker (`background.js`)

**Role**: Central coordinator for the extension lifecycle and state management.

**Key Responsibilities**:

- Manages recording state (recording/idle, mode, IDs)
- Coordinates between popup, recorder/offscreen, and preview components
- Handles overlay injection into active tabs
- Manages badge indicators during recording
- Routes messages between components

**State Management**:

```javascript
STATE = {
  recording: boolean,
  mode: 'tab' | 'window' | 'screen',
  recordingId: string,
  overlayTabId: number,
  includeMic: boolean,
  includeSystemAudio: boolean,
  recorderTabId: number,
  strategy: 'offscreen' | 'page',
  stopTimeoutId: number,
};
```

**Recording Strategies**:

- **Offscreen Strategy**: Used when microphone is NOT needed. Creates an offscreen document to handle recording without visible UI.
- **Page Strategy**: Used when microphone IS needed (mic permission requires visible page). Opens a dedicated recorder tab.

### 2. Popup UI (`popup.html`, `popup.js`)

**Role**: User interface for starting/stopping recordings.

**Features**:

- Toggle microphone input
- Toggle system/tab audio
- Start recording button
- Stop recording button (when active)
- Shows current recording state

### 3. Offscreen Document (`offscreen.html`, `offscreen.js`)

**Role**: Hidden document for screen recording without microphone.

**Why Offscreen?**:

- `getDisplayMedia()` requires a document context
- Offscreen documents are lightweight and don't show UI
- Ideal for screen-only recording

**Process**:

1. Receives START message from background
2. Calls `getDisplayMedia()` with specified constraints
3. Sets up `MediaRecorder` with codec fallback (AV1 → VP9 → VP8)
4. Records to chunks array
5. On stop, creates Blob and saves to IndexedDB
6. Sends DATA message back to background with recording ID

### 4. Recorder Page (`recorder.html`, `recorder.js`)

**Role**: Visible page for screen recording WITH microphone.

**Why Visible Page?**:

- Microphone permission (`getUserMedia`) requires user-visible context
- Provides visual feedback during recording
- Shows preview of what's being recorded

**Process**:

1. Loads with query params (id, mode, mic, sys)
2. Requests `getDisplayMedia()` for screen
3. Requests `getUserMedia()` for microphone (if enabled)
4. Combines streams and records with `MediaRecorder`
5. Saves to IndexedDB on stop
6. Closes automatically after sending DATA message

### 5. Preview Page (`preview.html`, `preview.js`)

**Role**: Displays recorded video and provides download/delete options.

**Features**:

- Loads recording from IndexedDB by ID
- Normalizes video duration (fixes WebM metadata quirks)
- Provides download button (saves to disk)
- Provides delete button (removes from IndexedDB)

**Duration Normalization**:
WebM files from MediaRecorder often have incorrect/infinite duration metadata. The `fixDurationAndReset()` function:

1. Seeks to end of video to force metadata calculation
2. Listens for `durationchange` event
3. Resets to start when duration is known
4. Prevents UI jumps by hiding video until stable

### 6. Overlay (`overlay.js`)

**Role**: Injected content script that shows Stop button on recorded page.

**Features**:

- Minimal DOM footprint (single fixed button)
- High z-index to stay visible
- Sends STOP message when clicked
- Self-removes when recording ends

**Injection Limitations**:
Cannot inject on restricted pages:

- `chrome://` pages
- `about:` pages
- Other extension pages
- PDF viewers

In these cases, users must stop via extension icon.

### 7. Database (`db.js`)

**Role**: IndexedDB wrapper for storing recordings.

**Schema**:

```javascript
{
  id: string (UUID),
  blob: Blob (video data),
  mimeType: string,
  createdAt: number (timestamp)
}
```

**Operations**:

- `saveRecording(id, blob, mimeType)`: Store recording
- `getRecording(id)`: Retrieve recording
- `deleteRecording(id)`: Remove recording

**Connection Management**:
Connections are properly closed after each transaction to prevent memory leaks.

## Message Protocol

### Message Types

| Type                | From          | To         | Purpose                      |
| ------------------- | ------------- | ---------- | ---------------------------- |
| `START`             | Popup         | Background | Start recording with options |
| `STOP`              | Popup/Overlay | Background | Stop active recording        |
| `GET_STATE`         | Popup         | Background | Query current state          |
| `OFFSCREEN_START`   | Background    | Offscreen  | Begin offscreen recording    |
| `OFFSCREEN_STOP`    | Background    | Offscreen  | Stop offscreen recording     |
| `OFFSCREEN_STARTED` | Offscreen     | Background | Acknowledge start            |
| `OFFSCREEN_DATA`    | Offscreen     | Background | Recording saved, provide ID  |
| `OFFSCREEN_ERROR`   | Offscreen     | Background | Recording failed             |
| `RECORDER_STOP`     | Background    | Recorder   | Stop recorder page           |
| `RECORDER_STARTED`  | Recorder      | Background | Acknowledge start            |
| `RECORDER_DATA`     | Recorder      | Background | Recording saved, provide ID  |
| `OVERLAY_REMOVE`    | Background    | Overlay    | Remove overlay from page     |

### Message Format

Success:

```javascript
{ ok: true, ...data }
```

Failure:

```javascript
{ ok: false, error: string }
```

## Recording Flow

### Offscreen Strategy (No Microphone)

```
User clicks Record
    ↓
Popup → START → Background
    ↓
Background creates/ensures offscreen document
    ↓
Background → OFFSCREEN_START → Offscreen
    ↓
Offscreen calls getDisplayMedia()
    ↓
User selects screen/window/tab
    ↓
Offscreen starts MediaRecorder
    ↓
Offscreen → OFFSCREEN_STARTED → Background
    ↓
Background injects overlay on active tab
    ↓
[Recording in progress]
    ↓
User clicks Stop (overlay or popup)
    ↓
Stop source → STOP → Background
    ↓
Background → OFFSCREEN_STOP → Offscreen
    ↓
Offscreen stops MediaRecorder
    ↓
Offscreen saves Blob to IndexedDB
    ↓
Offscreen → OFFSCREEN_DATA → Background
    ↓
Background opens preview page
    ↓
Background closes offscreen document
```

### Page Strategy (With Microphone)

```
User clicks Record (mic enabled)
    ↓
Popup → START → Background
    ↓
Background creates recorder tab
    ↓
Recorder loads, calls getDisplayMedia()
    ↓
User selects screen/window/tab
    ↓
Recorder calls getUserMedia() for mic
    ↓
Recorder combines streams, starts MediaRecorder
    ↓
Recorder → RECORDER_STARTED → Background
    ↓
Background switches focus back to original tab
    ↓
Background injects overlay on active tab
    ↓
[Recording in progress]
    ↓
User clicks Stop
    ↓
Stop source → STOP → Background
    ↓
Background → RECORDER_STOP → Recorder
    ↓
Recorder stops MediaRecorder
    ↓
Recorder saves Blob to IndexedDB
    ↓
Recorder → RECORDER_DATA → Background
    ↓
Background opens preview page
    ↓
Background closes recorder tab
```

## Security Considerations

### Message Validation

All messages are validated to ensure they come from the extension itself:

```javascript
if (sender.id !== chrome.runtime.id) {
  // Reject unauthorized messages
}
```

### Content Security Policy

Manifest includes CSP to prevent XSS:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

### Permissions

Minimal permissions requested:

- `activeTab`: Only access current tab when recording
- `scripting`: Inject overlay only
- `offscreen`: Create hidden recording document
- `tabs`: Query/create tabs
- `storage`: Persist settings (future use)

**No** `<all_urls>` host permission - we don't need broad access.

## Privacy Architecture

1. **No Network Access**: Extension never makes network requests
2. **Local Storage Only**: Recordings stored in browser's IndexedDB
3. **User Control**: User explicitly downloads or deletes recordings
4. **No Analytics**: No telemetry or usage tracking
5. **Sandbox Isolation**: All processing in browser sandbox

## Error Handling

### Strategy

- Try-catch around all Chrome API calls
- Graceful degradation (e.g., overlay injection fails → badge-only stop)
- User feedback via alerts in popup
- Console logging for debugging
- Return objects: `{ ok: true/false, error?: string }`

### Timeout Protection

10-second timeout on stop operation prevents hung state if:

- Offscreen/recorder doesn't respond
- Message delivery fails
- MediaRecorder hangs

### Recovery

`resetRecordingState()` function ensures clean state reset on errors.

## Performance Optimizations

### Codec Selection

Fallback chain prioritizes modern, efficient codecs:

1. AV1 (best compression, newer browsers)
2. VP9 (good compression, wide support)
3. VP8 (legacy fallback)

### Content Hints

Optimizes encoder settings:

- Video: `contentHint = 'detail'` (for text/UI)
- System audio: `contentHint = 'music'`
- Microphone: `contentHint = 'speech'`

### Resource Management

- Close offscreen documents when idle
- Close database connections after transactions
- Revoke blob URLs on page unload
- Stop all media tracks on cleanup

## Future Enhancements

### Planned Features (from PRD)

- Trimming/editing with ffmpeg.wasm
- Format conversion (WebM → MP4)
- Quality settings
- Keyboard shortcuts
- Storage management UI

### State Persistence

For MV3 service worker suspension:

```javascript
// Save state to chrome.storage.session
await chrome.storage.session.set({ captureCastState: STATE });

// Restore on wakeup
const data = await chrome.storage.session.get('captureCastState');
Object.assign(STATE, data.captureCastState);
```

## Testing

### E2E Tests (Playwright)

- Test extension loading
- Test offscreen recording flow
- Test explicit stop
- Test auto-stop (when user stops sharing)
- Mock video generation for deterministic tests

### Test Structure

```
tests/e2e/
  ├── lib/fixtures.ts     # Extension loading fixture
  ├── playwright.config.ts
  └── stop/stop.spec.ts   # Stop feature tests
```

## Development Workflow

1. Clone repository
2. Open `chrome://extensions/`
3. Enable Developer Mode
4. Load unpacked extension
5. Edit code
6. Click reload icon on extension card
7. Test changes

### Running Tests

```bash
npm run e2e          # All tests
npm run e2e:stop     # Stop tests only
```

## Deployment

1. Update version in `manifest.json`
2. Update `CHANGELOG.md`
3. Run `./scripts/package.sh` to create zip
4. Upload to Chrome Web Store
5. Tag release in Git

## Troubleshooting

### Recording doesn't start

- Check if on restricted page (chrome://, about:)
- Verify permissions granted
- Check console for errors

### Overlay not showing

- Normal on restricted pages
- Use extension icon to stop instead

### Video won't play in preview

- Duration normalization may take 2s
- Check browser codec support
- Try downloading and playing externally

### State stuck "recording"

- 10s timeout will auto-reset
- Check service worker console
- Reload extension if needed
