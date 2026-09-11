// Shared IndexedDB constants and the canonical openDB() helper.
//
// All modules that need access to ScreenSilo's IndexedDB MUST import openDB
// from here so the upgrade handler is defined in exactly one place and all
// callers agree on schema. Hardcoded `indexedDB.open(...)` calls scattered
// across the codebase are a recipe for VersionError races and silent data
// loss; don't reintroduce them.

// Keep the original database name across the public rebrand so extension
// updates retain recordings created by earlier development builds.
export const DB_NAME = 'CaptureCastDB';
export const DB_VERSION = 4;
export const STORE_RECORDINGS = 'recordings';
export const STORE_CHUNKS = 'chunks';
export const DIAG_STORE = 'diagnostics';
// Diagnostic entries are keyed by UUID, so use their timestamp for all
// chronological reads and retention decisions.
export const DIAG_TIMESTAMP_INDEX = 'ts';
// A timestamp only has millisecond precision. Keep arrival order as data so
// equal timestamps do not fall back to UUID ordering.
export const DIAG_SEQUENCE_INDEX = 'sequence';
export const DIAG_ORDER_INDEX = 'tsSequence';

function compareLegacyDiagnostics(a, b) {
  const aTs = Number.isFinite(a?.ts) ? a.ts : Number.NEGATIVE_INFINITY;
  const bTs = Number.isFinite(b?.ts) ? b.ts : Number.NEGATIVE_INFINITY;
  if (aTs !== bTs) return aTs - bTs;

  const aId = String(a?.id ?? '');
  const bId = String(b?.id ?? '');
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

/**
 * Open the ScreenSilo IndexedDB.
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

      let diagnosticsStore;
      let createdDiagnosticsStore = false;
      if (!db.objectStoreNames.contains(DIAG_STORE)) {
        // Diagnostic entries set their own `id` (UUID string) via createDiagnosticEntry.
        diagnosticsStore = db.createObjectStore(DIAG_STORE, { keyPath: 'id' });
        createdDiagnosticsStore = true;
      } else {
        // Existing stores are upgraded in the version-change transaction. Do
        // not recreate them: that would discard recordings, chunks, or logs.
        const upgradeTransaction = event.target.transaction || event.transaction;
        diagnosticsStore = upgradeTransaction.objectStore(DIAG_STORE);
      }

      if (!diagnosticsStore.indexNames.contains(DIAG_TIMESTAMP_INDEX)) {
        diagnosticsStore.createIndex(DIAG_TIMESTAMP_INDEX, 'ts', { unique: false });
      }
      if (!diagnosticsStore.indexNames.contains(DIAG_SEQUENCE_INDEX)) {
        diagnosticsStore.createIndex(DIAG_SEQUENCE_INDEX, 'sequence', { unique: false });
      }
      if (!diagnosticsStore.indexNames.contains(DIAG_ORDER_INDEX)) {
        diagnosticsStore.createIndex(DIAG_ORDER_INDEX, ['ts', 'sequence'], { unique: false });
      }

      // Version 3 diagnostics have no insertion sequence. Millisecond arrival
      // order cannot be recovered, so choose a stable (timestamp, UUID) order
      // and retain every existing row while adding the new metadata.
      if (!createdDiagnosticsStore) {
        const migrateRequest = diagnosticsStore.getAll();
        migrateRequest.onsuccess = () => {
          const entries = (migrateRequest.result || []).sort(compareLegacyDiagnostics);
          entries.forEach((entry, sequence) => {
            diagnosticsStore.put({ ...entry, sequence });
          });
        };
      }
    };
  });
}
