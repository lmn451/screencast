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

/** Structured error payload used by recorder/offscreen error contracts */
export interface StructuredErrorPayload {
  ok: boolean;
  code: string;
  userMessage: string;
  technicalMessage?: string;
  retryable?: boolean;
  correlationId?: string | null;
  /**
   * Allow additional metadata to support future extensions while keeping
   * compatibility with existing `createError` call sites.
   */
  [key: string]: unknown;
}

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
  startedAt: number | null;
  lastActivityAt: number | null;
  options: {
    mode: RecordingMode | null;
    includeMic: boolean;
    includeSystemAudio: boolean;
  };
  error: string | null;
  failedChunkCount: number;
  overlayInjected: boolean;
  confirmationTimeoutId: ReturnType<typeof setTimeout> | null;
  saveTimeoutId: ReturnType<typeof setTimeout> | null;
  checkpointIntervalId: ReturnType<typeof setInterval> | null;
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
  | { type: 'OFFSCREEN_ERROR'; recordingId: string; error: StructuredErrorPayload; code?: string }
  | { type: 'RECORDER_ERROR'; recordingId: string; error: StructuredErrorPayload; code?: string }
  | { type: 'CONFIRMATION_TIMEOUT' }
  | { type: 'SAVE_TIMEOUT' }
  | { type: 'RESET' }
  | { type: 'OVERLAY_TAB_CLOSED' }
  | { type: 'RECORDER_TAB_CLOSED' }
  | {
      type: 'RECONCILE';
      snapshot: Partial<RecordingContext> & {
        status: RecordingStatus;
        recordingId: string;
      };
    }
  | { type: 'RECOVERY_RESUME'; recordingId: string }
  | { type: 'RECOVERY_DISCARD'; recordingId: string }
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
