// Persistent diagnostics for ScreenSilo
// Stores structured diagnostic entries in IndexedDB for debugging

import {
  DIAG_ORDER_INDEX,
  DIAG_SEQUENCE_INDEX,
  DIAG_STORE,
  DIAG_TIMESTAMP_INDEX,
  openDB,
} from './lib/db-shared.js';

// Re-export for backwards compat with existing tests/callers.
export { DIAG_STORE };
export { DIAG_TIMESTAMP_INDEX };
export { DIAG_SEQUENCE_INDEX, DIAG_ORDER_INDEX };

// Ring buffer limit
export const MAX_DIAGNOSTIC_ENTRIES = 500;

/** @type {Record<string, string>} Diagnostic level enum */
export const DiagLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/** @type {Record<string, string>} Diagnostic event codes (kebab-case) */
export const DiagEvent = {
  START_RECORDING: 'start-recording',
  STOP_RECORDING: 'stop-recording',
  SAVE_CHUNK: 'save-chunk',
  SAVE_FAILED: 'save-failed',
  STATE_TRANSITION: 'state-transition',
  MESSAGE_RECEIVED: 'message-received',
  OFFSCREEN_ERROR: 'offscreen-error',
  RECORDER_CRASH: 'recorder-crash',
  STORAGE_QUOTA: 'storage-quota',
};

/**
 * Creates a diagnostic entry object.
 * @param {string} level - Level from DiagLevel
 * @param {string} eventCode - Event code from DiagEvent
 * @param {string} userMessage - User-facing message
 * @param {object} [opts={}] - Additional options
 * @returns {object} Diagnostic entry
 */
export function createDiagnosticEntry(level, eventCode, userMessage, opts = {}) {
  return {
    id:
      typeof globalThis.crypto !== 'undefined' && globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: Date.now(),
    level,
    eventCode,
    userMessage,
    technicalMessage: opts.technicalMessage || '',
    recordingId: opts.recordingId || null,
    correlationId: opts.correlationId || null,
    stack: opts.stack || null,
    state: opts.state || null,
  };
}

// Use the canonical openDB() from db-shared. Re-export under the legacy name
// for any code that still imports openDiagDB.
const openDiagDB = openDB;
/** @deprecated Internal use only */
export { openDiagDB };

let diagnosticsWriteQueue = Promise.resolve();

function closeDatabase(db) {
  try {
    db?.close();
  } catch {
    // Closing an already-closed connection is harmless.
  }
}

function transactionFailure(tx, requestError) {
  return tx?.error || requestError || new Error('Diagnostics transaction failed');
}

/**
 * Performs one diagnostic write and retention pass. The caller serializes
 * these operations so a burst of logger calls cannot race its count/cursor
 * decisions against one another.
 */
function saveDiagnosticTransaction(entry) {
  let db;
  return openDiagDB().then((openedDb) => {
    db = openedDb;
    return new Promise((resolve, reject) => {
      let tx;
      let requestError;
      let settled = false;

      const settle = (error) => {
        if (settled) return;
        settled = true;
        closeDatabase(db);
        if (error) reject(error);
        else resolve();
      };

      try {
        tx = db.transaction(DIAG_STORE, 'readwrite');
        tx.oncomplete = () => settle();
        tx.onerror = () => settle(transactionFailure(tx, requestError));
        tx.onabort = () => settle(transactionFailure(tx, requestError));

        const store = tx.objectStore(DIAG_STORE);
        let sequenceCursorRequest;
        try {
          // This cursor and the subsequent add are part of the same
          // readwrite transaction. IndexedDB serializes readwrite
          // transactions across extension contexts, so two callers cannot
          // allocate the same sequence value.
          sequenceCursorRequest = store.index(DIAG_SEQUENCE_INDEX).openCursor(null, 'prev');
        } catch (error) {
          requestError = error;
          try {
            tx.abort();
          } catch {
            settle(error);
          }
          return;
        }

        sequenceCursorRequest.onerror = () => {
          requestError = sequenceCursorRequest.error;
        };
        sequenceCursorRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          const maxSequence = cursor ? cursor.key : -1;
          const sequence = Number.isSafeInteger(maxSequence) ? maxSequence + 1 : 0;
          const diagnostic = {
            ...entry,
            ts: entry?.ts ?? Date.now(),
            sequence,
          };

          let addRequest;
          try {
            addRequest = store.add(diagnostic);
            addRequest.onerror = () => {
              requestError = addRequest.error;
            };

            const countRequest = store.count();
            countRequest.onerror = () => {
              requestError = countRequest.error;
            };
            countRequest.onsuccess = () => {
              if (countRequest.result <= MAX_DIAGNOSTIC_ENTRIES) return;

              const deleteCount = countRequest.result - MAX_DIAGNOSTIC_ENTRIES;
              let remaining = deleteCount;
              let cursorRequest;
              try {
                cursorRequest = store.index(DIAG_ORDER_INDEX).openCursor(null, 'next');
              } catch (error) {
                requestError = error;
                try {
                  tx.abort();
                } catch {
                  settle(error);
                }
                return;
              }

              cursorRequest.onerror = () => {
                requestError = cursorRequest.error;
              };
              cursorRequest.onsuccess = (cursorEvent) => {
                const deleteCursor = cursorEvent.target.result;
                if (!deleteCursor || remaining <= 0) return;

                deleteCursor.delete();
                remaining -= 1;
                if (remaining > 0) deleteCursor.continue();
              };
            };
          } catch (error) {
            requestError = error;
            try {
              tx.abort();
            } catch {
              settle(error);
            }
          }
        };
      } catch (error) {
        settle(error);
      }
    });
  });
}

/**
 * Saves a diagnostic entry to IndexedDB, trimming to MAX_DIAGNOSTIC_ENTRIES.
 * Handles all errors gracefully (no throwing).
 * @param {object} entry - Diagnostic entry from createDiagnosticEntry
 */
export function saveDiagnostic(entry) {
  const operation = diagnosticsWriteQueue.then(() => saveDiagnosticTransaction(entry));
  // Keep the queue usable after a failed operation while preserving the
  // public API's graceful, non-throwing behavior.
  diagnosticsWriteQueue = operation.catch(() => undefined);

  return operation.catch((error) => {
    console.error('[Diag] saveDiagnostic failed:', error);
  });
}

/**
 * Reads last N diagnostic entries, descending by timestamp.
 * @param {number} [limit=MAX_DIAGNOSTIC_ENTRIES] - Max entries to return
 * @returns {Promise<object[]>} Diagnostic entries
 */
export async function getDiagnostics(limit = MAX_DIAGNOSTIC_ENTRIES) {
  // A logger call may intentionally be fire-and-forget. Wait for writes that
  // were queued before this read so callers observe committed diagnostics.
  await diagnosticsWriteQueue;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    let requestError;
    let settled = false;
    const entries = [];

    const settle = (error) => {
      if (settled) return;
      settled = true;
      closeDatabase(db);
      if (error) reject(error);
      else resolve(entries);
    };

    try {
      tx = db.transaction(DIAG_STORE, 'readonly');
      tx.oncomplete = () => settle();
      tx.onerror = () => settle(transactionFailure(tx, requestError));
      tx.onabort = () => settle(transactionFailure(tx, requestError));

      const store = tx.objectStore(DIAG_STORE);
      const maxEntries =
        limit === Infinity
          ? Infinity
          : Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 0);
      const cursorReq = store.index(DIAG_ORDER_INDEX).openCursor(null, 'prev');
      cursorReq.onerror = () => {
        requestError = cursorReq.error;
      };
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && entries.length < maxEntries) {
          entries.push(cursor.value);
          cursor.continue();
        }
      };
    } catch (err) {
      settle(err);
    }
  });
}

/**
 * Returns a JSON string of all diagnostics for user export.
 * @returns {Promise<string>} JSON string
 */
export async function exportDiagnostics() {
  const entries = await getDiagnostics(MAX_DIAGNOSTIC_ENTRIES);
  return JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2);
}

/**
 * Redacts sensitive fields from a diagnostic entry.
 * @param {object} entry - Diagnostic entry
 * @returns {object} Redacted entry
 */
export function redactDiagnosticsEntry(entry) {
  if (!entry) return null;
  const redacted = { ...entry };
  // Redact device labels (both JSON format and plain text)
  if (redacted.technicalMessage) {
    redacted.technicalMessage = redacted.technicalMessage
      .replace(/"deviceId"\s*:\s*"[^"]*"/g, '"deviceId":"[REDACTED]"')
      .replace(/"label"\s*:\s*"[^"]*"/g, '"label":"[REDACTED]"')
      // Also redact plain text label patterns (e.g., "Device label: Microphone (USB)")
      .replace(/(?:device\s+)?label[:\s]+[^,\n}]+/gi, '[REDACTED]')
      // Generic redaction for device-related patterns in text
      .replace(/Microphone\s*\([^)]+\)/g, '[REDACTED]')
      .replace(/\b[A-Za-z0-9]{20,}\b/g, (m) => (m.length > 20 ? '[ID]' : m));
  }
  // Redact URLs
  if (redacted.technicalMessage) {
    redacted.technicalMessage = redacted.technicalMessage.replace(
      /https?:\/\/[^\s"'<>]+/g,
      '[URL]'
    );
  }
  // Redact blob references
  if (redacted.technicalMessage) {
    redacted.technicalMessage = redacted.technicalMessage.replace(/Blob\s*\([^)]+\)/g, '[BLOB]');
  }
  // Redact full audio track labels
  if (redacted.state && typeof redacted.state === 'object') {
    redacted.state = { ...redacted.state };
    if (redacted.state.audioTracks) {
      redacted.state.audioTracks = redacted.state.audioTracks.map(() => ({
        label: '[REDACTED]',
        id: redacted.state.audioTracks[0]?.id ?? 'unknown',
      }));
    }
  }
  // Keep non-sensitive metadata
  return redacted;
}
