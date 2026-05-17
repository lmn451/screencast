// Shared IndexedDB constants and the canonical openDB() helper.
//
// All modules that need access to CaptureCast's IndexedDB MUST import openDB
// from here so the upgrade handler is defined in exactly one place and all
// callers agree on schema. Hardcoded `indexedDB.open(...)` calls scattered
// across the codebase are a recipe for VersionError races and silent data
// loss; don't reintroduce them.

export const DB_NAME = 'CaptureCastDB';
export const DB_VERSION = 3;
export const STORE_RECORDINGS = 'recordings';
export const STORE_CHUNKS = 'chunks';
export const DIAG_STORE = 'diagnostics';

/**
 * Open the CaptureCast IndexedDB.
 * Creates all three object stores (`recordings`, `chunks`, `diagnostics`) if
 * they don't already exist. Safe to call from any extension context.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_CHUNKS, {
          keyPath: ['recordingId', 'index'],
        });
        chunkStore.createIndex('recordingId', 'recordingId', { unique: false });
      }

      if (!db.objectStoreNames.contains(DIAG_STORE)) {
        // Diagnostic entries set their own `id` (UUID string) via createDiagnosticEntry.
        db.createObjectStore(DIAG_STORE, { keyPath: 'id' });
      }
    };
  });
}
