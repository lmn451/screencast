# CaptureCast Chrome Extension Permission Matrix

## Current Manifest Permissions

```json
{
  "permissions": ["activeTab", "scripting", "offscreen", "storage", "alarms"]
}
```

**Implementation note**: The extension does not request `desktopCapture` or `tabCapture`. CaptureCast relies on `getDisplayMedia()` from the offscreen/recorder page contexts and uses only the permissions listed above.

---

## Critical Implementation Details

### Offscreen Strategy - ONLY getDisplayMedia

The offscreen document (`offscreen.js`) uses `getDisplayMedia()` with `audio: includeAudio` which requests **system audio only**, NOT the microphone.

```javascript
// offscreen.js - getConstraintsFromMode
return {
  video: true,
  audio: includeAudio, // system audio, NOT microphone
};
```

### Recorder Page Strategy - getDisplayMedia + getUserMedia

The recorder page (`recorder.js`) uses BOTH:

- `getDisplayMedia()` for screen capture
- `getUserMedia({audio:true})` for microphone

```javascript
// recorder.js lines 76-103
// 1. Screen capture
const displayStream = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  audio: wantSys, // system audio
});

// 2. Microphone (separate request)
if (wantMic) {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}
```

### Strategy Selection

```javascript
// background.js line 284
const useOffscreen = !STATE.includeMic && canUseOffscreen();
```

| Microphone Requested | Offscreen Available | Strategy Used                                          |
| -------------------- | ------------------- | ------------------------------------------------------ |
| No                   | Yes                 | **Offscreen** (system audio only)                      |
| No                   | No                  | **Recorder Page**                                      |
| Yes                  | -                   | **Recorder Page** (required for mic permission prompt) |

---

## Permission Matrix

| API Call                            | Context                   | Required Manifest Permission | User Gesture Required | Fallback on Denial                                     |
| ----------------------------------- | ------------------------- | ---------------------------- | --------------------- | ------------------------------------------------------ |
| `getDisplayMedia({audio:true})`     | Offscreen Document        | `offscreen`                  | **YES** (always)      | `NotAllowedError`                                      |
| `getDisplayMedia({audio:true})`     | Recorder Page             | None                         | **YES** (always)      | `NotAllowedError`                                      |
| `getUserMedia({audio:true})`        | Offscreen Document        | `offscreen`                  | **YES** (first time)  | `NotAllowedError: Failed due to shutdown`              |
| `getUserMedia({audio:true})`        | Recorder Page             | None                         | **YES** (first time)  | Graceful degradation (recording continues without mic) |
| `chrome.scripting.executeScript()`  | Background Service Worker | `scripting`                  | No                    | Silent failure, overlay not injected                   |
| `chrome.offscreen.createDocument()` | Background Service Worker | `offscreen`                  | No                    | `chrome.offscreen undefined`                           |

---

## Strategy Decision Flow

```
startRecording(mode, includeMic, includeSystemAudio)
           │
           ▼
   ┌─────────────────────────────────────────────────┐
   │ const useOffscreen = !STATE.includeMic && canUseOffscreen() │
   └─────────────────────────────────────────────────┘
           │
     ┌─────┴─────┐
     │ YES        │ NO (mic requested OR offscreen unavailable)
     ▼                        ▼
┌─────────────┐        ┌─────────────────┐
│ OFFSCREEN   │        │ RECORDER PAGE   │
│ STRATEGY    │        │ STRATEGY        │
└─────────────┘        └─────────────────┘
```

---

## Offscreen Strategy (No Microphone)

### Permissions Required

- Manifest: `offscreen`
- `chrome.offscreen.createDocument()` reasons: `['USER_MEDIA', 'BLOBS']`

### API Calls in Offscreen Context

```javascript
// offscreen.js - startCapture()
const displayStream = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  audio: includeAudio, // system audio only
});
```

### Permission Behavior

| Scenario                                        | Result                                   | Error Code        |
| ----------------------------------------------- | ---------------------------------------- | ----------------- |
| User cancels screen picker                      | Promise rejects                          | `NotAllowedError` |
| User denies screen capture                      | Promise rejects                          | `NotAllowedError` |
| System audio denied                             | Gracefully excluded, recording continues | None (silent)     |
| getDisplayMedia in offscreen (no prior consent) | Promise rejects                          | `NotAllowedError` |

### Edge Case: getUserMedia in Offscreen

**CRITICAL**: `getUserMedia({audio:true})` **CANNOT** be called in an offscreen document without prior user consent. The offscreen document cannot trigger permission prompts.

```
Error: NotAllowedError: Failed due to shutdown
```

**Why the design handles this correctly**: The offscreen strategy is ONLY used when `!STATE.includeMic` (no microphone requested). The recorder page strategy is used when microphone IS requested, which CAN prompt for permission.

---

## Recorder Page Strategy (With Microphone)

### Permissions Required

- Manifest: None additional
- Page URL: `chrome-extension://<id>/recorder.html?id=<uuid>&mode=<mode>&mic=<0|1>&sys=<0|1>`

### API Calls in Recorder Page Context

```javascript
// recorder.js - start()

// 1. Screen capture (always required)
const displayStream = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  audio: wantSys,
});

// 2. Microphone (if requested)
if (wantMic) {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    // Graceful degradation: continue without mic
    logger.warn('Mic request failed, proceeding without mic:', e);
  }
}
```

### Permission Behavior

| Scenario                   | Result          | Error Code        | Recovery                                          |
| -------------------------- | --------------- | ----------------- | ------------------------------------------------- |
| User cancels screen picker | Promise rejects | `NotAllowedError` | Show "Auto-start failed" + Start button           |
| User denies screen capture | Promise rejects | `NotAllowedError` | Show error + retry button                         |
| User denies microphone     | Promise rejects | `NotAllowedError` | **Recording continues without mic**, show warning |
| User denies system audio   | Track excluded  | None              | Recording continues without system audio          |

---

## Denial Scenarios & Recovery Paths

### 1. Screen Capture Denied

```
User Action: User clicks "Cancel" in screen picker or denies permission
```

**Offscreen Strategy:**

```
getDisplayMedia() → NotAllowedError
    ↓
background.js receives OFFSCREEN_ERROR
    ↓
STATE.status = STATE_FAILED
    ↓
Cleanup: closeOffscreenDocument(), resetRecordingState()
    ↓
User sees: Nothing visible (tab returns to idle)
```

**Recorder Page Strategy:**

```
getDisplayMedia() → NotAllowedError
    ↓
catch block executes
    ↓
startBtn.classList.remove('hidden')
status.textContent = 'Failed to start: NotAllowedError...'
    ↓
User sees: Error message with retry button
```

### 2. Microphone Denied

```
User Action: User denies microphone permission in picker
```

**Behavior is INTENTIONAL graceful degradation:**

```javascript
// recorder.js lines 86-103
if (wantMic) {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: {...} });
    applyContentHints(micStream, { hasMicrophone: true });
  } catch (e) {
    logger.warn('Mic request failed, proceeding without mic:', e);
    status.textContent = 'Mic request failed. Recording without mic.';
    // micStream remains null, combineStreams works with partial input
  }
}

mediaStream = combineStreams({ displayStream, micStream }); // micStream = null is handled
```

**Why this is intentional**: `combineStreams()` accepts `null` for `micStream` and returns only the display stream.

### 3. System Audio Denied

```
User Action: User toggles off system audio in Chrome's picker
```

**Behavior**: Track is excluded, recording continues with video-only.

```javascript
// offscreen.js - getConstraintsFromMode
audio: includeAudio
  ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  : false;
```

When `audio: false`, no system audio track is captured.

---

## Error Code Mapping

From `error-codes.js`:

```javascript
case 'NotAllowedError':
case 'PermissionDeniedError':
  return createError(CODES.MEDIA_PERMISSION_DENIED, message);

case 'NotFoundError':
  return createError(CODES.MEDIA_PERMISSION_DENIED, 'Requested media not found');

case 'AbortError':
  return createError(CODES.MEDIA_TRACK_ENDED, message);
```

| DOM Exception           | Error Code                | Message                        |
| ----------------------- | ------------------------- | ------------------------------ |
| `NotAllowedError`       | `MEDIA_PERMISSION_DENIED` | Media permission denied        |
| `PermissionDeniedError` | `MEDIA_PERMISSION_DENIED` | Media permission denied        |
| `NotFoundError`         | `MEDIA_PERMISSION_DENIED` | Requested media not found      |
| `AbortError`            | `MEDIA_TRACK_ENDED`       | Media track ended unexpectedly |

---

## User Gesture Requirements

### getDisplayMedia

- **ALWAYS requires user gesture** (browser security policy)
- Cannot be called without user interaction
- Called in response to button click or explicit user action

### getUserMedia (Microphone)

- **First call requires user gesture** (permission prompt must be user-initiated)
- Subsequent calls can be programmatic IF permission already granted
- **In offscreen context**: Cannot trigger prompt at all

### chrome.scripting.executeScript

- No user gesture required
- Called from user-initiated flow (consent button click)
- Failure is non-fatal (overlay just doesn't appear)

---

## Extension vs Webpage Permission Contexts

| Context                   | Domain                                   | Permission Prompt Shows                         |
| ------------------------- | ---------------------------------------- | ----------------------------------------------- |
| Extension popup           | `chrome-extension://<id>/popup.html`     | "[Extension Name] wants to use your microphone" |
| Offscreen document        | `chrome-extension://<id>/offscreen.html` | Cannot prompt, fails with "shutdown"            |
| Recorder page             | `chrome-extension://<id>/recorder.html`  | "[Extension Name] wants to use your microphone" |
| Content script (injected) | `<hostpage.com>`                         | "hostpage.com wants to use your microphone"     |

**Key Insight**: Offscreen documents have the extension's permissions **but cannot invoke permission prompts**. The consent must come from a context that CAN prompt (popup, recorder page, or an iframe in an extension page).

---

## Silent Failure Scenarios

| Scenario                             | Silent? | Detectable? | Detection Method                   |
| ------------------------------------ | ------- | ----------- | ---------------------------------- |
| Overlay injection on restricted page | Yes     | Yes         | `injectOverlay()` returns `false`  |
| System audio not available           | Yes     | Yes         | No audio track in stream           |
| Microphone denied                    | No      | Yes         | `catch` block + status message     |
| Screen capture denied                | No      | Yes         | `catch` block + status message     |
| Offscreen document creation          | No      | Yes         | `ensureOffscreenDocument()` throws |
| Message send to closed tab           | Yes     | Yes         | `catch` block in `sendMessage()`   |

---

## Recommendations

### 1. Add desktopCapture Permission (Optional)

If you want more reliable screen capture, consider adding:

```json
"permissions": ["desktopCapture"]
```

This provides access to `chrome.desktopCapture.captureOffscreenTab()` which has different behavior.

### 2. Pre-request Microphone Permission

To ensure microphone works in offscreen context without forcing user through two permission flows:

```javascript
// In popup.js or consent.js (before opening recorder)
if (needMic) {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    // Permission now granted for extension context
    // Can be used in offscreen document
  } catch (e) {
    // User denied, will record without mic
  }
}
```

### 3. Handle Offscreen getUserMedia Failure

Currently offscreen.js does NOT call getUserMedia, but if you add it:

```javascript
// Offscreen document CANNOT prompt for permission
// Must check navigator.permissions.query first
const result = await navigator.permissions.query({ name: 'microphone' });
if (result.state !== 'granted') {
  // Cannot proceed with mic in offscreen
  throw new Error('Microphone permission not pre-granted');
}
```

### 4. Improve Error Messaging

Current: Generic "Failed to start" message
Better: Specific message explaining which permission was denied and how to retry

---

## Summary

| Concern                         | Current Status                                     | Severity        |
| ------------------------------- | -------------------------------------------------- | --------------- |
| Screen capture works            | ✅ Yes                                             | -               |
| Microphone graceful degradation | ✅ Yes (recorder page)                             | -               |
| Offscreen cannot prompt for mic | ⚠️ Design constraint (bypassed by strategy choice) | Low (by design) |
| No desktopCapture permission    | ⚠️ Works without it                                | Info            |
| Error messages could be clearer | ⚠️ Could improve                                   | Low             |
| Overlay injection failures      | ⚠️ Silent                                          | Low             |
