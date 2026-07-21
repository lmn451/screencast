import { STORE_CHUNKS, STORE_RECORDINGS, openDB } from './db-shared.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ChunkStorage');

/**
 * Save a chunk to IndexedDB
 * @param {string} recordingId - The recording ID
 * @param {Blob} chunk - The chunk blob to save
 * @param {number} index - The chunk index
 * @returns {Promise<void>}
 */
export async function saveChunk(recordingId, chunk, index) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    logger.warn('[DB] Failed to open database for saveChunk:', e && e.message ? e.message : e);
    throw new Error(
      '[DB] Failed to open database for saveChunk: ' + (e && e.message ? e.message : e)
    );
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    const request = store.put({ recordingId, index, chunk });
    // Resolve on tx.oncomplete (commit), not request.onsuccess, so a
    // commit-time QuotaExceededError propagates and saveChunkWithRetry fires.
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Get the number of chunks saved for a recording
 * @param {string} recordingId - The recording ID
 * @returns {Promise<number>} Number of chunks
 */
export async function getChunkCount(recordingId) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    logger.warn('[DB] Failed to open database for getChunkCount:', e);
    return 0;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const index = store.index('recordingId');
    const request = index.count(IDBKeyRange.only(recordingId));
    request.onsuccess = () => {
      db.close();
      resolve(request.result);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Check if a recording has any chunks saved
 * @param {string} recordingId - The recording ID
 * @returns {Promise<boolean>} True if recording has chunks
 */
export async function hasChunks(recordingId) {
  const count = await getChunkCount(recordingId);
  return count > 0;
}

/**
 * Get all recording IDs that have chunks saved
 * @returns {Promise<string[]>} Array of recording IDs
 */
export async function getAllRecordingIds() {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    logger.warn('[DB] Failed to open database for getAllRecordingIds:', e);
    return [];
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const request = store.getAll();

    request.onsuccess = () => {
      const results = request.result || [];
      const uniqueIds = [...new Set(results.map((r) => r.recordingId))];
      db.close();
      resolve(uniqueIds);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Get all chunks for a recording
 * @param {string} recordingId - The recording ID
 * @returns {Promise<Array<{recordingId: string, index: number, chunk: Blob}>>}
 */
export async function getChunks(recordingId) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    logger.warn('[DB] Failed to open database for getChunks:', e);
    return [];
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const index = store.index('recordingId');
    const request = index.getAll(IDBKeyRange.only(recordingId));

    request.onsuccess = () => {
      const results = request.result || [];
      results.sort((a, b) => a.index - b.index);
      db.close();
      resolve(results);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Delete all chunks for a recording
 * @param {string} recordingId - The recording ID
 * @returns {Promise<void>}
 */
export async function deleteChunks(recordingId) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    logger.warn('[DB] Failed to open database for deleteChunks:', e);
    return;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    const index = store.index('recordingId');
    const request = index.openKeyCursor(IDBKeyRange.only(recordingId));

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
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

/**
 * Mark a recording as recoverable (partial save state)
 * @param {string} recordingId - The recording ID
 * @returns {Promise<void>}
 */
export async function markRecordingRecoverable(recordingId) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    logger.warn('[DB] Failed to open database for markRecordingRecoverable:', e);
    return;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.get(recordingId);

    req.onsuccess = () => {
      const recording = req.result;
      if (recording) {
        recording.status = 'partial';
        const putReq = store.put(recording);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
