// Persistent diagnostics for CaptureCast
// Stores structured diagnostic entries in IndexedDB for debugging

import { DB_NAME, DB_VERSION } from '../db-shared.js';

// Ring buffer limit
export const MAX_DIAGNOSTIC_ENTRIES = 500;

// IndexedDB store name
export const DIAG_STORE = 'diagnostics';

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

function openDiagDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DIAG_STORE)) {
        db.createObjectStore(DIAG_STORE, { keyPath: 'id' });
      }
    };
  });
}

/** @deprecated Internal use only */
export { openDiagDB };

/**
 * Saves a diagnostic entry to IndexedDB, trimming to MAX_DIAGNOSTIC_ENTRIES.
 * Handles all errors gracefully (no throwing).
 * @param {object} entry - Diagnostic entry from createDiagnosticEntry
 */
export async function saveDiagnostic(entry) {
  try {
    const db = await openDiagDB();
    const tx = db.transaction(DIAG_STORE, 'readwrite');
    const store = tx.objectStore(DIAG_STORE);

    // Add entry
    store.add(entry);

    // Trim if needed
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > MAX_DIAGNOSTIC_ENTRIES) {
        const cursorReq = store.openCursor();
        let deleteCount = countReq.result - MAX_DIAGNOSTIC_ENTRIES;
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && deleteCount > 0) {
            cursor.delete();
            deleteCount--;
            cursor.continue();
          }
        };
      }
    };

    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (e) {
    // Graceful: no-op on error
    console.error('[Diag] saveDiagnostic failed:', e);
  }
}

/**
 * Reads last N diagnostic entries, descending by timestamp.
 * @param {number} [limit=MAX_DIAGNOSTIC_ENTRIES] - Max entries to return
 * @returns {Promise<object[]>} Diagnostic entries
 */
export async function getDiagnostics(limit = MAX_DIAGNOSTIC_ENTRIES) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(DIAG_STORE, 'readonly');
      const store = tx.objectStore(DIAG_STORE);
      const entries = [];
      const cursorReq = store.openCursor(null, 'prev');
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && entries.length < limit) {
          entries.push(cursor.value);
          cursor.continue();
        } else {
          db.close();
          resolve(entries);
        }
      };
    };
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
