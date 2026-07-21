/**
 * CaptureCast XState v5 Type Definitions
 * Phase: Implementation
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STATE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Recording mode selection */
export type RecordingMode = 'tab' | 'window' | 'screen';

/** Recording strategy - determines how recording happens */
export type RecordingStrategy = 'offscreen' | 'page';

/** Machine status values */
export type RecordingStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'recoverable';

/** Machine context - all mutable state */
export interface RecordingContext {
  recordingId: string | null;
  correlationId: string | null;
  strategy: RecordingStrategy | null;
  overlayTabId: number | null;
  recorderTabId: number | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  options: {
    mode: RecordingMode | null;
    includeMic: boolean;
    includeSystemAudio: boolean;
  };
  error: string | null;
  failedChunkCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Events that can be sent to the recording machine */
export type RecordingEvent =
  | { type: 'START'; mode: RecordingMode; mic?: boolean; systemAudio?: boolean }
  | { type: 'STOP' }
  | { type: 'OFFSCREEN_STARTED' }
  | { type: 'RECORDER_STARTED' }
  | { type: 'OFFSCREEN_DATA'; recordingId: string; mimeType: string }
  | { type: 'RECORDER_DATA'; recordingId: string; mimeType: string }
  | { type: 'OFFSCREEN_ERROR'; error: string; code?: string }
  | { type: 'RECORDER_ERROR'; error: string }
  | { type: 'CONFIRMATION_TIMEOUT' }
  | { type: 'SAVE_TIMEOUT' }
  | { type: 'RESET' }
  | { type: 'SET_OVERLAY_TAB_ID'; tabId: number | null }
  | { type: 'SET_RECORDER_TAB_ID'; tabId: number | null }
  | { type: 'RECOVERY_DISCARD'; recordingId: string }
  | { type: 'TAB_CLOSING'; tabId: number }
  | { type: 'PREVIEW_READY'; recordingId?: string }
  | { type: 'CHUNK_FAILED'; chunkIndex: number }
  | { type: 'UPDATE_STATE'; status: RecordingStatus };

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION SNAPSHOT (for persistence)
// ═══════════════════════════════════════════════════════════════════════════════

/** Session snapshot for chrome.storage.local persistence */
export interface SessionSnapshot {
  recordingId: string;
  status: RecordingStatus;
  startedAt: number;
  lastActivityAt: number;
  options: {
    mode: RecordingMode | null;
    includeMic: boolean;
    includeSystemAudio: boolean;
  };
  strategy: RecordingStrategy | null;
  correlationId: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTION PARAM TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Parameters passed to action functions */
export interface ActionParams {
  context: RecordingContext;
  event: RecordingEvent;
}

/** Parameters passed to guard functions */
export interface GuardParams {
  context: RecordingContext;
  event: RecordingEvent;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API TYPES (simplified)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChromeRuntimeMessage {
  type: string;
  [key: string]: unknown;
}

export interface ChromeSendResponse {
  (response?: { ok: boolean; error?: string }): void;
}

export interface ChromeMessageSender {
  id: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const TIMEOUTS = {
  CONFIRMATION: 5000,
  SAVE: 60000,
  CHECKPOINT: 30000,
} as const;

export const STORAGE_KEYS = {
  SESSION_SNAPSHOT: 'sessionSnapshot',
} as const;

/** Alias for backwards compatibility with background-xstate.js */
export const SESSION_SNAPSHOT_KEY = STORAGE_KEYS.SESSION_SNAPSHOT;

// ═══════════════════════════════════════════════════════════════════════════════
// UUID VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

export function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}
