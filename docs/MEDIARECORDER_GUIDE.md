# MediaRecorder Failure Modes & Recovery Strategies

A comprehensive guide for screen capture extensions based on the CaptureCast codebase and browser platform research.

---

## 1. Constructor Requirements & MIME Type Detection

### 1.1 MediaRecorder Construction

```javascript
const recorder = new MediaRecorder(stream, options);
```

**Requirements:**

- Must have `MediaStream` source
- Optional `MediaRecorderOptions`:
  - `mimeType`: Container/codec specification (defaults to browser choice)
  - `audioBitsPerSecond`: Audio encoding rate
  - `videoBitsPerSecond`: Video encoding rate
  - `bitsPerSecond`: Combined bitrate (overridden by specific values)

**Constructor throws immediately if:**

- Invalid MIME type specified
- MIME type not supported (from `isTypeSupported()`)

### 1.2 MIME Type Detection Pattern (from media-recorder-utils.js)

```javascript
export function getOptimalCodec() {
  const codecs = [
    'video/webm;codecs=av01,opus', // AV1 (best compression)
    'video/webm;codecs=av1,opus', // AV1 alternative
    'video/webm;codecs=vp9,opus', // VP9
    'video/webm;codecs=vp8,opus', // VP8
    'video/webm', // Generic fallback
  ];

  for (const codec of codecs) {
    if (MediaRecorder.isTypeSupported(codec)) {
      return codec;
    }
  }
  throw new Error('No supported video codec found...');
}
```

### 1.3 Browser Codec Support Matrix

| Browser      | WebM/VP8 | WebM/VP9 | WebM/AV1   | MP4/H.264  | Opus Audio |
| ------------ | -------- | -------- | ---------- | ---------- | ---------- |
| Chrome 72+   | ✅       | ✅       | ✅ (M107+) | ✅ (M104+) | ✅         |
| Firefox 66+  | ✅       | ✅       | ✅ (F108+) | ❌         | ✅         |
| Safari 14.1+ | ⚠️       | ⚠️       | ❌         | ✅         | ✅         |
| Edge 79+     | ✅       | ✅       | ✅         | ✅         | ✅         |

**Critical Insight:** `isTypeSupported()` can lie. Chrome 108 reported `video/x-matroska;codecs=vp9` as supported, but video couldn't play. **Always test actual encoding with small chunks.**

### 1.4 Fallback Cascade Pattern

```javascript
function createRecorderWithFallback(stream, callbacks) {
  const fallbacks = [
    { mimeType: 'video/webm;codecs=av01,opus', v: 5_000_000, a: 128_000 },
    { mimeType: 'video/webm;codecs=vp9,opus', v: 3_000_000, a: 128_000 },
    { mimeType: 'video/webm;codecs=vp8,opus', v: 2_000_000, a: 96_000 },
    { mimeType: 'video/webm', v: 1_000_000, a: 64_000 },
  ];

  for (const fb of fallbacks) {
    if (MediaRecorder.isTypeSupported(fb.mimeType)) {
      return new MediaRecorder(stream, {
        mimeType: fb.mimeType,
        videoBitsPerSecond: fb.v,
        audioBitsPerSecond: fb.a,
      });
    }
  }
  throw new Error('No codec supported');
}
```

---

## 2. Content Hints & Encoder Optimization

### 2.1 Content Hint API

MediaStreamTrack.contentHint optimizes encoder settings:

```javascript
export function applyContentHints(stream, { hasSystemAudio = false, hasMicrophone = false } = {}) {
  // Video: optimize for screen content with text detail
  const videoTrack = stream.getVideoTracks?()?.[0];
  if (videoTrack && 'contentHint' in videoTrack) {
    videoTrack.contentHint = 'detail';
  }

  // System audio: high fidelity music
  if (hasSystemAudio) {
    stream.getAudioTracks?.()?.forEach(track => {
      if ('contentHint' in track) track.contentHint = 'music';
    });
  }

  // Microphone: speech optimization
  if (hasMicrophone) {
    stream.getAudioTracks?.()?.forEach(track => {
      if ('contentHint' in track) track.contentHint = 'speech';
    });
  }
}
```

**Valid hints:**

- `'motion'` - High frame rate, lower quality acceptable
- `'detail'` - Sharp edges, text, screenshots (use for screen capture)
- `'continuous'` - Smooth motion without sharp edges
- `'speech'` - Voice optimization
- `'music'` - High fidelity audio

### 2.2 Track-Specific Constraints

| Track Type   | Recommended Constraints                                                        | contentHint |
| ------------ | ------------------------------------------------------------------------------ | ----------- |
| Screen video | None needed                                                                    | `'detail'`  |
| Microphone   | `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }`    | `'speech'`  |
| System audio | `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }` | `'music'`   |

---

## 3. Error Types & Handling

### 3.1 DOMException Hierarchy

MediaRecorder throws or emits these error types:

| Error Name          | Trigger                             | Handling                                |
| ------------------- | ----------------------------------- | --------------------------------------- |
| `NotAllowedError`   | Permission denied by user           | Show user-friendly message, don't retry |
| `NotFoundError`     | Device/display not available        | Guide user to select valid source       |
| `AbortError`        | User cancelled or track ended       | Clean up gracefully                     |
| `InvalidStateError` | Operation invalid for current state | Check recorder.state before actions     |
| `SecurityError`     | Stream isolation violated           | Stop recording, inform user             |
| `UnknownError`      | Unexpected failures                 | Log, attempt recovery, report           |
| `NotSupportedError` | Unsupported MIME/codec              | Fall back to supported codec            |

### 3.2 Error Event Handling (MediaRecorderErrorEvent)

```javascript
recorder.onerror = (event) => {
  const error = event.error; // DOMException
  console.error('MediaRecorder error:', error.name, error.message);

  switch (error.name) {
    case 'InvalidStateError':
      // Attempting operation on inactive recorder
      cleanup();
      break;
    case 'SecurityError':
      // Stream no longer accessible
      handleSecurityViolation(error);
      break;
    default:
      handleGenericError(error);
  }
};
```

**Note:** Error events are **not** cancelable and do not bubble.

### 3.3 Error-to-Code Mapping (from error-codes.js)

```javascript
export function mapDOMExceptionToError(exception) {
  if (!exception) return createError(CODES.UNKNOWN_ERROR);

  switch (exception.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return createError(CODES.MEDIA_PERMISSION_DENIED, exception.message);
    case 'NotFoundError':
      return createError(CODES.MEDIA_PERMISSION_DENIED, 'Requested media not found');
    case 'AbortError':
      return createError(CODES.MEDIA_TRACK_ENDED, exception.message);
    default:
      return createError(CODES.UNKNOWN_ERROR, exception.message);
  }
}
```

### 3.4 AbortController Integration

Use `AbortController` for cancellation with timeout:

```javascript
class RecordingController {
  #abortController = null;
  #recorder = null;

  async start(stream, recordingId) {
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    // Timeout for getDisplayMedia
    const timeoutId = setTimeout(() => {
      this.#abortController.abort('timeout');
    }, 30000);

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      clearTimeout(timeoutId);

      // Set up abort handler for early stop
      signal.addEventListener('abort', () => {
        this.cleanup();
      });

      this.#recorder = createMediaRecorder(displayStream, recordingId, {
        onError: (e) => this.handleError(e, signal),
      });

      this.#recorder.start(CHUNK_INTERVAL_MS);
    } catch (e) {
      clearTimeout(timeoutId);
      if (signal.aborted) {
        throw new Error('Recording cancelled');
      }
      throw e;
    }
  }

  stop() {
    this.#abortController?.abort('user_stop');
  }
}
```

---

## 4. Platform-Specific Audio Capture Issues

### 4.1 System Audio Capture Matrix

| Platform        | Browser | Tab Audio | System Audio         | Window Audio |
| --------------- | ------- | --------- | -------------------- | ------------ |
| Windows         | Chrome  | ❌        | ✅                   | ✅           |
| Windows         | Firefox | ❌        | ✅                   | ✅           |
| macOS           | Chrome  | ❌        | ✅ (M74+)            | ✅           |
| macOS           | Firefox | ❌        | ✅                   | ✅           |
| Linux (X11)     | Chrome  | ❌        | ✅                   | ✅           |
| Linux (Wayland) | Chrome  | ❌        | ⚠️ Requires PipeWire | ⚠️           |
| Linux (Wayland) | Firefox | ❌        | ⚠️ Requires PipeWire | ⚠️           |
| ChromeOS        | Chrome  | ✅        | ✅                   | ✅           |

### 4.2 macOS Audio Capture Issues

**Problem:** macOS Catalina+ requires user approval for audio capture.

```javascript
// Enable audio in getDisplayMedia constraints
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  audio: true, // Must be explicitly requested
});
```

**Solution for non-working system audio:**

1. Check if audio track exists: `stream.getAudioTracks().length > 0`
2. If not present, show user guidance to check:
   - System Preferences → Security & Privacy → Privacy → Screen Recording
   - Ensure browser has screen recording permission

### 4.3 Wayland/X11 Screen Capture

**Wayland requires PipeWire:**

```javascript
// Chrome flags for Wayland support
//flags/#enable-webrtc-pipewire-capturer

// Fallback detection
chrome: function detectScreenCaptureCapability() {
  const isWayland = navigator.platform.includes('Linux');

  if (isWayland) {
    // Check for PipeWire
    return hasPipeWireSupport();
  }
  return true; // X11 works fine
}
```

**Black screen on Wayland:**

- Chrome/Firefox run XWayland by default
- PipeWire can only capture "true Wayland" windows
- Solution: Use `chrome.tabCapture` for tab content (works without PipeWire)

### 4.4 Linux Audio Capture Constraints

```javascript
const constraints = {
  video: true,
  audio: {
    // System audio constraints for Linux
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // Linux often needs specific device selection
    deviceId: { exact: preferredDeviceId },
  },
};
```

---

## 5. Graceful Degradation Strategies

### 5.1 Codec Unavailable Recovery

```javascript
async function ensureRecording() {
  const fallbacks = [
    'video/webm;codecs=av01,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  let lastError = null;
  for (const mimeType of fallbacks) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;

    try {
      return await attemptRecording(mimeType);
    } catch (e) {
      lastError = e;
      continue; // Try next codec
    }
  }

  throw lastError; // All failed
}

async function attemptRecording(mimeType) {
  const recorder = new MediaRecorder(stream, { mimeType });

  return new Promise((resolve, reject) => {
    recorder.onerror = (e) => reject(e.error);
    recorder.onstart = () => resolve(recorder);
    recorder.start(1000);
  });
}
```

### 5.2 Microphone Failure Recovery

```javascript
async function setupAudio() {
  const micStream = null;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    logger.log('Microphone stream obtained.');
  } catch (e) {
    logger.warn('Mic request failed, proceeding without mic:', e);
    // Update UI to show mic unavailable
    updateStatus('Mic request failed. Recording without mic.');
    // Continue without mic - graceful degradation
  }

  return micStream;
}
```

### 5.3 Track Ended Recovery

```javascript
export function setupAutoStop(stream, recorder) {
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      logger.log('Video track ended, auto-stopping recorder');
      if (recorder && recorder.state !== 'inactive') {
        if (recorder.state === 'recording') {
          recorder.requestData(); // Get final chunk
        }
        recorder.stop();
      }
    });
  });
}
```

### 5.4 Chunk Save Failure Recovery

```javascript
const MAX_CHUNK_SAVE_RETRIES = 3;
const CHUNK_SAVE_RETRY_DELAY_MS = 100;

async function saveChunkWithRetry(recordingId, chunk, index) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_CHUNK_SAVE_RETRIES; attempt++) {
    try {
      await saveChunk(recordingId, chunk, index);
      return { saved: true };
    } catch (err) {
      lastError = err;
      logger.warn(`Chunk save attempt ${attempt} failed:`, err);

      if (attempt < MAX_CHUNK_SAVE_RETRIES) {
        await sleep(CHUNK_SAVE_RETRY_DELAY_MS);
      }
    }
  }

  // All retries failed
  failedChunkCount++;
  return { saved: false, error: 'CHUNK_SAVE_FAILED', chunksLost: 1 };
}
```

### 5.5 Partial Recording Recovery

```javascript
function attemptPartialSave() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    logger.log('Attempting partial save before unload');
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.requestData(); // Get final chunks
    }
    mediaRecorder.stop().catch((err) => {
      logger.warn('Partial save failed:', err);
    });
  }
}

// On page unload
window.addEventListener('beforeunload', attemptPartialSave);
```

---

## 6. Security & Permission Considerations

### 6.1 Required Permissions

| Feature         | Chrome               | Firefox          | Safari           |
| --------------- | -------------------- | ---------------- | ---------------- |
| getDisplayMedia | ✅ HTTPS             | ✅ HTTPS         | ✅ HTTPS         |
| System Audio    | ✅ (user toggle)     | ✅ (user toggle) | ✅ (user toggle) |
| Microphone      | ✅ Permission        | ✅ Permission    | ✅ Permission    |
| Tab Capture     | ✅ chrome.tabCapture | ❌               | ❌               |

### 6.2 Secure Context Requirements

**MediaRecorder requires HTTPS** in all browsers. Development exceptions:

- `localhost` (all browsers)
- `127.0.0.1` (Chrome)
- `*.localhost` (Firefox)

### 6.3 Permission Denial Handling

```javascript
try {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
} catch (error) {
  if (error.name === 'NotAllowedError') {
    // User denied or dismissed prompt
    showPermissionDeniedUI();
  } else if (error.name === 'NotFoundError') {
    // No displays available
    showNoDisplaysUI();
  }
}
```

---

## 7. Recovery Flow Diagram

```
startCapture()
    ↓
getDisplayMedia() ──[NotAllowedError]──→ Show "Permission denied"
    ↓
checkAudioTracks() ──[No audio]──→ Continue video-only
    ↓
getOptimalCodec() ──[No codec]──→ Throw NO_SUPPORTED_CODEC
    ↓
new MediaRecorder() ──[InvalidStateError]──→ Cleanup and retry
    ↓
recorder.start() ──[Error event]──→ Handle by type
    ↓
ondataavailable() ──[Save fails]──→ Retry → Partial recording
    ↓
ondataavailable() ──[Save fails]──→ Stop recording
    ↓
onstop() ──[Chunk count = 0]──→ NO_CHUNKS_RECORDED
    ↓
onstop() ──[Failed chunks > 0]──→ PARTIAL_RECORDING
    ↓
Recording complete
```

---

## 8. Monitoring & Diagnostics

### 8.1 Stats Collection

```javascript
const getStats = () => ({
  chunkIndex, // Total chunks saved
  totalSize, // Total bytes saved
  duration, // Recording duration (ms)
  failedChunks, // Failed chunk count
});

recorder.onstart = () => {
  recordingStartTime = Date.now();
  resetFailedChunkCount();
};

recorder.onstop = () => {
  const duration = Date.now() - recordingStartTime;
  if (chunkIndex === 0) {
    logger.warn('No chunks recorded!');
  }
};
```

### 8.2 Health Check Interval

```javascript
async function healthCheck(recordingId) {
  const stats = getStats();

  if (stats.failedChunks > 5) {
    await stopRecording();
    return { healthy: false, reason: 'Too many failed chunks' };
  }

  // Check chunk index is advancing
  const lastIndex = await getLastChunkIndex(recordingId);
  if (lastIndex < stats.chunkIndex - 2) {
    return { healthy: false, reason: 'Chunks not being saved' };
  }

  return { healthy: true };
}
```

---

## 9. Quick Reference

### MIME Type Priority

```javascript
// Best to fallback order
const CODEC_PRIORITY = [
  'video/webm;codecs=av01,opus', // AV1 - best compression
  'video/webm;codecs=vp9,opus', // VP9 - good compression
  'video/webm;codecs=vp8,opus', // VP8 - best compatibility
  'video/webm', // Generic webm
];
```

### Error Recovery Checklist

- [ ] Catch `NotAllowedError` → Show permission guidance
- [ ] Catch `NotFoundError` → Show source selection guidance
- [ ] Catch `AbortError` → Graceful cleanup, don't retry
- [ ] Catch `InvalidStateError` → Check recorder.state
- [ ] Catch codec errors → Fall back to supported codec
- [ ] Handle chunk save failures → Retry then degrade
- [ ] Handle track ended → Auto-stop recorder
- [ ] Handle page unload → Attempt partial save

### Platform Flags to Enable

| Platform      | Flag                               | Purpose        |
| ------------- | ---------------------------------- | -------------- |
| Linux Wayland | `#enable-webrtc-pipewire-capturer` | Screen capture |
| Chrome 104+   | None needed                        | MP4 support    |
| Safari        | None needed                        | MP4 by default |

---

_Generated from analysis of CaptureCast codebase and MDN/Chromium documentation._
