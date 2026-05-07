# Service Worker Analysis: CaptureCast Background.js

## What Breaks When SW Suspends During Recording

### Immediate Failures

1. **In-memory state loss** (lines 32-49):

   ```javascript
   const STATE = {
     status: STATE_IDLE,
     recordingId: null,
     startedAt: null,
     lastActivityAt: null,
     options: {...},
     stopTimeoutId: null,  // TIMER LOST ON SUSPENSION
     // ...
   };
   ```

   All STATE variables are in-memory only. SW suspension = instant state reset.

2. **Active timers cancelled**:

   - `STATE.stopTimeoutId` - the 5-second confirmation timeout (lines 316-326)
   - `STATE.stopTimeoutId` - the STOP_TIMEOUT_MS safety timeout (lines 370-376)
   - Any pending `setTimeout()` calls are terminated

3. **In-flight IndexedDB transactions**:
   - `saveChunk()` operations without await completion
   - `persistSessionSnapshot()` may not complete
   - `clearSessionSnapshot()` partial state

### Graceful Degradation (What Still Works)

1. **IndexedDB data persists**:

   - Already-saved chunks remain in IndexedDB
   - `markRecordingRecoverable()` marks partial status
   - Recording metadata survives

2. **Chrome storage survives**:

   - `chrome.storage.local` snapshot persists
   - Session data survives SW restart

3. **Extension badge/icon state**:
   - May show stale status briefly

## Timer Loss on Suspension

### Timer 1: Confirmation Timeout (5 seconds)

**Location**: lines 316-326

```javascript
const confirmationTimeout = setTimeout(() => {
  if (STATE.status === STATE_STARTING) {
    logger.warn('No confirmation received within 5 seconds...');
    STATE.status = STATE_RECORDING; // Fallback transition
    persistSessionSnapshot();
  }
}, 5000);
```

**Loss impact**:

- If SW suspends during STARTING phase, no fallback transition occurs
- STATE stays in STARTING indefinitely
- No automatic recovery path

### Timer 2: Stop Safety Timeout (STOP_TIMEOUT_MS)

**Location**: lines 370-376

```javascript
STATE.stopTimeoutId = setTimeout(async () => {
  logger.error(`Save timeout reached (${STOP_TIMEOUT_MS / 1000}s) - forcing reset`);
  await clearSessionSnapshot();
  await resetRecordingState();
}, STOP_TIMEOUT_MS);
```

**Loss impact**:

- If SW suspends during STOPPING state, no automatic reset occurs
- Recording can appear "stuck" in STOPPING state
- User must manually intervene or wait for reconciliation

## State Lost vs Preserved

### Lost on Suspension (In-Memory)

| State Field     | Lost | Impact                           |
| --------------- | ---- | -------------------------------- |
| `status`        | ✓    | Cannot determine recording state |
| `recordingId`   | ✓    | Cannot correlate with chunks     |
| `correlationId` | ✓    | Cannot correlate logs            |
| `stopTimeoutId` | ✓    | No automatic cleanup             |
| `strategy`      | ✓    | Cannot route messages            |
| `overlayTabId`  | ✓    | Cannot remove overlay            |
| `recorderTabId` | ✓    | Cannot close recorder tab        |

### Preserved (Chrome Storage + IndexedDB)

| Data               | Storage                | Recovery Path                     |
| ------------------ | ---------------------- | --------------------------------- |
| Session snapshot   | `chrome.storage.local` | Lines 93-129 reconciliation       |
| Recording chunks   | IndexedDB              | Manual recovery via `hasChunks()` |
| Recording metadata | IndexedDB              | Status = 'partial'                |
| Overlay elements   | DOM                    | Manual cleanup or page reload     |

## Reconciliation Behavior Analysis

### Current Reconciliation (Lines 93-129)

```javascript
async function reconcileUnfinishedSessions() {
  const snapshot = result[SESSION_SNAPSHOT_KEY];
  if (!snapshot) return;

  const age = Date.now() - snapshot.lastActivityAt;

  if (age > STOP_TIMEOUT_MS) {
    // Stale session — clean up
    await clearSessionSnapshot();
    if (snapshot.recordingId) {
      const hasChunksResult = await hasChunks(snapshot.recordingId);
      if (hasChunksResult) {
        await markRecordingRecoverable(snapshot.recordingId);
      }
    }
  } else {
    // Found active session, will allow reconciliation
    // BUT: STATE is reset, no actual reconciliation happens
  }
}
```

### Problems with Current Reconciliation

1. **Incomplete recovery**: Reconciliation marks recording as partial but does NOT restore STATE values. After reconciliation:

   - `STATE.status` = IDLE (reset on SW startup)
   - `STATE.recordingId` = null
   - User sees no active recording but has partial chunks in IndexedDB

2. **No STATE restoration**:

   ```javascript
   // Reconciliation runs, but doesn't do:
   STATE.status = snapshot.status;
   STATE.recordingId = snapshot.recordingId;
   STATE.startedAt = snapshot.startedAt;
   ```

   The code just marks partial and moves on.

3. **"Active session" path does nothing**:

   ```javascript
   } else {
     logger.log('Found active session, will allow reconciliation', { age, status });
     // No actual reconciliation - just logs
   }
   ```

   This comment is misleading - it doesn't actually reconcile.

4. **No message routing recovery**:
   - If recording was in progress, OFFSCREEN_DATA messages won't be routed
   - If user tries to stop, `stopRecording()` fails with "Not recording"

### Is Reconciliation Doing Anything Useful?

**Answer: Partially, with significant gaps.**

**What it does**:

- ✓ Prevents stale sessions from blocking new recordings
- ✓ Marks partial recordings for recovery
- ✓ Cleans up orphaned snapshots

**What it doesn't do**:

- ✗ Does not restore recording STATE
- ✗ Does not allow resuming interrupted recordings
- ✗ Does not send appropriate messages to active recorders
- ✗ Does not update badge/icon to reflect actual state
- ✗ Does not attempt to recover chunks from crashed recorders

**Result**: After reconciliation, system appears to have no active recording, but partial data exists. User must manually discover and recover.

## Recommendations

### Priority 1: Implement Actual STATE Restoration

```javascript
// In reconcileUnfinishedSessions, active session path:
} else if (snapshot.status === STATE_RECORDING) {
  // Option A: Attempt to reconnect to active recording
  STATE.status = snapshot.status;
  STATE.recordingId = snapshot.recordingId;
  STATE.startedAt = snapshot.startedAt;
  STATE.lastActivityAt = snapshot.lastActivityAt;
  STATE.options = { ...snapshot.options };
  STATE.strategy = snapshot.strategy;

  // Option B: If recorder likely dead, mark partial
  await markRecordingRecoverable(snapshot.recordingId);
  await clearSessionSnapshot();
}
```

### Priority 2: Persist Critical Timers

```javascript
// Add to persistSessionSnapshot:
{
  // ...existing fields...
  timeoutScheduledAt: STATE.stopTimeoutId ? Date.now() : null,
  timeoutDuration: STATE.stopTimeoutId ? STOP_TIMEOUT_MS : null,
}

// In reconciliation, restore timer if needed:
if (snapshot.timeoutScheduledAt && snapshot.status === STATE_STOPPING) {
  const elapsed = Date.now() - snapshot.timeoutScheduledAt;
  const remaining = snapshot.timeoutDuration - elapsed;
  if (remaining > 0) {
    STATE.stopTimeoutId = setTimeout(handleTimeout, remaining);
  } else {
    // Timeout already fired, trigger cleanup now
  }
}
```

### Priority 3: Add SW Lifecycle Monitoring

```javascript
// Log SW suspension/resume events
self.addEventListener('resume', () => {
  logger.log('SW resumed, checking recording state');
  reconcileUnfinishedSessions();
});

// Note: 'resume' event fires when SW wakes from suspension
```

### Priority 4: Improve Recovery UX

1. Show user notification about interrupted recording
2. Offer clear recovery options (resume, export partial, discard)
3. Display partial recordings prominently in recordings list

### Priority 5: Fix the Reconciliation Comment

Line 100-101 says "will allow reconciliation" but no reconciliation occurs. Either:

- Implement actual reconciliation, or
- Change comment to "will clean up active session" if we decide not to support resume

## Summary

The service worker has significant vulnerabilities during suspension:

1. All in-memory STATE is lost
2. Active timers are cancelled
3. Reconciliation marks partial data but doesn't restore functionality
4. User experience degrades to "invisible partial recording"

**Core issue**: The architecture assumes SW will run continuously. Chrome's SW lifecycle doesn't guarantee this. The system needs either:

- Stateful persistence with full recovery, or
- Move critical state to chrome.storage.local (already partially done)
- Implement proper resume/cleanup flow
