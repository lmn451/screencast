# CaptureCast - Complete Flow Analysis & XState v5 Refactoring Proposal

## Executive Summary

This document maps all 6 major flows in CaptureCast and proposes a refactored architecture using XState v5 to replace the current manual state management in `background.js`.

---

## Part 1: Current Flow Maps

### Flow 1: OFFSCREEN RECORDING (No Microphone)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         OFFSCREEN RECORDING FLOW                                    │
└─────────────────────────────────────────────────────────────────────────────────────┘

  User Action          Components                State                    IndexedDB
       │                    │                       │                         │
       ▼                    ▼                       ▼                         ▼
┌─────────────┐    ┌───────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Click Record│    │ consent.html  │    │ STATE_IDLE       │    │                  │
└──────┬──────┘    └───────┬───────┘    └────────┬─────────┘    └──────────────────┘
       │                   │                     │
       ▼                   ▼                     ▼
  ┌────────────┐    ┌──────────────┐   ┌──────────────────┐
  │ START msg  │───▶│ background.js│──▶│ STATE_STARTING   │
  └────────────┘    └───────┬───────┘   └────────┬─────────┘
                             │                     │                       │
                             ▼                     ▼                       ▼
                      ┌───────────────┐    ┌──────────────────┐   ┌────────────────┐
                      │OFFSCREEN_START│   │ persistSession() │   │                │
                      │   message     │   └──────────────────┘   └────────────────┘
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │ offscreen.js  │
                      │ getDisplayMedia()
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │ startCapture()│
                      │ createMediaRecorder()
                      └───────┬───────┘
                              │
                    ┌─────────┴─────────┐
                    │ MediaRecorder.start()
                    │ (chunks every 1s)
                    └─────────┬─────────┘
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐
│ondataavailable│   │ saveChunk() │    │ STORE_CHUNKS         │
│   every 1s   │───▶│ + retries   │───▶│ {recordingId, idx,   │
└──────────────┘    └──────────────┘    │  chunk: Blob}        │
                                         └──────────────────────┘
                              │
                              ▼
                      ┌───────────────┐
                      │OFFSCREEN_STARTED│
                      │   message      │
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │ STATE_RECORDING
                      │ updateBadge()
                      └───────────────┘

                    ════════════════════════════════════════
                           RECORDING ACTIVE (chunks saving)
                    ════════════════════════════════════════

                              │
                              ▼
                       User clicks Stop
                              │
                              ▼
┌──────────────┐    ┌───────────────┐    ┌──────────────────┐
│ STOP message │───▶│ background.js │───▶│ STATE_STOPPING    │
└──────────────┘    └───────┬───────┘    └────────┬─────────┘
                            │                     │
                            ▼                     ▼
                     ┌───────────────┐   ┌──────────────────┐
                     │OFFSCREEN_STOP │   │ persistSession() │
                     │   message     │   └──────────────────┘
                     └───────┬───────┘
                             │
                             ▼
                      ┌───────────────┐
                      │ offscreen.js  │
                      │ mediaRecorder │
                      │   .stop()     │
                      └───────┬───────┘
                              │
                              ▼
                      ┌───────────────┐
                      │ onstop callback│
                      │ finishRecording()
                      └───────┬───────┘
                              │
                              ▼
┌──────────────┐    ┌───────────────┐    ┌──────────────────┐
│OFFSCREEN_DATA│◀───│ chrome.runtime│◀───│ STORE_RECORDINGS │
│   message   │    │   .sendMessage │    │ {id, mimeType,   │
└──────┬──────┘    └───────────────┘    │  duration, size} │
       │                                    └──────────────────┘
       ▼
┌──────────────┐
│ STATE_SAVED  │
│ open preview │
└──────────────┘
```

---

### Flow 2: RECORDER PAGE (With Microphone)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         RECORDER PAGE FLOW (MICROPHONE)                             │
└─────────────────────────────────────────────────────────────────────────────────────┘

  User Action          Components                State
       │                    │                       │
       ▼                    ▼                       ▼
┌─────────────┐    ┌───────────────┐    ┌──────────────────┐
│ Click Record│    │ consent.html  │    │ STATE_IDLE       │
└──────┬──────┘    └───────┬───────┘    └────────┬─────────┘
       │                   │                     │
       ▼                   ▼                     ▼
  ┌────────────┐    ┌──────────────┐   ┌──────────────────┐
  │ START msg  │───▶│ background.js│──▶│ STATE_STARTING   │
  │ (mic=true)  │    │              │   │ strategy='page'  │
  └────────────┘    └───────┬───────┘   └────────┬─────────┘
                             │                     │
                             ▼                     ▼
                      ┌───────────────┐   ┌──────────────────┐
                      │ recorder.html│   │ chrome.tabs.create│
                      │ ?id=&mic=1&  │   └──────────────────┘
                      │   sys=1      │
                      └───────┬───────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       RECORDER TAB (recorder.js)                        │
│                                                                         │
│  1. getDisplayMedia({ video: true, audio: sys })                       │
│  2. If mic=1: getUserMedia({ audio: {...} })                          │
│  3. combineStreams({ displayStream, micStream })                       │
│  4. createMediaRecorder(combinedStream)                                │
│  5. mediaRecorder.start(CHUNK_INTERVAL_MS)                             │
│  6. RECORDER_STARTED message to background                             │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                      ┌───────────────┐
                      │ STATE_RECORDING│
                      │ updateBadge() │
                      └───────────────┘

                    ════════════════════════════════════════
                           RECORDING ACTIVE
                           (chunks every 1s)
                    ════════════════════════════════════════

                              │
                              ▼
                       User clicks Stop
                              │
                              ▼
┌──────────────┐    ┌───────────────┐    ┌──────────────────┐
│ STOP message │───▶│ background.js │───▶│ STATE_STOPPING    │
└──────────────┘    └───────┬───────┘    └────────┬─────────┘
                            │                     │
                            ▼                     ▼
                     ┌───────────────┐   ┌──────────────────┐
                     │ RECORDER_STOP │   │ chrome.tabs.remove│
                     │   message     │   │ (recorder tab)   │
                     └───────┬───────┘   └──────────────────┘
                             │
                             ▼
                      ┌───────────────┐
                      │ recorder.js   │
                      │ mediaRecorder │
                      │   .stop()     │
                      └───────┬───────┘
                             │
                             ▼
                      ┌───────────────┐
                      │ onstop callback│
                      │ finishRecording()
                      │ window.close() │
                      └────────┬────────┘
                               │
                               ▼
┌──────────────┐    ┌───────────────┐
│ RECORDER_DATA│◀───│ STORE_RECORDINGS│
│   message   │    └───────────────┘
└──────┬──────┘
       │
       ▼
┌──────────────┐
│ STATE_SAVED  │
│ open preview │
└──────────────┘
```

---

### Flow 3: STOP & SAVE (Unified)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              STOP & SAVE FLOW                                        │
└─────────────────────────────────────────────────────────────────────────────────────┘

                         STOP ENTRY POINTS
                              │
            ┌─────────────────┴─────────────────┐
            │                                   │
    ┌───────▼───────┐                   ┌───────▼───────┐
    │   OVERLAY     │                   │    POPUP      │
    │ (overlay.js)  │                   │  (popup.js)   │
    └───────┬───────┘                   └───────┬───────┘
            │                                   │
            └───────────────┬───────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ background.js   │
                   │ stopRecording() │
                   └───────┬─────────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ STATE:       │    │ OVERLAY     │    │ SAFETY      │
│ RECORDING    │    │ REMOVAL     │    │ TIMEOUT     │
│      ▼       │    │ (best effort│    │ (60s)       │
│ STOPPING     │    └─────────────┘    └──────┬──────┘
└───────┬──────┘                              │
        │                                      │
        ▼                                      ▼
┌─────────────┐                      ┌────────────────┐
│ PERSIST     │                      │ Force reset    │
│ SESSION     │                      │ STATE_IDLE     │
└───────┬─────┘                      └────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ROUTE BY STRATEGY                               │
│                                                                         │
│  ┌────────────────────────┐    ┌────────────────────────┐               │
│  │ strategy === 'offscreen' │  │ strategy === 'page'   │               │
│  │        ▼                 │  │        ▼               │               │
│  │ OFFSCREEN_STOP message   │  │ RECORDER_STOP message  │               │
│  └────────────┬─────────────┘  └────────────┬─────────────┘            │
│               │                             │                          │
│               └─────────────┬───────────────┘                          │
│                             │                                           │
│                             ▼                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    RECORDER/OFFSCREEN PROCESS                     │  │
│  │                                                                   │  │
│  │   1. mediaRecorder.requestData()  ← Triggers ondataavailable    │  │
│  │   2. mediaRecorder.stop()         ← Triggers onstop              │  │
│  │                                                                   │  │
│  │   3. onstop callback:                                          │  │
│  │      - Calculate duration                                       │  │
│  │      - Determine status: SAVED / PARTIAL / FAILED               │  │
│  │                                                                   │  │
│  │   4. finishRecording():                                         │  │
│  │      - Create blob from chunks                                  │  │
│  │      - Store in IndexedDB                                        │  │
│  │                                                                   │  │
│  │   5. Send DATA message:                                         │  │
│  │      OFFSCREEN_DATA or RECORDER_DATA                             │  │
│  │                                                                   │  │
│  │   6. Cleanup:                                                    │  │
│  │      - Stop all tracks                                          │  │
│  │      - Null references                                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                             │                                           │
│                             ▼                                           │
│              ┌────────────────────────────┐                            │
│              │ STATE: STOPPING → SAVING   │                            │
│              └────────────┬───────────────┘                            │
│                           │                                             │
│                           ▼                                             │
│              ┌────────────────────────────┐                            │
│              │ background.js receives     │                            │
│              │ DATA message               │                            │
│              └────────────┬───────────────┘                            │
│                           │                                             │
│                           ▼                                             │
│              ┌────────────────────────────┐                            │
│              │ STATE: SAVING → SAVED       │                            │
│              │ clearSessionSnapshot()     │                            │
│              │ open preview.html          │                            │
│              └────────────────────────────┘                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Flow 4: CRASH RECOVERY

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           CRASH RECOVERY FLOW                                       │
└─────────────────────────────────────────────────────────────────────────────────────┘

                         CHROME STARTUP
                              │
                              ▼
                  ┌─────────────────────────┐
                  │ reconcileUnfinishedSessions()│
                  │   background.js (line 93)   │
                  └────────────┬──────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │ chrome.storage.local.get │
                  │   (SESSION_SNAPSHOT_KEY) │
                  └────────────┬──────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │ Snapshot exists?        │
                  └────────────┬────────────┘
                     │               │
                    NO              YES
                     │               │
                     ▼               ▼
               ┌─────────┐   ┌──────────────────┐
               │ Return  │   │ age = now -     │
               │ (idle)  │   │ snapshot.last   │
               └─────────┘   │ ActivityAt      │
                             └────────┬─────────┘
                                      │
                                      ▼
                    ┌──────────────────────────┐
                    │ age > STOP_TIMEOUT_MS   │
                    │       (60 seconds)       │
                    └────────────┬─────────────┘
                       │               │
                      NO              YES
                       │               │
                       ▼               ▼
             ┌────────────────┐  ┌─────────────────────┐
             │ "Active session│  │ STALE SESSION       │
             │  will reconcile│  │ 1. clearSession()   │
             └────────────────┘  │ 2. hasChunks(id)?    │
                                └────────┬──────────────┘
                                         │
                               ┌─────────┴─────────┐
                              NO                   YES
                               │                   │
                               ▼                   ▼
                      ┌─────────────┐    ┌─────────────────┐
                      │ Delete fully│    │ markRecording   │
                      │ (nothing to│    │ Recoverable()   │
                      │ recover)    │    │ status='partial'│
                      └─────────────┘    └─────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                      SESSION SNAPSHOT SCHEMA                                │
│  {                                                                         │
│    recordingId: string,        // UUID of current recording                │
│    status: StateValue,          // Current state machine state              │
│    startedAt: timestamp,        // When recording started                  │
│    lastActivityAt: timestamp,   // Last state change (age calculation)     │
│    options: {                   // Recording configuration                  │
│      mode: 'tab'|'screen'|'window',                                       │
│      includeMic: boolean,                                                │
│      includeSystemAudio: boolean                                         │
│    },                                                                     │
│    strategy: 'offscreen'|'page',                                         │
│    correlationId: string         // Request tracking ID                   │
│  }                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                      STATE PRESERVATION MATRIX                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ Component              │ In Snapshot │ Lost on Crash │ Notes                │
├────────────────────────┼────────────┼───────────────┼──────────────────────┤
│ recordingId            │     ✅     │       -       │ Retrieved from snap  │
│ status                 │     ✅     │       -       │ Recovery path        │
│ startedAt              │     ✅     │       -       │ Duration calc        │
│ lastActivityAt         │     ✅     │       -       │ Stale detection      │
│ options.*              │     ✅     │       -       │ Restored for preview │
│ strategy               │     ✅     │       -       │ offscreen vs page    │
│ correlationId          │     ✅     │       -       │ Log correlation      │
│ Video chunks           │ IndexedDB  │       -       │ Separate storage     │
│ overlayTabId           │     ❌     │     Lost      │ Not persisted        │
│ recorderTabId          │     ❌     │     Lost      │ Not persisted        │
│ MediaStream            │     ❌     │     Lost      │ Cannot restore       │
│ MediaRecorder          │     ❌     │     Lost      │ Must recreate        │
└────────────────────────┴────────────┴───────────────┴──────────────────────┘
```

---

### Flow 5: PREVIEW & VIEW

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            PREVIEW & VIEW FLOW                                       │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│                         PREVIEW PAGE                                     │
│                      (preview.html?id=xxx)                              │
└───────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ 1. Validate UUID format │
                    │ 2. getRecording(id)     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                        │
                    ▼                        ▼
           ┌──────────────┐        ┌──────────────┐
           │   Success    │        │    Error     │
           │ { blob,      │        │ Show error   │
           │  metadata }  │        │ message      │
           └───────┬──────┘        └──────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                    DURATION NORMALIZATION                                │
│  fixDurationAndReset(video)                                              │
│                                                                        │
│  Problem: WebM files may report duration=Infinity until fully loaded   │
│                                                                        │
│  ┌─────────────┐                                                       │
│  │ Already     │──── Yes ──▶ Mark STABLE, show video                  │
│  │ finite?     │                      (return)                         │
│  └──────┬──────┘                                                       │
│         │ No                                                           │
│         ▼                                                              │
│  ┌─────────────┐                                                       │
│  │ video.current│                                                      │
│  │ Time = BIG  │──── Seeks to large position                          │
│  │ (2^62)      │      (forces full file parse)                         │
│  └──────┬──────┘                                                       │
│         │                                                              │
│         ▼                                                              │
│  ┌─────────────┐     ┌─────────────┐                                  │
│  │ Success?    │─No─▶│ Fallback:   │                                  │
│  │ (duration   │     │ seekable.end│                                  │
│  │ finite)     │     │             │                                  │
│  └──────┬──────┘     └─────────────┘                                  │
│         │ Yes                                                         │
│         ▼                                                              │
│  ┌─────────────┐                                                       │
│  │ video.current│                                                      │
│  │ Time = 0    │──── Reset to start                                    │
│  └──────┬──────┘      mark STABLE                                      │
│         │                                                              │
│         ▼                                                              │
│  ┌─────────────┐                                                       │
│  │ Show video  │──── Video element visible                             │
│  └─────────────┘                                                       │
└────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │  UI Renders:            │
                    │  - Video element        │
                    │  - Filename input       │
                    │  - Download button      │
                    │  - Delete button       │
                    │  - View All button      │
                    └─────────────────────────┘


┌───────────────────────────────────────────────────────────────────────────┐
│                         DOWNLOAD FLOW                                     │
└───────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ User clicks Download    │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
           ┌──────────────┐         ┌──────────────┐
           │ Save custom  │         │ Clear saved   │
           │ name to DB   │         │ name if input │
           │ (optional)   │         │ cleared      │
           └───────┬──────┘         └───────┬──────┘
                   │                         │
                   └────────────┬────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ saveFile(blob, filename)│
                    │ <a download> click     │
                    └─────────────────────────┘


┌───────────────────────────────────────────────────────────────────────────┐
│                         DELETE FLOW                                      │
└───────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ User clicks Delete      │
                    │ confirm('Delete?')     │
                    └────────────┬────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ deleteRecording(id)     │
                    │   → STORE_RECORDINGS    │
                    │ deleteChunks(id)        │
                    │   → STORE_CHUNKS        │
                    └────────────┬────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ Show "Deleted" message │
                    └─────────────────────────┘
```

---

### Flow 6: CHUNK STORAGE DATA PIPELINE

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         CHUNK STORAGE DATA FLOW                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          RAW MEDIA CAPTURE                                    │
│                                                                         │
│  navigator.mediaDevices.getDisplayMedia()                               │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────┐                                                     │
│  │ MediaStream     │ ← Contains video + audio tracks                     │
│  │ (raw frames)    │                                                     │
│  └────────┬────────┘                                                     │
│           │                                                              │
└───────────┼──────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ENCODING                                            │
│                                                                         │
│  const recorder = new MediaRecorder(stream, { mimeType })                │
│  recorder.start(CHUNK_INTERVAL_MS)  // 1000ms                            │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │              RECORDING LOOP (fires every ~1 second)                │ │
│  │                                                                   │ │
│  │   recorder.ondataavailable = (e) => {                            │ │
│  │     if (e.data && e.data.size > 0) {                             │ │
│  │       totalSize += e.data.size                                    │ │
│  │       saveChunkWithRetry(recordingId, e.data, index)              │ │
│  │       index++                                                     │ │
│  │     }                                                             │ │
│  │   }                                                               │ │
│  │                                                                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SAVE CHUNK WITH RETRY                                  │
│                                                                         │
│  async function saveChunkWithRetry(recordingId, chunk, index) {         │
│    for (attempt = 1; attempt <= 3; attempt++) {                         │
│      try {                                                              │
│        await saveChunk(recordingId, chunk, index);                      │
│        return { saved: true };                                          │
│      } catch (err) {                                                    │
│        lastError = err;                                                 │
│        if (attempt < 3) await delay(100ms);                            │
│      }                                                                  │
│    }                                                                    │
│    failedChunkCount++;                                                  │
│    return { saved: false, error: 'CHUNK_SAVE_FAILED' };                │
│  }                                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          INDEXEDDB STORAGE                                  │
│                                                                         │
│  DATABASE: CaptureCastDB (version 3)                                     │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  STORE_CHUNKS                                                     │    │
│  │  ├─ keyPath: ['recordingId', 'index'] (compound key)             │    │
│  │  ├─ index: 'recordingId' (non-unique)                           │    │
│  │  │                                                                │    │
│  │  │ Records:                                                       │    │
│  │  │ { recordingId: "uuid", index: 0, chunk: Blob<video/webm> }   │    │
│  │  │ { recordingId: "uuid", index: 1, chunk: Blob<video/webm> }   │    │
│  │  │ { recordingId: "uuid", index: 2, chunk: Blob<video/webm> }   │    │
│  │  │ ...                                                            │    │
│  │  │                                                                │    │
│  │  └─ Indexed by recordingId for fast retrieval                     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  STORE_RECORDINGS                                                │    │
│  │  ├─ keyPath: 'id'                                                │    │
│  │  │                                                                │    │
│  │  │ Records:                                                       │    │
│  │  │ { id: "uuid", mimeType: "video/webm", duration: 30000,        │    │
│  │  │     size: 1500000, createdAt: 1234567890,                     │    │
│  │  │     name: null, status: "saved" }                            │    │
│  │  │                                                                │    │
│  │  └─ Status values: 'recording' | 'saving' | 'saved' | 'failed'  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      RECORDING ASSEMBLY (on preview)                      │
│                                                                         │
│  async function getRecording(id) {                                       │
│    1. Get metadata from STORE_RECORDINGS[id]                            │
│    2. Get all chunks: STORE_CHUNKS.index.recordingId.getAll(id)         │
│    3. Sort chunks by index ascending                                     │
│    4. Concatenate: new Blob(chunks, { type: meta.mimeType })            │
│    5. Return { blob, ...metadata }                                       │
│  }                                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 2: Current State Management Issues

### Current Implementation (background.js)

The current state management is scattered across multiple files with manual state tracking:

```javascript
// background.js - Lines 32-49
const STATE = {
  status: STATE_IDLE, // Manual state enum
  recordingId: null, // Separate tracking
  correlationId: null, // Separate tracking
  overlayTabId: null, // Separate tracking
  recorderTabId: null, // Separate tracking
  strategy: null, // Separate tracking
  stopTimeoutId: null, // Timeout tracking
  startedAt: null, // Timestamp tracking
  lastActivityAt: null, // Timestamp tracking
  options: { mode: null, includeMic: false, includeSystemAudio: false },
};
```

### Problems Identified

1. **Scattered State**: State spread across 10+ properties, no single source of truth
2. **No Atomic Transitions**: Manual `validateStateTransition()` calls, easy to forget
3. **Race Conditions**: Multiple async operations, no guarantee of ordering
4. **Timeout Complexity**: Manual timeout management with IDs stored in state
5. **No Action Boundaries**: Side effects mixed with state logic
6. **Testing Difficulty**: Hard to mock/test individual transitions
7. **Message Validation**: Manual schema checking scattered in listener

---

## Part 3: XState v5 Refactoring Proposal

### Why XState v5?

- **Actor Model**: Perfect for extension where components communicate via messages
- **Type Safety**: Full TypeScript support with `setup()` API
- **Predictable**: Actions execute in deterministic order
- **Testable**: State machine logic can be unit tested independently
- **Visualizable**: Can use Stately Studio for visual editing
- **Hierarchical**: Can model complex states (e.g., recording substates)

### Key XState v5 Changes from v4

| v4                      | v5                                        |
| ----------------------- | ----------------------------------------- |
| `Machine()`             | `createMachine()`                         |
| `interpret()`           | `createActor()`                           |
| `machine.withConfig()`  | `machine.provide()`                       |
| `machine.withContext()` | Use `input`                               |
| `send()`                | `raise()` or `sendTo()`                   |
| `pure()`                | `enqueueActions()`                        |
| `spawn()`               | `spawnChild()` or `spawn()` from assigner |
| `cond`                  | `guard`                                   |
| `state.done`            | `snapshot.status === 'done'`              |

---

## Part 4: Proposed XState v5 Architecture

### Package Installation

```bash
npm install xstate@5
npm install @xstate/vue@5  # if using Vue
# or @xstate/react@5 for React
```

### Machine Definition

```typescript
// src/machines/recordingMachine.ts
import { setup, createMachine, assign, createActor, fromCallback } from 'xstate';

// Types
interface RecordingContext {
  recordingId: string | null;
  correlationId: string | null;
  strategy: 'offscreen' | 'page' | null;
  overlayTabId: number | null;
  recorderTabId: number | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  options: {
    mode: 'tab' | 'screen' | 'window' | null;
    includeMic: boolean;
    includeSystemAudio: boolean;
  };
  error: string | null;
  failedChunkCount: number;
}

type RecordingEvent =
  | { type: 'START'; mode: 'tab' | 'screen' | 'window'; mic?: boolean; systemAudio?: boolean }
  | { type: 'STOP' }
  | { type: 'OFFSCREEN_STARTED' }
  | { type: 'RECORDER_STARTED' }
  | { type: 'OFFSCREEN_DATA'; recordingId: string; mimeType: string }
  | { type: 'RECORDER_DATA'; recordingId: string; mimeType: string }
  | { type: 'OFFSCREEN_ERROR'; error: string }
  | { type: 'TIMEOUT' }
  | { type: 'RESET' }
  | { type: 'RECONCILE'; snapshot: Partial<RecordingContext> };

// Machine setup with typed context and events
export const recordingMachine = setup({
  types: {
    context: {} as RecordingContext,
    events: {} as RecordingEvent,
    input: {} as { snapshot?: Partial<RecordingContext> },
  },
  actions: {
    // Initialize recording
    initializeRecording: assign({
      recordingId: () => crypto.randomUUID(),
      correlationId: () => crypto.randomUUID(),
      startedAt: () => Date.now(),
      lastActivityAt: () => Date.now(),
      error: () => null,
      failedChunkCount: () => 0,
    }),

    // Update options
    setOptions: assign({
      options: ({ event }) => ({
        mode: event.mode,
        includeMic: event.mic ?? false,
        includeSystemAudio: event.systemAudio ?? false,
      }),
    }),

    // Persist session to chrome.storage.local
    persistSnapshot: ({ context }) => {
      chrome.storage.local.set({
        sessionSnapshot: {
          recordingId: context.recordingId,
          status: 'recording',
          startedAt: context.startedAt,
          lastActivityAt: context.lastActivityAt,
          options: context.options,
          strategy: context.strategy,
          correlationId: context.correlationId,
        },
      });
    },

    // Clear session snapshot
    clearSnapshot: () => {
      chrome.storage.local.remove('sessionSnapshot');
    },

    // Update last activity timestamp
    touchActivity: assign({
      lastActivityAt: () => Date.now(),
    }),

    // Set strategy
    setStrategy: assign({
      strategy: ({ context }) => (context.options.includeMic ? 'page' : 'offscreen'),
    }),

    // Record error
    setError: assign({
      error: ({ event }) => ('error' in event ? event.error : 'Unknown error'),
      lastActivityAt: () => Date.now(),
    }),

    // Increment failed chunk count
    incrementFailedChunks: assign({
      failedChunkCount: ({ context }) => context.failedChunkCount + 1,
    }),

    // Set overlay tab ID
    setOverlayTab: assign({
      overlayTabId: () => {
        // Query active tab
        return chrome.tabs
          .query({ active: true, currentWindow: true })
          .then((tabs) => tabs[0]?.id ?? null);
      },
    }),

    // Set recorder tab ID
    setRecorderTab: assign({
      recorderTabId: ({ event }) => ('tabId' in event ? event.tabId : null),
    }),

    // Cleanup overlay
    removeOverlay: ({ context }) => {
      if (context.overlayTabId) {
        chrome.scripting
          .executeScript({
            target: { tabId: context.overlayTabId },
            func: () => {
              const el = document.getElementById('cc-overlay');
              if (el) el.remove();
            },
          })
          .catch(() => {}); // Best effort
      }
    },

    // Open preview page
    openPreview: ({ context }) => {
      if (context.recordingId) {
        const url = chrome.runtime.getURL(`preview.html?id=${context.recordingId}`);
        chrome.tabs.create({ url });
      }
    },

    // Close recorder tab
    closeRecorderTab: ({ context }) => {
      if (context.recorderTabId) {
        chrome.tabs.remove(context.recorderTabId).catch(() => {});
      }
    },

    // Close offscreen document
    closeOffscreen: () => {
      if (chrome.offscreen) {
        chrome.offscreen.closeDocument().catch(() => {});
      }
    },
  },
  guards: {
    // Check if microphone is needed
    needsMicrophone: ({ context }) => context.options?.includeMic === true,

    // Check if recording ID is valid
    isValidUUID: ({ event }) => {
      if ('recordingId' in event) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          event.recordingId
        );
      }
      return false;
    },

    // Check for concurrent recording
    noConcurrentRecording: () => {
      // Could check chrome.storage.local for active snapshot
      return true; // Simplified
    },

    // Check storage quota
    hasStorageQuota: () => {
      // Would call checkStorageQuota()
      return true; // Simplified
    },
  },
  actors: {
    // Offscreen document actor
    offscreenRecorder: fromCallback<
      EventObject,
      { mode: string; recordingId: string; includeAudio: boolean }
    >({
      on: {
        START: {
          actions: 'startOffscreenRecording',
        },
        STOP: {
          actions: 'stopOffscreenRecording',
        },
      },
    }),
  },
  delays: {
    // Confirmation timeout (5 seconds)
    confirmationTimeout: 5000,

    // Save timeout (60 seconds)
    saveTimeout: 60000,
  },
}).createMachine({
  id: 'recording',
  initial: 'idle',
  context: {
    recordingId: null,
    correlationId: null,
    strategy: null,
    overlayTabId: null,
    recorderTabId: null,
    startedAt: null,
    lastActivityAt: null,
    options: {
      mode: null,
      includeMic: false,
      includeSystemAudio: false,
    },
    error: null,
    failedChunkCount: 0,
  },
  states: {
    // ═══════════════════════════════════════════════════════
    // IDLE STATE
    // ═══════════════════════════════════════════════════════
    idle: {
      on: {
        START: {
          target: 'starting',
          actions: ['initializeRecording', 'setOptions', 'persistSnapshot'],
        },
        RECONCILE: {
          target: 'recording', // Rehydrate to recording state
          actions: assign(({ event }) => ({
            recordingId: event.snapshot.recordingId,
            correlationId: event.snapshot.correlationId,
            strategy: event.snapshot.strategy,
            startedAt: event.snapshot.startedAt,
            lastActivityAt: event.snapshot.lastActivityAt,
            options: event.snapshot.options,
          })),
        },
      },
      entry: 'clearSnapshot',
    },

    // ═══════════════════════════════════════════════════════
    // STARTING STATE
    // ═══════════════════════════════════════════════════════
    starting: {
      entry: ['touchActivity', 'setStrategy'],
      invoke: {
        src: 'createRecorderActor',
        input: ({ context }) => ({
          strategy: context.strategy,
          recordingId: context.recordingId,
          options: context.options,
        }),
        onDone: {
          // Determined by strategy
          target: 'recording',
        },
        onError: {
          target: 'failed',
          actions: 'setError',
        },
      },
      after: {
        confirmationTimeout: {
          target: 'recording', // Fallback if no confirmation
          actions: 'touchActivity',
        },
      },
      on: {
        OFFSCREEN_STARTED: {
          target: 'recording',
          actions: 'touchActivity',
        },
        RECORDER_STARTED: {
          target: 'recording',
          actions: 'touchActivity',
        },
        STOP: {
          target: 'idle', // Abort start
          actions: 'clearSnapshot',
        },
      },
    },

    // ═══════════════════════════════════════════════════════
    // RECORDING STATE
    // ═══════════════════════════════════════════════════════
    recording: {
      entry: ['touchActivity', 'persistSnapshot', 'updateBadge'],
      exit: ['removeOverlay'],
      on: {
        STOP: {
          target: 'stopping',
          actions: ['touchActivity', 'persistSnapshot'],
        },
        OFFSCREEN_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
      },
      // Sub-state for recording phase
      initial: 'active',
      states: {
        active: {
          // Recording in progress
          entry: 'injectOverlay',
          // Could track chunks, duration, etc.
        },
      },
    },

    // ═══════════════════════════════════════════════════════
    // STOPPING STATE
    // ═══════════════════════════════════════════════════════
    stopping: {
      entry: ['touchActivity', 'persistSnapshot', 'updateBadge'],
      invoke: {
        src: 'sendStopSignal',
        input: ({ context }) => ({
          strategy: context.strategy,
        }),
        onDone: {
          target: 'saving',
        },
        onError: {
          target: 'failed',
          actions: 'setError',
        },
      },
      after: {
        saveTimeout: {
          target: 'idle',
          actions: ['clearSnapshot', 'resetState'],
        },
      },
      on: {
        TIMEOUT: {
          target: 'idle',
          actions: ['clearSnapshot', 'resetState'],
        },
      },
    },

    // ═══════════════════════════════════════════════════════
    // SAVING STATE
    // ═══════════════════════════════════════════════════════
    saving: {
      entry: ['touchActivity', 'updateBadge'],
      on: {
        OFFSCREEN_DATA: [
          {
            guard: 'isValidUUID',
            target: 'saved',
            actions: ['touchActivity', 'openPreview'],
          },
        ],
        RECORDER_DATA: [
          {
            guard: 'isValidUUID',
            target: 'saved',
            actions: ['touchActivity', 'openPreview', 'closeRecorderTab'],
          },
        ],
        TIMEOUT: {
          target: 'recoverable',
          actions: 'setError',
        },
      },
    },

    // ═══════════════════════════════════════════════════════
    // SAVED STATE (Final)
    // ═══════════════════════════════════════════════════════
    saved: {
      entry: ['clearSnapshot', 'touchActivity'],
      always: {
        target: 'idle',
        after: 1000, // Auto-reset after showing saved confirmation
      },
    },

    // ═══════════════════════════════════════════════════════
    // FAILED STATE
    // ═══════════════════════════════════════════════════════
    failed: {
      entry: ['clearSnapshot', 'touchActivity', 'updateBadge'],
      on: {
        RESET: 'idle',
      },
    },

    // ═══════════════════════════════════════════════════════
    // RECOVERABLE STATE
    // ═══════════════════════════════════════════════════════
    recoverable: {
      entry: ['touchActivity', 'updateBadge'],
      description: 'Recording saved but some chunks failed. User can recover.',
      on: {
        // Could retry saving remaining chunks
        RETRY: 'saving',
        RESET: 'idle',
      },
    },
  },

  // Global event handlers
  on: {
    RESET: {
      target: 'idle',
      actions: ['clearSnapshot', 'resetState'],
    },
  },
});

// Helper to create recorder actor based on strategy
const createRecorderActor = ({ context }: { context: RecordingContext }) => {
  if (context.options.includeMic) {
    // Page strategy - open recorder tab
    return fromCallback({
      start: () => {
        const url = chrome.runtime.getURL(
          `recorder.html?id=${context.recordingId}&mode=${context.options.mode}&mic=1&sys=${
            context.options.includeSystemAudio ? 1 : 0
          }`
        );
        return chrome.tabs.create({ url, active: true });
      },
    });
  } else {
    // Offscreen strategy
    return fromCallback({
      start: () => {
        return ensureOffscreenDocument().then(() => {
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START',
            mode: context.options.mode,
            includeAudio: context.options.includeSystemAudio,
            recordingId: context.recordingId,
          });
        });
      },
    });
  }
};
```

### Usage in Background Script

```typescript
// background.ts
import { createActor } from 'xstate';
import { recordingMachine } from './machines/recordingMachine.ts';

class RecordingStateManager {
  private actor;
  private subscription;

  constructor() {
    // Create actor from machine
    this.actor = createActor(recordingMachine, {
      snapshot: this.loadSnapshot(), // Restore from storage
    });

    // Subscribe to state changes
    this.subscription = this.actor.subscribe((snapshot) => {
      this.onStateChange(snapshot);
    });

    // Start the actor
    this.actor.start();

    // Set up message listener
    this.setupMessageListener();
  }

  private loadSnapshot() {
    // Could restore from chrome.storage.local
    return undefined; // Simplified
  }

  private onStateChange(snapshot: Snapshot<RecordingContext>) {
    // Update badge, UI, etc. based on state
    const stateName = snapshot.value;
    console.log(`State: ${stateName}`, snapshot.context);

    // Update badge
    this.updateBadge(stateName as string);

    // Persist state
    if (stateName !== 'idle') {
      this.persistState(snapshot);
    }
  }

  private updateBadge(state: string) {
    let color = '#00000000';
    let text = '';

    switch (state) {
      case 'recording':
        color = '#d93025';
        text = 'REC';
        break;
      case 'saving':
        color = '#f9ab00';
        text = 'SAVE';
        break;
    }

    chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    chrome.action.setBadgeText({ text }).catch(() => {});
  }

  private setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Validate sender
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: 'Unauthorized' });
        return;
      }

      // Route to state machine
      const event = this.mapMessageToEvent(message);
      if (event) {
        this.actor.send(event);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    });
  }

  private mapMessageToEvent(message: any) {
    switch (message.type) {
      case 'START':
        return {
          type: 'START',
          mode: message.mode,
          mic: message.mic,
          systemAudio: message.systemAudio,
        };
      case 'STOP':
        return { type: 'STOP' };
      case 'OFFSCREEN_STARTED':
        return { type: 'OFFSCREEN_STARTED' };
      case 'RECORDER_STARTED':
        return { type: 'RECORDER_STARTED' };
      case 'OFFSCREEN_DATA':
        return {
          type: 'OFFSCREEN_DATA',
          recordingId: message.recordingId,
          mimeType: message.mimeType,
        };
      case 'RECORDER_DATA':
        return {
          type: 'RECORDER_DATA',
          recordingId: message.recordingId,
          mimeType: message.mimeType,
        };
      case 'OFFSCREEN_ERROR':
        return { type: 'OFFSCREEN_ERROR', error: message.error };
      default:
        return null;
    }
  }

  // Cleanup
  destroy() {
    this.actor.stop();
    this.subscription.unsubscribe();
  }
}

// Initialize
const manager = new RecordingStateManager();
```

### Testing the State Machine

```typescript
// __tests__/recordingMachine.test.ts
import { createMachine, createActor } from 'xstate';
import { recordingMachine } from '../src/machines/recordingMachine';

describe('Recording State Machine', () => {
  it('should transition from idle to starting on START event', () => {
    const actor = createActor(recordingMachine);
    actor.start();

    actor.send({ type: 'START', mode: 'tab' });

    expect(actor.getSnapshot().value).toBe('starting');
  });

  it('should transition to recording after OFFSCREEN_STARTED', () => {
    const actor = createActor(recordingMachine);
    actor.start();

    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });

    expect(actor.getSnapshot().value).toBe('recording');
  });

  it('should transition to saved after OFFSCREEN_DATA', () => {
    const actor = createActor(recordingMachine);
    actor.start();

    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    actor.send({ type: 'STOP' });
    actor.send({ type: 'OFFSCREEN_DATA', recordingId: 'test-uuid', mimeType: 'video/webm' });

    expect(actor.getSnapshot().value).toBe('saved');
  });

  it('should handle OFFSCREEN_ERROR and transition to failed', () => {
    const actor = createActor(recordingMachine);
    actor.start();

    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'Test error' });

    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('Test error');
  });
});
```

---

## Part 5: Complete State Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         CAPTURECAST STATE MACHINE                                   │
│                           (XState v5 Implementation)                                 │
└─────────────────────────────────────────────────────────────────────────────────────┘

                                                    ┌─────────────────┐
                                                    │                 │
                                                    │                 │
                                                    │    IDLE         │
                                                    │                 │
                                                    │  initial state  │
                                                    │                 │
                                                    └────────┬────────┘
                                                             │
                                                             │ START
                                                             ▼
                                                     ┌─────────────────┐
                                                     │                 │
                                                     │   STARTING      │
                                                     │                 │
                                                     │  - initialize   │
                                                     │  - set strategy │
                                                     │  - 5s timeout   │
                                                     └────────┬────────┘
                                                             │
                           ┌─────────────────────────────────┼─────────────────────────────────┐
                           │                                 │                                 │
                           ▼                                 ▼                                 │
                    ┌──────────────┐                  ┌──────────────┐                        │
                    │  (timeout)   │                  │              │                        │
                    └──────────────┘                  │   RECORDING  │◀─────────────┐         │
                                                      │              │              │         │
                                                      │  - persist   │              │         │
                                                      │  - badge     │              │         │
                                                      │  - overlay   │              │         │
                                                      └───────┬──────┘              │         │
                                                              │                     │         │
                                                              │ STOP                │ OFFSCREEN│
                                                              ▼                     │ ERROR   │
                                                      ┌──────────────┐              │         │
                                                      │              │              │         │
                                                      │  STOPPING    │              │         │
                                                      │              │              │         │
                                                      │  - stop signal             │         │
                                                      │  - 60s timeout│              │         │
                                                      └───────┬──────┘              │         │
                                                              │                     │         │
                                                              │ (complete)          │         │
                                                              ▼                     └─────────┘
                                                      ┌──────────────┐
                                                      │              │
                                                      │   SAVING     │
                                                      │              │
                                                      │  - waiting   │
                                                      │    for data  │
                                                      │  - timeout   │
                                                      └───────┬──────┘
                                                              │
                           ┌───────────────────────────────────┼───────────────────────────────────┐
                           │                                   │                                   │
                           ▼                                   ▼                                   │
                    ┌──────────────┐                    ┌──────────────┐                    ┌──────────────┐
                    │              │                    │              │                    │              │
                    │    SAVED     │                    │  RECOVERABLE │                    │   FAILED     │
                    │              │                    │              │                    │              │
                    │  - preview   │                    │  - partial  │                    │  - error     │
                    │  - auto-reset│                    │    chunks   │                    │  - reset btn │
                    └──────────────┘                    └──────────────┘                    └──────┬───────┘
                                                              │                                   │
                                                              │ RETRY                              │ RESET
                                                              ▼                                   ▼
                                                      ┌──────────────┐                    ┌──────────────┐
                                                      │   SAVING     │                    │    IDLE      │
                                                      └──────────────┘                    └──────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                              EVENT SUMMARY                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ Event                  │ From              │ Target State │ Action          │
├────────────────────────┼───────────────────┼──────────────┼─────────────────┤
│ START                 │ Popup             │ STARTING     │ init + persist   │
│ OFFSCREEN_STARTED     │ Offscreen         │ RECORDING   │ badge update     │
│ RECORDER_STARTED      │ Recorder tab      │ RECORDING   │ badge update     │
│ STOP                  │ Popup/Overlay     │ STOPPING    │ remove overlay   │
│ OFFSCREEN_DATA        │ Offscreen         │ SAVED       │ open preview     │
│ RECORDER_DATA         │ Recorder tab      │ SAVED       │ open preview     │
│ OFFSCREEN_ERROR       │ Offscreen         │ FAILED      │ set error        │
│ TIMEOUT               │ Internal          │ varies      │ varies           │
│ RESET                 │ User/Recovery     │ IDLE        │ clear + reset    │
└────────────────────────┴───────────────────┴──────────────┴─────────────────┘
```

---

## Part 6: Implementation Roadmap

### Phase 1: Core Machine

- [ ] Define `recordingMachine` with all states and transitions
- [ ] Add context types and event types
- [ ] Implement action creators
- [ ] Add guard conditions

### Phase 2: Integration

- [ ] Replace `background.js` state with actor
- [ ] Wire up message listener to actor events
- [ ] Add badge updates based on state
- [ ] Implement session persistence via actor

### Phase 3: Actors

- [ ] Create offscreen actor for recording
- [ ] Create recorder page coordination
- [ ] Implement error handling actors

### Phase 4: Testing

- [ ] Unit tests for all transitions
- [ ] Integration tests with mocked Chrome APIs
- [ ] E2E tests with Playwright

### Phase 5: Cleanup

- [ ] Remove legacy state management code
- [ ] Update ARCHITECTURE.md with new diagram
- [ ] Document machine for future developers

---

## Part 7: File Structure

```
screencast/
├── src/
│   ├── machines/
│   │   ├── recordingMachine.ts      # Main recording state machine
│   │   └── types.ts                  # Shared types
│   ├── actors/
│   │   ├── offscreenActor.ts         # Offscreen document actor
│   │   └── recorderActor.ts          # Recorder tab actor
│   ├── services/
│   │   ├── storageService.ts         # IndexedDB operations
│   │   └── chromeService.ts          # Chrome API wrappers
│   └── background.ts                 # Refactored with XState
├── tests/
│   ├── machines/
│   │   └── recordingMachine.test.ts  # State machine tests
│   └── actors/
│       └── offscreenActor.test.ts
└── package.json
```

---

## Appendix: Current vs Proposed Comparison

| Aspect          | Current (Manual)                | Proposed (XState v5)      |
| --------------- | ------------------------------- | ------------------------- |
| State Location  | `STATE` object in background.js | `context` in machine      |
| Transitions     | Manual function calls           | Declarative transitions   |
| Validation      | `validateStateTransition()`     | Built-in guard conditions |
| Side Effects    | Mixed in functions              | `actions:` block          |
| Async Handling  | Manual promises                 | `invoke:` with actors     |
| Testing         | Integration tests               | Unit tests on machine     |
| Visualization   | Code only                       | Stately Studio compatible |
| Type Safety     | Partial (JSDoc)                 | Full TypeScript           |
| Message Routing | Manual switch statement         | Event-driven dispatch     |
