import indexedDB from "fake-indexeddb";
import FDBKeyRange from "fake-indexeddb/lib/FDBKeyRange";

export function setupIndexedDB() {
  // Provide fake IndexedDB implementations to the test environment
  global.indexedDB = indexedDB;
  global.IDBKeyRange = FDBKeyRange;
}

export function teardownIndexedDB() {
  try {
    // Remove globals to avoid cross-test leakage
    delete global.indexedDB;
    delete global.IDBKeyRange;
  } catch (e) {
    // ignore
  }
}

export function clearDatabase(dbName = "CaptureCastDB") {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}
