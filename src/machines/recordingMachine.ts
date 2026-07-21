/**
 * CaptureCast Recording State Machine
 * XState v5 Pure Implementation
 *
 * Key principle: The machine is PURE (state + assign only).
 * All Chrome API side effects live in RecordingService.
 *
 * States:
 *   idle → starting → recording → stopping → saved → idle
 *                              ↓
 *                          failed → recoverable → idle
 */

import { setup, assign } from 'xstate';
import type { RecordingContext, RecordingEvent, RecordingMode, RecordingStrategy } from './types.js';
import { TIMEOUTS } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INITIAL CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

export const initialContext: RecordingContext = {
  recordingId: null,
  correlationId: null,
  strategy: null,
  startedAt: null,
  lastActivityAt: null,
  options: {
    mode: null,
    includeMic: false,
    includeSystemAudio: false,
  },
  error: null,
  failedChunkCount: 0,
  overlayInjected: false,
  confirmationTimeoutId: null,
  saveTimeoutId: null,
  checkpointIntervalId: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MACHINE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export const recordingMachine = setup({
  types: {} as {
    context: RecordingContext;
    events: RecordingEvent;
  },

  guards: {
    isValidUUID: ({ event }) => {
      if ('recordingId' in event && typeof (event as { recordingId?: string }).recordingId === 'string') {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          (event as { recordingId: string }).recordingId
        );
      }
      return false;
    },
  },

  actions: {
    clearRecordingState: assign({
      recordingId: () => null,
      correlationId: () => null,
      strategy: () => null,
      startedAt: () => null,
      lastActivityAt: () => null,
      options: () => ({ mode: null, includeMic: false, includeSystemAudio: false }),
      error: () => null,
      failedChunkCount: () => 0,
      overlayInjected: () => false,
    }),

    determineStrategy: assign({
      strategy: ({ context }) => (context.options.includeMic ? 'page' : 'offscreen'),
    }),

    updateLastActivity: assign({
      lastActivityAt: () => Date.now(),
    }),

    incrementFailedChunks: assign({
      failedChunkCount: ({ context }) => context.failedChunkCount + 1,
    }),

    setError: assign({
      error: ({ event }) => (event as { error: string }).error,
    }),

    setTabClosedError: assign({
      error: () => 'Tab closed during recording',
    }),
  },

  delays: {
    CONFIRMATION_DELAY: TIMEOUTS.CONFIRMATION,
    SAVE_DELAY: TIMEOUTS.SAVE,
    CHECKPOINT_INTERVAL: TIMEOUTS.CHECKPOINT,
  },
}).createMachine({
  id: 'recording',
  initial: 'idle',
  context: initialContext,

  // ═══════════════════════════════════════════════════════════════════════════
  // STATES
  // ═══════════════════════════════════════════════════════════════════════════
  states: {
    // ─────────────────────────────────────────────────────────────────────────
    // IDLE STATE
    // ─────────────────────────────────────────────────────────────────────────
    idle: {
      entry: 'clearRecordingState',
      on: {
        START: {
          target: 'starting',
          actions: assign({
            recordingId: () => crypto.randomUUID(),
            correlationId: () => crypto.randomUUID(),
            startedAt: () => Date.now(),
            lastActivityAt: () => Date.now(),
            options: ({ event }) => ({
              mode: (event as { type: 'START'; mode: RecordingMode }).mode,
              includeMic: (event as { type: 'START'; mic?: boolean }).mic ?? false,
              includeSystemAudio: (event as { type: 'START'; systemAudio?: boolean }).systemAudio ?? false,
            }),
            error: () => null,
            failedChunkCount: () => 0,
          }),
        },
        RECONCILE: {
          target: 'recording',
          actions: assign({
            recordingId: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { recordingId: string } }).snapshot.recordingId,
            strategy: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { strategy: RecordingStrategy } }).snapshot.strategy,
            startedAt: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { startedAt: number } }).snapshot.startedAt,
            lastActivityAt: () => Date.now(),
            options: ({ event }) =>
              (event as { type: 'RECONCILE'; snapshot: { options: RecordingContext['options'] } }).snapshot.options,
            correlationId: ({ event }) =>
              (event as { type: 'RECONCILE'; snapshot: { correlationId: string } }).snapshot.correlationId,
          }),
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STARTING STATE
    // Note: Timing is managed by RecordingService (not via invoke actors)
    // ─────────────────────────────────────────────────────────────────────────
    starting: {
      entry: 'determineStrategy',
      on: {
        OFFSCREEN_STARTED: {
          target: 'recording',
          actions: 'updateLastActivity',
        },
        RECORDER_STARTED: {
          target: 'recording',
          actions: 'updateLastActivity',
        },
        OFFSCREEN_DATA: {
          target: 'saved',
        },
        RECORDER_DATA: {
          target: 'saved',
        },
        CONFIRMATION_TIMEOUT: {
          target: 'recording',
          actions: 'updateLastActivity',
        },
        OFFSCREEN_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
        RECORDER_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
        STOP: {
          target: 'idle',
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RECORDING STATE
    // ─────────────────────────────────────────────────────────────────────────
    recording: {
      entry: 'updateLastActivity',
      on: {
        STOP: { target: 'stopping' },
        OFFSCREEN_DATA: {
          target: 'saved',
        },
        RECORDER_DATA: {
          target: 'saved',
        },
        OFFSCREEN_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
        RECORDER_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
        CHUNK_FAILED: {
          actions: 'incrementFailedChunks',
        },
        UPDATE_STATE: {
          actions: 'updateLastActivity',
        },
        OVERLAY_TAB_CLOSED: {
          actions: 'setTabClosedError',
          target: 'failed',
        },
        RECORDER_TAB_CLOSED: {
          actions: 'setTabClosedError',
          target: 'failed',
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STOPPING STATE
    // ─────────────────────────────────────────────────────────────────────────
    stopping: {
      entry: 'updateLastActivity',
      on: {
        OFFSCREEN_DATA: {
          target: 'saved',
        },
        RECORDER_DATA: {
          target: 'saved',
        },
        SAVE_TIMEOUT: {
          target: 'recoverable',
        },
        OFFSCREEN_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
        RECORDER_ERROR: {
          target: 'failed',
          actions: 'setError',
        },
        STOP: { target: 'stopping' }, // Idempotent
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // SAVED STATE (terminal with auto-reset after 1 second)
    // ─────────────────────────────────────────────────────────────────────────
    saved: {
      entry: 'updateLastActivity',
      after: {
        1000: { target: 'idle' },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // FAILED STATE
    // ─────────────────────────────────────────────────────────────────────────
    failed: {
      entry: 'updateLastActivity',
      on: {
        RESET: { target: 'idle' },
        RECOVERY_DISCARD: {
          target: 'idle',
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RECOVERABLE STATE
    // ─────────────────────────────────────────────────────────────────────────
    recoverable: {
      on: {
        RECOVERY_RESUME: {
          target: 'recording',
          actions: 'updateLastActivity',
          guard: 'isValidUUID',
        },
        RECOVERY_DISCARD: {
          target: 'idle',
        },
        OFFSCREEN_DATA: {
          target: 'saved',
        },
        RECORDER_DATA: {
          target: 'saved',
        },
        RESET: { target: 'idle' },
      },
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GLOBAL EVENT HANDLERS
  // ───────────────────────────────────────────────────────────────────────────
  on: {
    RESET: '.idle',
    RECOVERY_DISCARD: '.idle',
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type { RecordingContext, RecordingEvent, SessionSnapshot, RecordingMode, RecordingStrategy } from './types.js';
