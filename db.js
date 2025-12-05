const DB_NAME = 'CaptureCastDB';
const DB_VERSION = 2; // Bump version for schema change
const STORE_RECORDINGS = 'recordings';
const STORE_CHUNKS = 'chunks';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Clear old stores if they exist to avoid migration complexity for this fix
      if (db.objectStoreNames.contains('recordings')) {
        db.deleteObjectStore('recordings');
      }
      if (db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.deleteObjectStore(STORE_CHUNKS);
      }

      // Store for metadata
      db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });

      // Store for binary chunks: [recordingId, chunkIndex]
      const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: ['recordingId', 'index'] });
      chunkStore.createIndex('recordingId', 'recordingId', { unique: false });
    };
  });
}

export async function saveChunk(recordingId, chunk, index) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readwrite');
    const store = tx.objectStore(STORE_CHUNKS);
    const request = store.put({ recordingId, index, chunk });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

export async function finishRecording(id, mimeType) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const request = store.put({ id, mimeType, createdAt: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

export async function getRecording(id) {
  const db = await openDB();

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
      // Sort by index to ensure order
      results.sort((a, b) => a.index - b.index);
      resolve(results.map(r => r.chunk));
    };
    req.onerror = () => reject(req.error);
  });

  db.close();

  // 3. Reassemble
  const blob = new Blob(chunks, { type: meta.mimeType });
  return { id, blob, mimeType: meta.mimeType, createdAt: meta.createdAt };
}

export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');

    // Delete metadata
    tx.objectStore(STORE_RECORDINGS).delete(id);

    // Delete chunks
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
        // Metadata deleted, now delete chunks for these IDs
        if (idsToDelete.length === 0) return;

        const chunkStore = tx.objectStore(STORE_CHUNKS);
        const chunkIndex = chunkStore.index('recordingId');

        // This is a bit inefficient (N queries), but fine for cleanup
        // A better way would be iterating all chunks, but that's slower if many valid ones exist.
        // Given we have the IDs, let's iterate them.
        let completed = 0;
        const checkDone = () => {
          completed++;
          if (completed === idsToDelete.length) {
            // All delete requests initiated
          }
        };

        idsToDelete.forEach(id => {
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
      db.close();
      console.log(`Cleanup: Deleted ${idsToDelete.length} old recordings`);
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
