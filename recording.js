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

export async function finishRecording(id, mimeType, duration, size) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    throw new Error(
      "[DB] Failed to open database for finishRecording: " +
        (e && e.message ? e.message : e),
    );
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, "readwrite");
    const store = tx.objectStore(STORE_RECORDINGS);
    const request = store.put({
      id,
      mimeType,
      duration,
      size,
      createdAt: Date.now(),
      name: null,
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

export async function updateRecordingName(id, name) {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    return Promise.reject(
      new Error(
        "[DB] Failed to open database for updateRecordingName: " +
          (e && e.message ? e.message : e),
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, "readwrite");
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
        reject(new Error("Recording not found"));
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
      "[DB] Failed to open database for getRecording: " +
        (e && e.message ? e.message : e),
    );
  }

  // 1. Get metadata
  const meta = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, "readonly");
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
    const tx = db.transaction(STORE_CHUNKS, "readonly");
    const store = tx.objectStore(STORE_CHUNKS);
    const index = store.index("recordingId");
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
  };
}

export async function getAllRecordings() {
  let db;
  try {
    db = await openDB();
  } catch (e) {
    return Promise.reject(
      new Error(
        "[DB] Failed to open database for getAllRecordings: " +
          (e && e.message ? e.message : e),
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, "readonly");
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
