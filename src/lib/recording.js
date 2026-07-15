import { STORE_RECORDINGS, STORE_CHUNKS, openDB } from './db-shared.js';

/**
 * Recording status values
 * @readonly
 * @enum {string}
 */
export const RECORDING_STATUS = {
  RECORDING: 'recording', // Active, chunks being saved
  SAVING: 'saving', // Stop requested, final chunks being saved
  SAVED: 'saved', // Fully saved, playable
  FAILED: 'failed', // Save failed (no chunks or corrupted)
  PARTIAL: 'partial', // Some chunks saved but incomplete
};

/**
 * Finish a recording and save its metadata
 * @param {string} id - Recording ID
 * @param {string} mimeType - MIME type of the recording
 * @param {number} duration - Duration in milliseconds
 * @param {number} size - Total size in bytes
 * @param {string} [status='saved'] - Recording status
 * @returns {Promise<void>}
 */
export async function finishRecording(
  id,
  mimeType,
  duration,
  size,
  status = RECORDING_STATUS.SAVED
) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    throw new Error(
      '[DB] Failed to open database for finishRecording: ' + (e && e.message ? e.message : e)
    );
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const request = store.put({
      id,
      mimeType,
      duration,
      size,
      createdAt: Date.now(),
      name: null,
      status,
    });
    // Resolve on tx.oncomplete (commit), not request.onsuccess, so an
    // acknowledged save always means the IndexedDB transaction committed.
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

export async function updateRecordingName(id, name) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    return Promise.reject(
      new Error(
        '[DB] Failed to open database for updateRecordingName: ' + (e && e.message ? e.message : e)
      )
    );
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const recording = getRequest.result;
      if (recording) {
        recording.name = name;
        const putRequest = store.put(recording);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      } else {
        reject(new Error('Recording not found'));
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

export async function getRecording(id) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    throw new Error(
      '[DB] Failed to open database for getRecording: ' + (e && e.message ? e.message : e)
    );
  }

  // 1. Get metadata
  const meta = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readonly');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (!meta) {
    db.close();
    return null;
  }

  // 2. Get all chunks
  const chunks = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const index = store.index('recordingId');
    const req = index.getAll(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const results = req.result;
      results.sort((a, b) => a.index - b.index);
      resolve(results.map((r) => r.chunk));
    };
    req.onerror = () => reject(req.error);
  });

  db.close();

  const blob = new Blob(chunks, { type: meta.mimeType });
  return {
    id,
    blob,
    mimeType: meta.mimeType,
    createdAt: meta.createdAt,
    duration: meta.duration,
    size: meta.size,
    name: meta.name,
    status: meta.status,
  };
}

export async function getAllRecordings() {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    return Promise.reject(
      new Error(
        '[DB] Failed to open database for getAllRecordings: ' + (e && e.message ? e.message : e)
      )
    );
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readonly');
    const store = tx.objectStore(STORE_RECORDINGS);
    const request = store.getAll();
    request.onsuccess = () => {
      const results = request.result;
      results.sort((a, b) => b.createdAt - a.createdAt);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}
