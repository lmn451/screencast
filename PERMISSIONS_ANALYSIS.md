# CaptureCast - Permissions & Security Analysis

## Executive Summary

This document provides comprehensive analysis of all permission-related issues, edge cases, and security considerations in CaptureCast. Based on deep research and 6 parallel subagent investigations.

---

## Part 1: Chrome Extension Permission Model

### 1.1 Manifest Permissions Overview

```json
// manifest.json permissions (lines 13-17)
"permissions": [
  "activeTab",
  "scripting",
  "offscreen",
  "storage"
],
```

### 1.2 Permission Matrix

| Permission  | Purpose in CaptureCast                      | Security Level                         |
| ----------- | ------------------------------------------- | -------------------------------------- |
| `activeTab` | Access to current tab for overlay injection | Medium - temporary, user-gesture gated |
| `scripting` | Inject overlay.js into pages                | Medium - requires explicit API call    |
| `offscreen` | Create hidden document for recording        | High - controlled creation             |
| `storage`   | Persist session snapshots                   | Low - extension-only storage           |

### 1.3 Host Permissions

```json
// manifest.json - NO host permissions!
"host_permissions": []
```

✅ **Excellent**: No broad host access. Extension only interacts with:

- Its own extension pages (`chrome-extension://...`)
- Active tab via `activeTab` (temporary, on-demand)

---

## Part 2: MediaDevices API Permissions

### 2.1 getDisplayMedia() Permissions

```javascript
// offscreen.js:94-96
const displayStream = await navigator.mediaDevices.getDisplayMedia(
  getConstraintsFromMode(mode, includeAudio)
);
```

**Requirements:**

- No Chrome permission needed (browser handles picker UI)
- User MUST select a capture source (tab/window/screen)
- System audio requires additional OS-level permissions

**Browser Picker Behavior:**

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Screen Picker                  │
├─────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│  │ Entire  │  │  Window │  │   Tab   │  ← User picks  │
│  │ Screen   │  │         │  │         │                │
│  └─────────┘  └─────────┘  └─────────┘                │
│                                                         │
│  ☑ Share system audio  ← Only if OS allows            │
│                                                         │
│  [Cancel]                    [Share]                   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 getUserMedia() (Microphone) Permissions

**CRITICAL FINDING**: Chrome MV3 extensions CANNOT use microphone in offscreen documents!

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MICROPHONE PERMISSION ISSUE                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Problem: getUserMedia() for microphone requires a VISIBLE user         │
│           gesture context. Offscreen documents are hidden.               │
│                                                                         │
│  History: This was reported as a Chrome bug in 2023:                    │
│           https://bugs.chromium.org/p/chromium/issues/detail?id=160337  │
│                                                                         │
│  CaptureCast Solution: Use Page Strategy (recorder.html)                │
│                                                                         │
│  background.js:284-285:                                                 │
│  const useOffscreen = !STATE.includeMic && canUseOffscreen();          │
│                                                                         │
│  Offscreen Strategy → No microphone (getDisplayMedia audio only)        │
│  Page Strategy → Microphone allowed (visible tab)                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Audio Capture Limitations by Platform

| Platform      | System Audio  | Microphone   | Notes                                        |
| ------------- | ------------- | ------------ | -------------------------------------------- |
| **Windows**   | ✅ Supported  | ✅ Supported | Via getDisplayMedia + getUserMedia           |
| **macOS**     | ⚠️ Limited    | ✅ Supported | System audio may require third-party drivers |
| **Linux**     | ❌ Unreliable | ✅ Supported | Wayland vs X11 differences                   |
| **Chrome OS** | ✅ Supported  | ✅ Supported | Full support                                 |

---

## Part 3: Offscreen Document Permissions

### 3.1 Offscreen API Capabilities

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        OFFSCREEN DOCUMENT MODEL                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Permissions: Extension's permissions CARRY OVER                        │
│                                                                         │
│  ✓ Supported:                                                          │
│    - chrome.runtime API (messaging)                                     │
│    - MediaRecorder API                                                 │
│    - getDisplayMedia()                                                  │
│    - IndexedDB                                                          │
│    - Blob operations                                                    │
│                                                                         │
│  ✗ NOT Supported:                                                      │
│    - Most Chrome APIs (tabs, scripting, storage, etc.)                  │
│    - Window.focus()                                                     │
│    - Opening new tabs/windows                                           │
│    - File system access                                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Required Reasons for Offscreen Documents

```javascript
// background.js:165-169
await chrome.offscreen.createDocument({
  url: chrome.runtime.getURL('offscreen.html'),
  reasons: ['USER_MEDIA', 'BLOBS'], // ← Must include reason
  justification: 'Record a screen capture stream using MediaRecorder...',
});
```

**Valid Reasons (from Chrome API):**

- `USER_MEDIA` - getUserMedia() (microphone/camera) - **NOTE: May not work in offscreen!**
- `DISPLAY_MEDIA` - getDisplayMedia() (screen capture) ✅
- `BLOBS` - Blob operations ✅
- `WEB_RTC` - WebRTC APIs
- `CLIPBOARD` - Clipboard API
- `IFRAME_SCRIPTING` - iframe scripting
- `DOM_SCRAPING` - DOM scraping

### 3.3 Offscreen Document Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    OFFSCREEN LIFECYCLE                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. CREATE                                                              │
│     chrome.offscreen.createDocument({ url, reasons, justification })   │
│     Returns: Promise<void>                                              │
│                                                                         │
│  2. EXISTENCE                                                          │
│     - Only ONE offscreen document per extension                        │
│     - Can check: chrome.offscreen.hasDocument()                        │
│     - Can get contexts: chrome.runtime.getContexts()                    │
│                                                                         │
│  3. CLOSE                                                              │
│     chrome.offscreen.closeDocument()                                    │
│     - Should be called when idle to free resources                      │
│     - CaptureCast: closeOffscreenDocumentIfIdle()                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Part 4: Content Script & Overlay Injection

### 4.1 Injection Requirements

```javascript
// background.js:186-197
async function injectOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['overlay.js'],
  });
}
```

**Required Permission:** `scripting`

### 4.2 Cannot Inject On

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    RESTRICTED PAGE TYPES                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ✗ chrome:// URLs        - Chrome internal pages                       │
│  ✗ about:// URLs         - Browser about pages                         │
│  ✗ devtools:// URLs      - Developer tools                             │
│  ✗ chrome-extension://   - Other extension pages                       │
│  ✗ PDF viewers           - Some PDF viewer implementations             │
│  ✗ about:blank           - May work, depends on context                │
│                                                                         │
│  ✓ Any regular web page                                               │
│  ✓ Extension popup pages                                               │
│  ✓ Extension options page                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Overlay Injection Failure Handling

```javascript
// background.js:186-197
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    logger.log('Overlay injection failed (may be restricted page):', e.message);
    return false; // ← Silently returns false
  }
}
```

**Impact**: On restricted pages, overlay doesn't appear. User must stop via:

1. Extension icon click (popup)
2. Badge click
3. Browser developer tools (if recording hung)

### 4.4 Overlay Security Considerations

```javascript
// overlay.js - Security measures

// 1. Prevent multiple injections
(function () {
  if (document.getElementById('cc-overlay')) return; // ← Idempotent

  // 2. Minimal DOM footprint
  const root = document.createElement('div');
  root.id = 'cc-overlay';

  // 3. Inline styles (no external CSS)
  Object.assign(root.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: 2147483647, // Max z-index
    // ...
  });

  // 4. Message passing only (no direct background access)
  chrome.runtime.sendMessage({ type: 'STOP' });

  // 5. No data exfiltration from page
  // Overlay only reads its own button state
})();
```

---

## Part 5: Consent Flow Security

### 5.1 Consent Flow Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CONSENT FLOW SEQUENCE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  popup.js              consent.html           background.js            │
│     │                        │                      │                   │
│     ▼                        ▼                      ▼                   │
│  [Click Record]          [Page Load]          [Idle State]             │
│     │                        │                      │                   │
│     ▼                        ▼                      │                   │
│  Redirect to              Parse URL              │                   │
│  consent.html             params                 │                   │
│     │                        │                      │                   │
│     ▼                        ▼                      │                   │
│  (URL params)       Render capture info         │                   │
│  ?mode=tab&              & warnings             │                   │
│  mic=false&                                        │                   │
│  sys=false                                        │                   │
│                           │                      │                   │
│                           ▼                      │                   │
│                     [User decides]              │                   │
│                        │      │                 │                   │
│                   Cancel   Continue             │                   │
│                    │         │                  │                   │
│                    ▼         ▼                  │                   │
│                Close   sessionStorage:         │                   │
│                Window   cc_consent_given=true   │                   │
│                         cc_consent_ts=<time>    │                   │
│                              │                  │                   │
│                              ▼                  ▼                   │
│                         START message ───────► startRecording()
│                              │                      │
│                              │                      ▼
│                         [Success]              [Recording]
│                         window.close()              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Consent Parameters

```javascript
// consent.js:10-17
function loadParams() {
  return {
    mode: params.get('mode') || 'tab', // tab | window | screen
    mic: params.get('mic') === 'true' || params.get('mic') === '1',
    systemAudio: params.get('sys') === 'true' || params.get('sys') === '1',
  };
}
```

### 5.3 Consent Validation Weaknesses (Medium Priority)

**Issue 1: Loose Mode Validation**

```javascript
// consent.js:10
mode: params.get('mode') || 'tab'; // Any string accepted
```

**Impact**: If malicious URL param: `consent.html?mode=<script>`, display shows garbage but backend validates properly.

**Mitigated by**: background.js schema validation rejects unknown modes.

**Issue 2: Boolean String Conversion**

```javascript
// consent.js:12-13
mic: params.get('mic') === 'true' || params.get('mic') === '1';
// '0' evaluates to true in loose comparison!
```

**Impact**: Low - doesn't bypass recording logic, just display text.

### 5.4 Consent Tracking Bug (High Priority)

```javascript
// consent.js:119-123
function trackConsent(action, params) {
  const key = 'cc_consent_events';
  const entry = {
    action,
    mode: params.mode,
    ts: Date.now(),
  };
  const existing = JSON.parse(sessionStorage.getItem(key) || '[]');
  existing.push(entry);
  // BUG: Should save 'existing' array, not single 'entry'
  sessionStorage.setItem(key, JSON.stringify(entry)); // ← BUG!
}
```

**Impact**: Only last consent event is stored, array never grows.

---

## Part 6: IndexedDB Storage Permissions

### 6.1 Storage Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CAPTURECAST STORAGE MODEL                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  IndexedDB: "CaptureCastDB" (version 3)                                 │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  STORE_CHUNKS                                                    │   │
│  │  ├─ keyPath: ['recordingId', 'index'] (compound)                 │   │
│  │  ├─ Index: 'recordingId'                                         │   │
│  │  │                                                                │   │
│  │  │ Storage per recording:                                         │   │
│  │  │ { recordingId: uuid, index: 0, chunk: Blob }                  │   │
│  │  │ { recordingId: uuid, index: 1, chunk: Blob }                  │   │
│  │  │ ... (1 chunk per second of recording)                         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  STORE_RECORDINGS                                               │   │
│  │  ├─ keyPath: 'id'                                                │   │
│  │  │                                                                │   │
│  │  │ { id: uuid, mimeType, duration, size, createdAt, name, status }│   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  chrome.storage.local:                                                 │
│  └─ sessionSnapshot: Current recording state                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Storage Quota

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        STORAGE QUOTA LIMITS                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  IndexedDB:                                                             │
│  - Subject to browser storage quota                                     │
│  - Can be exhausted during long recordings                              │
│  - 1 hour of 1080p video ≈ 500MB - 2GB depending on codec               │
│                                                                         │
│  Check before recording:                                               │
│                                                                         │
│  // storage-utils.js                                                   │
│  export async function checkStorageQuota() {                           │
│    try {                                                               │
│      if (navigator.storage && navigator.storage.estimate) {            │
│        const estimate = await navigator.storage.estimate();            │
│        const usagePercent = (estimate.usage / estimate.quota) * 100;   │
│        if (usagePercent > 80) {                                        │
│          return { ok: false, error: 'Storage almost full' };           │
│        }                                                               │
│      }                                                                 │
│    } catch (e) {                                                       │
│      // Non-critical, continue                                          │
│    }                                                                   │
│    return { ok: true };                                                │
│  }                                                                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Storage Failure Matrix

| Failure                      | Detection                                       | Recovery                                         |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| **Chunk save fails**         | `saveChunkWithRetry()` returns `{saved: false}` | Increment `failedChunkCount`, continue recording |
| **All retries exhausted**    | After 3 attempts, still fails                   | Mark recording as PARTIAL or FAILED              |
| **IndexedDB full**           | `DOMException: QuotaExceededError`              | Stop recording, notify user, preserve partial    |
| **Recording metadata fails** | `finishRecording()` throws                      | Log error, alert user, tab stays open            |
| **Corrupt chunk**            | Chunk doesn't match expected index              | Delete recording, notify user                    |

### 6.4 Partial Recording Recovery

```javascript
// chunkStorage.js:93-96
export async function hasChunks(recordingId) {
  const count = await getChunkCount(recordingId);
  return count > 0;
}

// background.js:111-119
if (snapshot.recordingId) {
  const hasChunksResult = await hasChunks(snapshot.recordingId);
  if (hasChunksResult) {
    await markRecordingRecoverable(snapshot.recordingId);
  }
}
```

---

## Part 7: Service Worker Lifecycle

### 7.1 MV3 Service Worker Behavior

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SERVICE WORKER LIFECYCLE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  INSTALL ──────► ACTIVE ──────► IDLE ──────► TERMINATED                │
│                      │              │              │                    │
│                      │              │              │                    │
│                      ▼              ▼              │                    │
│                 [Event]      [5 min idle]         │                    │
│                wakes SW      triggers sleep       │                    │
│                      │              │              │                    │
│                      │              │              ▼                    │
│                      │              │         [Wake event]            │
│                      │              │              │                   │
│                      │              └──────────────┘                    │
│                      │                                                     │
│                      ▼                                                     │
│              [Event pending?]                                             │
│                    │   │                                                  │
│                   YES   NO                                                │
│                    │     │                                                │
│                    ▼     ▼                                                │
│              Wake SW  Stay terminated                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Wake-up Triggers for CaptureCast

**Events that wake the service worker:**

```javascript
// These keep CaptureCast's service worker alive:

// 1. Message from popup
chrome.runtime.onMessage.addListener(...)  // ← STOP from overlay

// 2. Message from offscreen
chrome.runtime.onMessage.addListener(...)  // ← OFFSCREEN_DATA

// 3. Message from recorder tab
chrome.runtime.onMessage.addListener(...)  // ← RECORDER_DATA

// 4. Timer (for reconciliation)
setTimeout(...)  // ← STOP_TIMEOUT_MS (60s)
```

### 7.3 State Persistence for Recovery

```javascript
// background.js:58-75 - Session Snapshot
async function persistSessionSnapshot(extra = {}) {
  const snapshot = {
    recordingId: STATE.recordingId,
    status: STATE.status,
    startedAt: STATE.startedAt,
    lastActivityAt: STATE.lastActivityAt,
    options: { ...STATE.options },
    strategy: STATE.strategy,
    correlationId: STATE.correlationId,
    ...extra,
  };
  await chrome.storage.local.set({ [SESSION_SNAPSHOT_KEY]: snapshot });
}
```

### 7.4 What Gets Lost on Suspension

| Data                  | Persisted?     | Lost? | Recovery               |
| --------------------- | -------------- | ----- | ---------------------- |
| `STATE.status`        | ✅             | -     | Restored from snapshot |
| `STATE.recordingId`   | ✅             | -     | Restored               |
| `STATE.options`       | ✅             | -     | Restored               |
| `STATE.strategy`      | ✅             | -     | Restored               |
| `STATE.startedAt`     | ✅             | -     | Restored               |
| Video chunks          | ✅ (IndexedDB) | -     | Survive                |
| `STATE.overlayTabId`  | ❌             | Lost  | Cannot restore         |
| `STATE.recorderTabId` | ❌             | Lost  | Cannot restore         |
| `STATE.stopTimeoutId` | ❌             | Lost  | New timer set          |
| MediaStream           | ❌             | Lost  | Cannot restore         |
| MediaRecorder         | ❌             | Lost  | Must restart recording |

### 7.5 Recovery Flow

```javascript
// background.js:93-129
async function reconcileUnfinishedSessions() {
  const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
  const snapshot = result[SESSION_SNAPSHOT_KEY];

  if (!snapshot) return;

  const age = Date.now() - snapshot.lastActivityAt;

  if (age > STOP_TIMEOUT_MS) {
    // Stale session - clean up
    await clearSessionSnapshot();

    if (snapshot.recordingId) {
      const hasChunksResult = await hasChunks(snapshot.recordingId);
      if (hasChunksResult) {
        await markRecordingRecoverable(snapshot.recordingId);
      }
    }
  } else {
    // Active session - allow reconciliation
    // Could restore state and resume
  }
}
```

---

## Part 8: Permission Edge Cases & Failure Modes

### 8.1 Screen Selection Denied

```javascript
// offscreen.js:109-112
} catch (error) {
  logger.error('getDisplayMedia failed:', error);
  throw error;  // ← Bubbles up to background.js
}
```

**User Experience:**

1. getDisplayMedia() throws `NotAllowedError`
2. Error propagates to background.js
3. startRecording() returns `{ok: false, error: 'NotAllowedError'}`
4. consent.html shows error inline

### 8.2 Microphone Denied

```javascript
// recorder.js:88-103
if (wantMic) {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {...} });
  } catch (e) {
    logger.warn('Mic request failed, proceeding without mic:', e);
    status.textContent = 'Mic request failed. Recording without mic.';
    // ← Continues WITHOUT microphone!
  }
}
```

**Behavior**: Recording continues without mic, user notified.

### 8.3 System Audio Denied (OS Level)

```javascript
// offscreen.js:71-84
function getConstraintsFromMode(mode, includeAudio) {
  return {
    video: true,
    audio: includeAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false,
  };
}
```

**Issue**: If OS denies system audio, `getDisplayMedia()` fails with `NotAllowedError`.
**Workaround**: Catch error, retry without system audio.

### 8.4 Camera Access (No Camera Needed)

CaptureCast does NOT require camera. Only:

- Screen/tab/window capture (getDisplayMedia)
- Microphone (optional, via getUserMedia)

### 8.5 Permission Timing Issues

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    TIMING RACE CONDITIONS                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. START → 5s confirmation timeout                                      │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │                                                          5s  │     │
│     │ startRecording() ──► OFFSCREEN_START ──► ??? ──► RECORDING │     │
│     │                                    └─ timeout ──┘          │     │
│     └─────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  2. Session snapshot on state change                                   │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │  STATE.status = STATE_RECORDING                            │     │
│     │  await persistSessionSnapshot()                            │     │
│     │                                           ↑                  │     │
│     │                        If SW suspends here, old state saved │     │
│     └─────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  3. Concurrent recording check                                         │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │  check storage.local → another recording active? → reject   │     │
│     │  But what if that recording ended 2s ago and SW just woke? │     │
│     └─────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Part 9: Error Codes & Handling

### 9.1 Error Code Reference

```javascript
// error-codes.js
export const CODES = {
  // State transitions
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  // Storage
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  CHUNK_SAVE_FAILED: 'CHUNK_SAVE_FAILED',
  RECORDING_SAVE_FAILED: 'RECORDING_SAVE_FAILED',

  // Media
  DISPLAY_MEDIA_FAILED: 'DISPLAY_MEDIA_FAILED',
  MICROPHONE_FAILED: 'MICROPHONE_FAILED',
  MEDIA_RECORDER_ERROR: 'MEDIA_RECORDER_ERROR',

  // Permission
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PERMISSION_DISMISSED: 'PERMISSION_DISMISSED',

  // Session
  SESSION_CORRUPTED: 'SESSION_CORRUPTED',
  CONCURRENT_RECORDING: 'CONCURRENT_RECORDING',
};
```

### 9.2 Error Response Format

```javascript
// Success
{ ok: true, ...data }

// Failure
{ ok: false, error: 'Error message', code?: 'ERROR_CODE' }
```

### 9.3 Error → User Mapping

| Error                  | User Message                   | Recovery               |
| ---------------------- | ------------------------------ | ---------------------- |
| `NotAllowedError`      | "Permission denied"            | User must try again    |
| `NotFoundError`        | "No capture source selected"   | User cancelled         |
| `OverconstrainedError` | "Audio settings not supported" | Try different settings |
| `AbortError`           | "Recording aborted"            | User likely cancelled  |
| `QuotaExceededError`   | "Storage full"                 | Delete old recordings  |

---

## Part 10: Security Recommendations

### 10.1 Critical Fixes

#### 1. Consent Tracking Array Bug

```javascript
// consent.js:119-123 - FIXED version
function trackConsent(action, params) {
  const key = 'cc_consent_events';
  const entry = {
    action,
    mode: params.mode,
    ts: Date.now(),
  };
  const existing = JSON.parse(sessionStorage.getItem(key) || '[]');
  existing.push(entry);
  sessionStorage.setItem(key, JSON.stringify(existing)); // ← FIXED: save array
}
```

#### 2. Mode Parameter Validation

```javascript
// consent.js - ADD validation
function loadParams() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');

  // Validate mode
  if (!['tab', 'window', 'screen'].includes(mode)) {
    console.error('Invalid mode:', mode);
    // Default to 'tab' with warning
  }

  return {
    mode: ['tab', 'window', 'screen'].includes(mode) ? mode : 'tab',
    mic: params.get('mic') === 'true' || params.get('mic') === '1',
    systemAudio: params.get('sys') === 'true' || params.get('sys') === '1',
  };
}
```

#### 3. Overlay Injection Failure Notification

```javascript
// background.js - ADD user notification
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    logger.log('Overlay injection failed:', e.message);

    // Inform user via badge that stop is available via popup
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#f9ab00' });

    return false;
  }
}
```

### 10.2 Recommended Improvements

1. **Add permission explanation page** before consent
2. **Implement permission retry logic** for transient failures
3. **Add system audio fallback** when OS denies access
4. **Improve error messages** in consent.html for each failure type
5. **Add timeout countdown UI** during recording start
6. **Implement recording quality selector** (720p, 1080p, 4K)
7. **Add storage usage indicator** in popup

### 10.3 XState v5 Integration Benefits

With XState v5 state machine:

- All permission-related states are explicitly modeled
- Guards prevent invalid permission combinations
- Actions handle side effects atomically
- TypeScript ensures no permission mishandling
- Actor model naturally handles offscreen/recorder communication

---

## Appendix A: Complete Permission Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     COMPLETE PERMISSION FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         USER ACTION                                  │   │
│  │                    Click Record in Popup                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      CONSENT PAGE                                   │   │
│  │  • Explain what's being recorded                                    │   │
│  │  • Show audio options                                               │   │
│  │  • User clicks Continue                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      background.js                                  │   │
│  │  • Check activeTab permission (temporary)                           │   │
│  │  • Validate state transitions                                       │   │
│  │  • Check storage quota                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                    ┌───────────────┴───────────────┐                        │
│                    ▼                               ▼                        │
│        ┌─────────────────────┐         ┌─────────────────────┐             │
│        │ OFFSCREEN STRATEGY  │         │   PAGE STRATEGY     │             │
│        │ (no microphone)     │         │   (microphone)      │             │
│        ├─────────────────────┤         ├─────────────────────┤             │
│        │ chrome.offscreen.   │         │ chrome.tabs.create │             │
│        │   createDocument()  │         │ (recorder.html)    │             │
│        │ reason: USER_MEDIA │         │                    │             │
│        │ reason: BLOBS       │         │ Requires user      │             │
│        └─────────┬───────────┘         │ gesture for mic    │             │
│                  │                     └─────────┬───────────┘             │
│                  │                               │                          │
│                  ▼                               ▼                          │
│        ┌─────────────────────┐         ┌─────────────────────┐             │
│        │ offscreen.html       │         │ recorder.html       │             │
│        │                      │         │                     │             │
│        │ getDisplayMedia()   │         │ getDisplayMedia()  │             │
│        │ (screen + audio)   │         │ (screen only)      │             │
│        │                      │         │                     │             │
│        │ ✗ getUserMedia()   │         │ getUserMedia()     │             │
│        │ (won't work here!)  │         │ (microphone) ✅     │             │
│        └─────────────────────┘         └─────────┬───────────┘             │
│                                                  │                          │
│                                                  ▼                          │
│                                        ┌─────────────────────┐             │
│                                        │ Microphone prompt   │             │
│                                        │ (OS-level dialog)   │             │
│                                        └─────────┬───────────┘             │
│                                                  │                          │
│                                                  ▼                          │
│                                        ┌─────────────────────┐             │
│                                        │ MediaRecorder       │             │
│                                        │ combines streams    │             │
│                                        └─────────┬───────────┘             │
│                                                  │                          │
│                                                  ▼                          │
│                                        ┌─────────────────────┐             │
│                                        │ Recording active    │             │
│                                        │ Chunks → IndexedDB  │             │
│                                        └─────────┬───────────┘             │
│                                                  │                          │
│                                    ┌─────────────┴─────────────┐            │
│                                    ▼                           ▼            │
│                        ┌──────────────────┐       ┌──────────────────┐    │
│                        │ User clicks Stop │       │ Screen sharing   │    │
│                        │ (popup/overlay)  │       │ ended (browser)  │    │
│                        └────────┬─────────┘       └────────┬─────────┘    │
│                                 │                         │              │
│                                 └────────────┬────────────┘              │
│                                              ▼                           │
│                                    ┌─────────────────────┐             │
│                                    │ Stop MediaRecorder  │             │
│                                    │ Final chunk saved   │             │
│                                    │ Recording finished  │             │
│                                    └─────────┬───────────┘             │
│                                              │                          │
│                                              ▼                          │
│                                    ┌─────────────────────┐             │
│                                    │ Preview page opens │             │
│                                    │ (user can download │             │
│                                    │  or delete)        │             │
│                                    └─────────────────────┘             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Appendix B: Chrome Extension Permission FAQ

### Q: Why does CaptureCast need `activeTab` permission?

**A:** To inject the overlay stop button into the tab being recorded. This only happens while actively recording.

### Q: Why does CaptureCast need `scripting` permission?

**A:** To execute `overlay.js` in the user's tab. The `activeTab` permission grants tab access, but `scripting` permission is needed to inject code.

### Q: Why does CaptureCast need `offscreen` permission?

**A:** To create a hidden document for screen recording without microphone. Offscreen documents allow getDisplayMedia in a non-visible context.

### Q: Why does CaptureCast need `storage` permission?

**A:** To persist session snapshots for crash recovery. If the service worker is terminated during recording, the snapshot allows reconciliation on wake.

### Q: Does CaptureCast access any websites?

**A:** No. CaptureCast has no host permissions. It only:

- Reads the active tab's DOM for overlay injection
- Stores recordings in IndexedDB (extension-only storage)

### Q: Can CaptureCast record audio from my microphone?

**A:** Only if you enable the microphone option AND select a screen/tab that includes audio. Chrome will show a prompt before recording begins.

### Q: Can CaptureCast record my passwords or sensitive data?

**A:** CaptureCast captures only what's visible in the selected screen/tab/window. It cannot access page content outside the selected capture area.

---

## Appendix C: Testing Checklist for Permissions

- [ ] Test screen capture denial → appropriate error message
- [ ] Test microphone denial → recording continues without mic
- [ ] Test on restricted page (chrome://) → overlay not injected, but recording works
- [ ] Test on PDF viewer → overlay injection fails, manual stop needed
- [ ] Test system audio denied → graceful fallback
- [ ] Test storage quota exceeded → clear error, partial recording preserved
- [ ] Test service worker termination during recording → recovery on wake
- [ ] Test concurrent recording prevention → rejection message
- [ ] Test 5-second start timeout → fallback behavior
- [ ] Test consent page with invalid params → validation
- [ ] Test consent tracking → array not overwritten
