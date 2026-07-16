import { STORE_RECORDINGS, STORE_CHUNKS, openDB } from './db-shared.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Cleanup');

// Thresholds for cleanup (in milliseconds)
const PARTIAL_RECORDING_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const FAILED_RECORDING_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');

    tx.objectStore(STORE_RECORDINGS).delete(id);

    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const index = chunkStore.index('recordingId');
    const req = index.openKeyCursor(IDBKeyRange.only(id));

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        chunkStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function cleanupOldRecordings(maxAgeMs = 24 * 60 * 60 * 1000) {
  const db = await openDB();
  const cutoff = Date.now() - maxAgeMs;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.openCursor();

    const idsToDelete = [];

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.createdAt < cutoff) {
          idsToDelete.push(cursor.value.id);
          cursor.delete();
        }
        cursor.continue();
      } else {
        if (idsToDelete.length === 0) {
          db.close();
          resolve();
          return;
        }

        const chunkStore = tx.objectStore(STORE_CHUNKS);
        const chunkIndex = chunkStore.index('recordingId');

        let completed = 0;
        const checkDone = () => {
          completed++;
          if (completed === idsToDelete.length) {
            db.close();
            resolve();
          }
        };

        idsToDelete.forEach((id) => {
          const chunkReq = chunkIndex.openKeyCursor(IDBKeyRange.only(id));
          chunkReq.onsuccess = (e) => {
            const c = e.target.result;
            if (c) {
              chunkStore.delete(c.primaryKey);
              c.continue();
            } else {
              checkDone();
            }
          };
        });
      }
    };

    tx.oncomplete = () => {
      if (idsToDelete.length > 0) {
        logger.log(`Cleanup: Deleted ${idsToDelete.length} old recordings`);
      }
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Clean up partial recordings older than threshold
 * @param {number} [thresholdMs=PARTIAL_RECORDING_THRESHOLD_MS] - Age threshold in milliseconds
 * @returns {Promise<{deleted: number}>}
 */
export async function cleanupPartialRecordings(thresholdMs = PARTIAL_RECORDING_THRESHOLD_MS) {
  const db = await openDB();
  const cutoff = Date.now() - thresholdMs;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.openCursor();

    const idsToDelete = [];

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const recording = cursor.value;
        // Delete partial recordings older than threshold
        if (recording.status === 'partial' && recording.createdAt < cutoff) {
          idsToDelete.push(recording.id);
          cursor.delete();
        }
        cursor.continue();
      } else {
        if (idsToDelete.length === 0) {
          db.close();
          resolve({ deleted: 0 });
          return;
        }

        const chunkStore = tx.objectStore(STORE_CHUNKS);
        const chunkIndex = chunkStore.index('recordingId');

        let completed = 0;
        const checkDone = () => {
          completed++;
          if (completed === idsToDelete.length) {
            db.close();
          }
        };

        idsToDelete.forEach((id) => {
          const chunkReq = chunkIndex.openKeyCursor(IDBKeyRange.only(id));
          chunkReq.onsuccess = (e) => {
            const c = e.target.result;
            if (c) {
              chunkStore.delete(c.primaryKey);
              c.continue();
            } else {
              checkDone();
            }
          };
        });
      }
    };

    tx.oncomplete = () => {
      if (idsToDelete.length > 0) {
        logger.log(`Partial recordings cleanup: Deleted ${idsToDelete.length} recordings`);
      }
      resolve({ deleted: idsToDelete.length });
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Clean up failed recordings older than threshold
 * @param {number} [thresholdMs=FAILED_RECORDING_THRESHOLD_MS] - Age threshold in milliseconds
 * @returns {Promise<{deleted: number}>}
 */
export async function cleanupFailedRecordings(thresholdMs = FAILED_RECORDING_THRESHOLD_MS) {
  const db = await openDB();
  const cutoff = Date.now() - thresholdMs;

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.openCursor();

    const idsToDelete = [];

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const recording = cursor.value;
        // Delete failed recordings older than threshold
        if (recording.status === 'failed' && recording.createdAt < cutoff) {
          idsToDelete.push(recording.id);
          cursor.delete();
        }
        cursor.continue();
      } else {
        if (idsToDelete.length === 0) {
          db.close();
          resolve({ deleted: 0 });
          return;
        }

        const chunkStore = tx.objectStore(STORE_CHUNKS);
        const chunkIndex = chunkStore.index('recordingId');

        let completed = 0;
        const checkDone = () => {
          completed++;
          if (completed === idsToDelete.length) {
            db.close();
          }
        };

        idsToDelete.forEach((id) => {
          const chunkReq = chunkIndex.openKeyCursor(IDBKeyRange.only(id));
          chunkReq.onsuccess = (e) => {
            const c = e.target.result;
            if (c) {
              chunkStore.delete(c.primaryKey);
              c.continue();
            } else {
              checkDone();
            }
          };
        });
      }
    };

    tx.oncomplete = () => {
      if (idsToDelete.length > 0) {
        logger.log(`Failed recordings cleanup: Deleted ${idsToDelete.length} recordings`);
      }
      resolve({ deleted: idsToDelete.length });
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Get total storage used by all stores
 * @returns {Promise<{recordings: number, chunks: number, total: number}>}
 */
export async function getTotalStorageUsed() {
  const result = {
    recordings: 0,
    chunks: 0,
    total: 0,
  };

  const db = await openDB();

  try {
    // Get recordings
    const recordingsTx = db.transaction(STORE_RECORDINGS, 'readonly');
    const recordingsStore = recordingsTx.objectStore(STORE_RECORDINGS);
    const recordingsReq = await new Promise((resolve, reject) => {
      const req = recordingsStore.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    for (const recording of recordingsReq) {
      result.recordings += recording.size || 0;
      // Estimate metadata overhead (~500 bytes per recording)
      result.recordings += 500;
    }

    // Get chunks
    const chunksTx = db.transaction(STORE_CHUNKS, 'readonly');
    const chunksStore = chunksTx.objectStore(STORE_CHUNKS);
    const chunksReq = await new Promise((resolve, reject) => {
      const req = chunksStore.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    for (const chunk of chunksReq) {
      result.chunks += chunk.chunk?.size || 0;
    }

    result.total = result.recordings + result.chunks;

    logger.log('Total storage used:', {
      recordings: `${(result.recordings / 1024 / 1024).toFixed(1)} MB`,
      chunks: `${(result.chunks / 1024 / 1024).toFixed(1)} MB`,
      total: `${(result.total / 1024 / 1024).toFixed(1)} MB`,
    });
  } catch (e) {
    logger.warn('Failed to calculate total storage used:', e);
  } finally {
    db.close();
  }

  return result;
}
