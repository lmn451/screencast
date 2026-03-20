import { DB_NAME, DB_VERSION, STORE_CHUNKS } from './db-shared.js';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, {
          keyPath: ['recordingId', 'index'],
        });
        chunkStore.createIndex('recordingId', 'recordingId', { unique: false });
      }
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
      }
    };
  });
}

export async function saveChunk(recordingId, chunk, index) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    throw new Error(
      '[DB] Failed to open database for saveChunk: ' + (e && e.message ? e.message : e)
    );
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    const request = store.put({ recordingId, index, chunk });

    const cleanup = () => {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    };

    request.onsuccess = () => {
      try {
        resolve();
      } finally {
        cleanup();
      }
    };
    request.onerror = () => {
      cleanup();
      reject(request.error);
    };
    tx.oncomplete = cleanup;
    tx.onerror = cleanup;
  });
}
