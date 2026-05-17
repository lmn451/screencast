# Storage Failure Matrix

## IndexedDB Limits & Quotas

### Browser Quotas (Chrome)

| Scenario                   | Quota               |
| -------------------------- | ------------------- |
| Default temporary storage  | 60% of disk space   |
| Persistent storage granted | 100% of disk space  |
| Before quota enforcement   | 120 GB (soft limit) |
| Session storage limit      | 10 MB per origin    |

### Storage Estimation API

```javascript
// From storage-utils.js lines 82-121
navigator.storage.estimate();
// Returns: { usage: bytes, quota: bytes }
```

### Pre-Recording Checks

- **MIN_FREE_SPACE_BYTES**: 100 MB buffer required (line 11)
- **During recording threshold**: 50 MB warning level (line 128)

## Chunk Save Failure Modes

### Failure Mode 1: DB Open Failure

**Location**: `chunkStorage.js` lines 36-42

```javascript
try {
  db = await openDB();
} catch (e) {
  throw new Error('[DB] Failed to open database for saveChunk: ' + e.message);
}
```

**Recovery**: Throws error → caller must handle. No automatic retry.

### Failure Mode 2: Transaction Failure

**Location**: `chunkStorage.js` lines 44-55

```javascript
const request = store.put({ recordingId, index, chunk });
request.onsuccess = () => resolve();
request.onerror = () => reject(request.error);
tx.onerror = () => {
  db.close();
  reject(tx.error);
};
```

**Failure scenarios**:

- Quota exceeded during `put()` → `request.onerror` fires
- DB closed during transaction → `tx.onerror` fires

### Failure Mode 3: Orphaned Blobs

**Risk**: If `db.close()` happens before transaction completes, blob reference may be lost.

### Failure Mode 4: IndexedDB Deleted While Open

If storage is cleared externally during active recording → silent data loss with no error callback.

## Recovery Paths

### Path 1: Partial Recording Recovery

**Trigger**: SW crash during recording

1. `reconcileUnfinishedSessions()` runs on SW startup (background.js lines 93-129)
2. Checks if `lastActivityAt` > STOP_TIMEOUT_MS (stale session)
3. If `hasChunks(snapshot.recordingId)` returns true → marks recording as "partial"
4. User can resume/continue partial recordings

**Code path**:

```javascript
// background.js lines 111-118
if (snapshot.recordingId) {
  const hasChunksResult = await hasChunks(snapshot.recordingId);
  if (hasChunksResult) {
    await markRecordingRecoverable(snapshot.recordingId);
  }
}
```

### Path 2: Session Snapshot Recovery

**Location**: `persistSessionSnapshot()` (background.js lines 58-75)

Session snapshot stored in `chrome.storage.local` contains:

- `recordingId`, `status`, `startedAt`, `lastActivityAt`
- `options` (mode, includeMic, includeSystemAudio)
- `strategy` (offscreen vs page)
- `correlationId` for logging correlation

**Recovery behavior**: SW checks age, if < STOP_TIMEOUT_MS → allows reconciliation. If > timeout → cleans up.

### Path 3: Chunk Enumeration Recovery

**Location**: `chunkStorage.js` lines 93-96, 201-235

```javascript
async function hasChunks(recordingId) {
  const count = await getChunkCount(recordingId);
  return count > 0;
}

async function markRecordingRecoverable(recordingId) {
  // Sets recording.status = 'partial' in IndexedDB
}
```

## Race Conditions

### Race Condition 1: Concurrent Recording Start

**Location**: `background.js` lines 243-258

```javascript
const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
const snapshot = result[SESSION_SNAPSHOT_KEY];
if (snapshot) {
  if (activeStatuses.includes(snapshot.status)) {
    if (age < 30000) {
      return { ok: false, error: 'Recording already in progress' };
    }
  }
}
```

**Issue**: 30-second window for concurrent start detection. Two starts within 30 seconds could both succeed in edge cases.

### Race Condition 2: Snapshot vs State Synchronization

**Issue**: `persistSessionSnapshot()` writes to chrome.storage.local asynchronously. If SW suspends between STATE update and snapshot persist, state inconsistency.

**Timeline**:

```
1. STATE.status = STATE_RECORDING
2. SW suspends (suspension delay)
3. chrome.storage.local.set() never called
4. SW resumes → old snapshot loaded
```

### Race Condition 3: Chunk Save vs Recording Stop

**Scenario**: User stops recording while chunks are being saved.

**Code path**:

1. `stopRecording()` sets STATE_STOPPING
2. Send stop message to offscreen/recorder
3. Offscreen flushes remaining chunks
4. Race: chunk save might fail after stop message sent

**Mitigation**: Safety timeout (STOP_TIMEOUT_MS) forces cleanup after failure.

### Race Condition 4: DB Connection Pool Exhaustion

**Issue**: Each chunk save opens new DB connection. If chunk generation is faster than IndexedDB can process, connections pile up.

**Evidence**: No connection pooling mechanism in chunkStorage.js. Every `saveChunk()` call:

1. Calls `openDB()` (new connection)
2. Completes transaction
3. Calls `db.close()`

### Race Condition 5: Snapshot Clear vs Session Check

**Location**: `clearSessionSnapshot()` (background.js lines 80-87)

```javascript
await chrome.storage.local.remove(SESSION_SNAPSHOT_KEY);
```

If SW suspends immediately after clear but before final state update → stale data in IndexedDB (partial recording without snapshot).

## Failure Matrix Summary

| Failure Mode          | Detection           | Recovery            | Data Loss Risk    |
| --------------------- | ------------------- | ------------------- | ----------------- |
| DB open fails         | ✓ Exception         | ✓ Caller handles    | ✓ Chunk lost      |
| Quota exceeded        | ✓ onerror           | ✗ No retry          | ✓ Recording fails |
| SW crash mid-chunk    | ✗ No detection      | ✓ Snapshot recovery | ✓ Incomplete file |
| Concurrent starts     | ✓ 30s check         | ✓ Block second      | ✗ None            |
| Connection exhaustion | ✗ Implicit slowdown | ✗ None              | ✓ Possible        |
| Browser killed        | ✗ None              | ✓ Stale cleanup     | ✓ Partial data    |

## Recommendations

1. **Add chunk retry queue** for failed saves
2. **Implement connection pooling** for IndexedDB operations
3. **Increase concurrent start check** from 30s to 60s minimum
4. **Add pre-check for active IndexedDB transactions** before new save
5. **Persist chunks in batches** to reduce connection churn
