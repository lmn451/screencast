import {
  DB_NAME,
  DB_VERSION,
  STORE_RECORDINGS,
  STORE_CHUNKS,
} from "./db-shared.js";

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        db.createObjectStore(STORE_RECORDINGS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, {
          keyPath: ["recordingId", "index"],
        });
        chunkStore.createIndex("recordingId", "recordingId", { unique: false });
      }
    };
  });
}

export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], "readwrite");

    tx.objectStore(STORE_RECORDINGS).delete(id);

    const chunkStore = tx.objectStore(STORE_CHUNKS);
    const index = chunkStore.index("recordingId");
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
    const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], "readwrite");
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
        if (idsToDelete.length === 0) return;

        const chunkStore = tx.objectStore(STORE_CHUNKS);
        const chunkIndex = chunkStore.index("recordingId");

        let completed = 0;
        const checkDone = () => {
          completed++;
          if (completed === idsToDelete.length) {
            // done
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
      db.close();
      if (idsToDelete.length > 0) {
        console.log(
          `[CaptureCast DB] Cleanup: Deleted ${idsToDelete.length} old recordings`,
        );
      }
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
