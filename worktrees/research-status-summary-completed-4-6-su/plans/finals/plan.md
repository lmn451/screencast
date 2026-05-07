# Implementation Plan: CaptureCast Critical Issues Fix

## ADR (Architecture Decision Record)

### Open Questions (Resolved)

| ID     | Question                | Resolution                                         | Status       |
| ------ | ----------------------- | -------------------------------------------------- | ------------ |
| OQ-001 | **Recovery Mode**       | DEC-006: User-initiated via recovery UI            | **RESOLVED** |
| OQ-002 | **Checkpoint Interval** | DECIDED: 30 seconds (fixed)                        | **RESOLVED** |
| OQ-003 | **Background Sync API** | Not needed - Chrome SW lifecycle managed by Chrome | **RESOLVED** |

### Decisions (Decided from Spec)

| ID      | Decision                                       | Rationale                                                              | Status      |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| DEC-001 | Use PAGE strategy for microphone capture       | Offscreen cannot use getUserMedia(). PAGE strategy uses dedicated tab. | **DECIDED** |
| DEC-002 | Timestamp-based reconciliation                 | No heartbeat pings. Session age from lastActivityAt.                   | **DECIDED** |
| DEC-003 | Persist session snapshot on every state change | SW termination loses in-memory timers. Snapshot survives.              | **DECIDED** |
| DEC-004 | 3-retry with PARTIAL/FAILED marking            | Chunk save fails retry 3 times. Recording marked recoverable.          | **DECIDED** |
| DEC-005 | Overlay injection is best-effort               | Script fails on restricted pages. Don't block recording.               | **DECIDED** |
| DEC-006 | User-initiated recovery via recovery UI        | Users see pending sessions in recovery.html and choose Resume/Discard. | **DECIDED** |

---

## Task Breakdown

### Task 1: Fix Consent Tracking Array Overwrite Bug (FR-CONSENT-001)

| Field            | Value                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Priority**     | P0                                                                                                                     |
| **Files**        | `consent.js`                                                                                                           |
| **Lines**        | 119-123                                                                                                                |
| **Bug Location** | `trackConsent()` function, line 123                                                                                    |
| **Fix**          | Change `sessionStorage.setItem(key, JSON.stringify(entry))` to `sessionStorage.setItem(key, JSON.stringify(existing))` |
| **Dependencies** | None                                                                                                                   |

**Changes in `consent.js`:**

```javascript
// Line 119-123 - Before (bug):
const existing = JSON.parse(sessionStorage.getItem(key) || '[]');
existing.push(entry);
// Keep last 10 events
if (existing.length > 10) existing.shift();
sessionStorage.setItem(key, JSON.stringify(entry)); // BUG: saves single entry

// Line 119-123 - After (fix):
const existing = JSON.parse(sessionStorage.getItem(key) || '[]');
existing.push(entry);
// Keep last 10 events
if (existing.length > 10) existing.shift();
sessionStorage.setItem(key, JSON.stringify(existing)); // FIX: saves array
```

---

### Task 2: Strengthen Mode Validation (FR-CONSENT-002)

| Field            | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| **Priority**     | P0                                                         |
| **Files**        | `consent.js`                                               |
| **Lines**        | 10-17 (loadParams function), add new validateMode function |
| **Change**       | Add explicit mode whitelist validation                     |
| **Dependencies** | None                                                       |

**Changes in `consent.js`:**

1. Add validation constants and function at top of file (after line 8):

```javascript
// Valid capture modes
const VALID_MODES = ['tab', 'screen', 'window'];

/**
 * Validate capture mode against whitelist
 * @param {string} mode - Mode to validate
 * @throws {Error} If mode is invalid
 */
function validateMode(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid mode: '${mode}'. Valid modes: ${VALID_MODES.join(', ')}`);
  }
}
```

2. Update `loadParams()` function with safe mode validation (lines 10-17):

```javascript
async function loadParams() {
  const params = new URLSearchParams(window.location.search);
  const rawMode = params.get('mode') || 'tab';
  // Safe validation with fallback to 'tab' - graceful degradation
  const mode = VALID_MODES.includes(rawMode) ? rawMode : 'tab';
  if (rawMode !== mode) {
    console.warn(`[Consent] Invalid mode '${rawMode}' rejected, defaulting to tab`);
  }
  return {
    mode,
    mic: params.get('mic') === 'true' || params.get('mic') === '1',
    systemAudio: params.get('sys') === 'true' || params.get('sys') === '1',
  };
}
```

---

---

### Task 3: Implement Periodic Session Snapshot Persistence + Fix STATE Property Bug (FR-SW-001, FR-SW-003)

| Field            | Value                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Priority**     | P0                                                                                           |
| **Files**        | `background.js`                                                                              |
| **Lines**        | Add new checkpoint timer functions, fix STATE property bug, integrate into state transitions |
| **Changes**      | 1. Add checkpoint timer<br>2. Fix STATE.includeMic → STATE.options.includeMic                |
| **Dependencies** | None                                                                                         |

**Changes in `background.js`:**

1. Add checkpoint constants and timer functions (after line 75 `persistSessionSnapshot`):

````javascript
// Checkpoint interval: 30 seconds
const CHECKPOINT_INTERVAL_MS = 30_000;

let checkpointIntervalId = null;

/**
 * Start periodic session snapshot checkpointing
 * Persists state every CHECKPOINT_INTERVAL_MS to survive SW termination
 */
PJ:function startCheckpointTimer() {
ZS:  stopCheckpointTimer();
NR:  checkpointIntervalId = setInterval(async () => {
QP:    if ((STATE.status === STATE_RECORDING || STATE.status === STATE_STOPPING) && STATE.recordingId) {
JJ:      STATE.lastActivityAt = Date.now();
ST:      await persistSessionSnapshot();
BB:    }
PM:  }, CHECKPOINT_INTERVAL_MS);
VW:}

NY:WN:function activateCheckpointTimer() {
MW:WR:  if (STATE.status === STATE_RECORDING) {
QH:YM:    startCheckpointTimer();
MX:NP:  }
PS:NM:}

2. **FIX BUG**: Fix STATE property access in `startRecording()` (line 284):
```javascript
// Line 284 - Before (bug):
const useOffscreen = !STATE.includeMic && canUseOffscreen();

// Line 284 - After (fix):
const useOffscreen = !STATE.options.includeMic && canUseOffscreen();
````

3. **FIX BUG**: Fix STATE property access in `resetRecordingState()` (lines 427-428):

```javascript
// Line 427-428 - Before (bug):
STATE.includeMic = false;
STATE.includeSystemAudio = false;

// Line 427-428 - After (fix):
STATE.options.includeMic = false;
STATE.options.includeSystemAudio = false;
```

4. Activate checkpoint timer in `startRecording()` (at end of function, after successful init):
5. Stop checkpoint timer in `stopRecording()` (after line 351):

```javascript
// After: await updateBadge();
stopCheckpointTimer();
```

6. Stop checkpoint timer in `resetRecordingState()` (after line 432):

```javascript
// After: STATE.recordingId = null;
stopCheckpointTimer();
```

---

### Task 4: Implement Active Session Recovery (FR-SW-002)

| Field            | Value                                                           |
| ---------------- | --------------------------------------------------------------- |
| **Priority**     | P1                                                              |
| **Files**        | `background.js`, `recovery.js`, `src/messages.js`               |
| **Lines**        | background.js:93-129, add new functions                         |
| **Change**       | Enhance `reconcileUnfinishedSessions()` with recovery UI prompt |
| **Dependencies** | Task 3                                                          |

**Changes in `src/messages.js`:**

Add message constants and schemas:

```javascript
// Recovery message types
export const MSG_RECOVERY_RESUME = 'RECOVERY_RESUME';
export const MSG_RECOVERY_DISCARD = 'RECOVERY_DISCARD';

// Add to schemas object:
[MSG_RECOVERY_RESUME]: {
  required: [['type', 'string']],
  optional: [['recordingId', 'string']],
},
[MSG_RECOVERY_DISCARD]: {
  required: [['type', 'string']],
  optional: [['recordingId', 'string']],
},
```

**Changes in `background.js`:**

1. Add `showRecoveryPrompt()` function (after `reconcileUnfinishedSessions`):

```javascript
/**
 * Show recovery prompt by opening recovery.html
 * @param {object} snapshot - Session snapshot to recover
 */
async function showRecoveryPrompt(snapshot) {
  try {
    await chrome.storage.local.set({ sessionSnapshot: snapshot });
    await chrome.tabs.create({ url: chrome.runtime.getURL('recovery.html') });
  } catch (e) {
    logger.error('Failed to show recovery prompt:', e);
  }
}
```

2. Update `reconcileUnfinishedSessions()` to handle active sessions:

```javascript
async function reconcileUnfinishedSessions() {
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    const snapshot = result[SESSION_SNAPSHOT_KEY];
    if (!snapshot) return;

    const age = Date.now() - snapshot.lastActivityAt;

    if (age > STOP_TIMEOUT_MS) {
      // STALE SESSION - clean up and mark recoverable
      logger.warn('Found stale recording session, cleaning up', { age, snapshot });
      await clearSessionSnapshot();
      if (snapshot.recordingId) {
        const hasChunksResult = await hasChunks(snapshot.recordingId);
        if (hasChunksResult) {
          await markRecordingRecoverable(snapshot.recordingId);
        }
      }
    } else {
      // ACTIVE SESSION - show recovery prompt
      logger.log('Found active session, showing recovery prompt', { age, status: snapshot.status });
      if (snapshot.status === STATE_RECORDING || snapshot.status === STATE_STOPPING) {
        await showRecoveryPrompt(snapshot);
      }
    }
  } catch (e) {
    logger.error('Session reconciliation failed:', e);
  }
}
```

3. Add recovery message handlers in message listener (around line 505):

```javascript
case 'RECOVERY_RESUME': {
  // Resume is limited: can only save existing chunks, cannot continue recording
  // Original MediaStream is lost when tab was closed
  const { recordingId } = message;
  logger.log('User requested recovery resume', { recordingId });
  sendResponse({
    ok: true,
    message: 'Resume opens existing recording for save - cannot continue capture',
    recordingId
  });
  break;
}
case 'RECOVERY_DISCARD': {
  const { recordingId } = message;
  // Validate we're in a valid state to reset
  if (STATE.status !== STATE_RECORDING && STATE.status !== STATE_STOPPING && STATE.status !== STATE_IDLE) {
    logger.warn('RECOVERY_DISCARD called but not in recording state', { status: STATE.status });
  }
  logger.log('User requested recovery discard', { recordingId });
  await clearSessionSnapshot();
  await resetRecordingState();
  sendResponse({ ok: true });
  break;
}
```

**Changes in `recovery.js`:**

1. Add session snapshot retrieval function (add at top of script, after DB functions):

```javascript
// Storage key for session snapshot (matches background.js)
const SESSION_SNAPSHOT_KEY = 'sessionSnapshot';

async function getActiveSessionSnapshot() {
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    return result[SESSION_SNAPSHOT_KEY] || null;
  } catch (e) {
    return null;
  }
}
```

2. Update `render()` to include active session:

```javascript
async function render() {
  const listEl = document.getElementById('list');
  const subtitleEl = document.getElementById('subtitle');

  try {
    const recordings = await getRecoverableRecordings();
    const snapshot = await getActiveSessionSnapshot();

    // Prepend active session if exists
    if (snapshot && snapshot.recordingId && snapshot.status !== STATE_IDLE) {
      recordings.unshift({
        id: snapshot.recordingId,
        name: `Active Recording (${snapshot.status})`,
        createdAt: snapshot.startedAt || Date.now(),
        status: 'active',
        chunkCount: 0,
        size: 0
      });
    }
    // ... rest of render function
```

3. Update button handlers for active session (in existing click handler):

```javascript
// In the button click handler around line 126-140:
if (action === 'discard') {
  // ...
  await chrome.runtime.sendMessage({ type: 'RECOVERY_DISCARD', id });
  // ...
} else if (action === 'retry' || action === 'resume') {
  // Navigate to preview with this ID (same for recovery and regular partial)
  window.location.href = `preview.html?id=${encodeURIComponent(id)}`;
}
```

---

### Task 5: Verify PAGE Strategy for Microphone Capture (FR-CAP-001)

| Field            | Value                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| **Priority**     | P1                                                                         |
| **Files**        | `background.js`, `recorder.js`                                             |
| **Lines**        | background.js:284-306 (verified + bug fixed in Task 3), recorder.js:86-103 |
| **Change**       | Verify mic-enabled recording uses page strategy                            |
| **Dependencies** | Task 3 (bug fix)                                                           |

**Analysis:**

- **Bug Fixed in Task 3**: Line 284 now correctly uses `STATE.options.includeMic`
- When `includeMic` is true, `useOffscreen = false`
- This triggers the `else` branch (line 296-306) creating `recorder.html`
- `recorder.js` handles mic gracefully with try/catch (lines 86-103)

**Verification**: With the bug fix, PAGE strategy is correctly implemented:

- Mic enabled → `useOffscreen = false` → recorder.html created
- recorder.html requests getUserMedia for mic separately

---

### Task 6: Handle Overlay Injection Failures (FR-OVERLAY-001)

| Field            | Value                                       |
| ---------------- | ------------------------------------------- |
| **Priority**     | P2                                          |
| **Files**        | `overlay.js`                                |
| **Lines**        | 7-8, add protected URL detection            |
| **Change**       | Add protected page detection, fail silently |
| **Dependencies** | None                                        |

**Changes in `overlay.js`:**

Add protected URL check at top of IIFE (after line 7):

```javascript
(function () {
  // Protected URLs that block script injection
  const currentUrl = window.location.href;
  const isProtected = currentUrl.startsWith('chrome:') ||
                      currentUrl.startsWith('about:') ||
                      currentUrl.startsWith('devtools:') ||
                      currentUrl.startsWith('chrome-extension:') ||
                      /\.pdf$/i.test(currentUrl);

  if (isProtected) {
    console.debug('[CaptureCast Overlay] Skipping on protected page');
    return;
  }

  if (document.getElementById('cc-overlay')) return;
  // ... rest of existing code
```

---

## Dependency Graph

```
[Task 1: Fix Consent Array Overwrite]
         ↓
[Task 2: Strengthen Mode Validation]
         ↓
[Task 3: Periodic Snapshot + STATE Bug Fix] ───────┐
         ↓                                          │
[Task 4: Active Session Recovery]                   │
         ↓                                          │
[Task 5: PAGE Strategy Verification] ───────────────┘
         ↓
[Task 6: Overlay Injection Failures]
```

**Execution Order:**

1. Task 1 (Independent - consent bug)
2. Task 2 (Independent - validation)
3. Task 3 (Independent - checkpoint timer + critical bug fix)
4. Task 4 (Depends on Task 3 checkpoint timer infrastructure)
5. Task 5 (Depends on Task 3 bug fix)
6. Task 6 (Independent)

---

## Acceptance Criteria per Task

| Task ID    | Acceptance Criteria                                                                                          | Test Method                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Task 1** | AC-CONSENT-001: Consent records accumulate rather than overwrite                                             | Unit test: call `trackConsent()` 3 times, verify `sessionStorage.getItem('cc_consent_events')` returns array with 3 entries |
| **Task 2** | AC-CONSENT-002: Invalid modes rejected with clear error<br>AC-CONSENT-003: Mode validation at function entry | Call `validateMode('invalid')`, verify error thrown with valid modes listed                                                 |
| **Task 3** | AC-SW-001: Timer-based state persisted before SW suspend<br>AC-SW-003: Checkpoints occur at 30s intervals    | Record for >30s, kill SW, restart, verify session state recoverable                                                         |
| **Task 3** | STATE property bug fixed                                                                                     | Verify `STATE.options.includeMic` is used (not `STATE.includeMic`)                                                          |
| **Task 4** | AC-SW-002: Active sessions recoverable on SW startup<br>AC-SW-004: Recovery prompt shown within 2s           | Start recording, kill SW, restart, verify recovery.html opens                                                               |
| **Task 4** | Recovery messages validated                                                                                  | Verify RECOVERY_RESUME/DISCARD messages pass schema validation                                                              |
| **Task 5** | AC-CAP-001: Microphone capture uses PAGE strategy                                                            | Code review: verify `useOffscreen = false` when mic enabled                                                                 |
| **Task 6** | AC-OVERLAY-001: Overlay fails silently on chrome:// URLs                                                     | Manual test: navigate to chrome://settings, verify no console errors                                                        |

---

## Risk Register

| Risk                                                     | Likelihood | Impact   | Mitigation                                                    |
| -------------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------- |
| SW suspends during critical recording phase              | Medium     | High     | Task 3: 30s checkpoint interval prevents >30s data loss       |
| STATE property bug causes incorrect recording strategy   | Medium     | Critical | Task 3: Fixed `STATE.includeMic` → `STATE.options.includeMic` |
| IndexedDB quota exceeded unexpectedly                    | Low        | Medium   | Monitor usage, warn user, graceful degradation                |
| Recovery creates corrupted recordings                    | Low        | Medium   | Validate chunk integrity, PARTIAL status marking              |
| Tab re-acquisition fails (tab closed)                    | Medium     | Low      | Clear session termination, user notification                  |
| Checkpoint interval causes performance overhead          | Low        | Low      | Task 3: async, non-blocking (<50ms per NFR)                   |
| Recovery mode UX unclear                                 | Medium     | Medium   | Clear UI with Resume/Discard buttons in recovery.html         |
| Recovery UI opens repeatedly on multiple SW terminations | Low        | Medium   | Recovery tab opened once per SW startup; user can close       |

---

## Open Questions (All Resolved)

| ID     | Resolution                               |
| ------ | ---------------------------------------- |
| OQ-001 | User-initiated via recovery UI (DEC-006) |
| OQ-002 | 30 seconds fixed (DECIDED in spec)       |
| OQ-003 | Not needed - Chrome manages SW lifecycle |

---

## Recovery Behavior Definition

**Important**: "Resume" in recovery context means:

- Open the recording data for preview/save
- **Cannot** continue the actual capture (MediaStream is lost)
- User must manually re-record if they want to continue

This is the expected behavior because:

1. MediaStream is tied to original tab
2. Screen/window capture requires user re-selection
3. Mic permission needs re-grant

---

## Implementation Checklist

- [ ] Task 1: Fix consent.js line 123 - change `entry` to `existing`
- [ ] Task 2: Add VALID_MODES constant and validateMode() function to consent.js
- [ ] Task 2: Update loadParams() to call validateMode()
- [ ] Task 3: Add CHECKPOINT_INTERVAL_MS constant to background.js
- [ ] Task 3: Add startCheckpointTimer() and stopCheckpointTimer() functions to background.js
- [ ] Task 3: Fix line 284 - change STATE.includeMic to STATE.options.includeMic
- [ ] Task 3: Fix lines 427-428 - change STATE.includeMic to STATE.options.includeMic
- [ ] Task 3: Call startCheckpointTimer() after persistSessionSnapshot() in startRecording()
- [ ] Task 3: Call stopCheckpointTimer() in stopRecording() and resetRecordingState()
- [ ] Task 4: Add MSG_RECOVERY_RESUME and MSG_RECOVERY_DISCARD to src/messages.js
- [ ] Task 4: Add schema entries for recovery messages in src/messages.js
- [ ] Task 4: Add showRecoveryPrompt() function to background.js
- [ ] Task 4: Update reconcileUnfinishedSessions() to show recovery prompt for active sessions
- [ ] Task 4: Add RECOVERY_RESUME and RECOVERY_DISCARD handlers in background.js message listener
- [ ] Task 4: Add getActiveSessionSnapshot() to recovery.js
- [ ] Task 4: Update recovery.js render() to include active session
- [ ] Task 4: Update recovery.js button handlers for active session
- [ ] Task 5: Verify PAGE strategy for mic (code review - verified with Task 3 bug fix)
- [ ] Task 6: Add protected URL detection to overlay.js
- [ ] Verify all acceptance criteria
- [ ] Run existing tests
- [ ] Manual testing of recovery flow
