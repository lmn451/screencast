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

import { setup, assign, createMachine } from 'xstate';
import type { RecordingContext, RecordingEvent, RecordingMode, RecordingStrategy } from './types.js';
import { TIMEOUTS } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INITIAL CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

export const initialContext: RecordingContext = {
  recordingId: null,
  correlationId: null,
  strategy: null,
  overlayTabId: null,
  recorderTabId: null,
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
// ACTION CREATORS (pure assign only - no async)
// ═══════════════════════════════════════════════════════════════════════════════

const actions = setup({
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
    initializeRecording: assign({
      recordingId: () => crypto.randomUUID(),
      correlationId: () => crypto.randomUUID(),
      startedAt: () => Date.now(),
      lastActivityAt: () => Date.now(),
      error: () => null,
      failedChunkCount: () => 0,
      overlayInjected: () => false,
    }),

    setRecordingOptions: assign({
      options: ({ event }) => ({
        mode: (event as { type: 'START'; mode: RecordingMode }).mode,
        includeMic: (event as { type: 'START'; mic?: boolean }).mic ?? false,
        includeSystemAudio: (event as { type: 'START'; systemAudio?: boolean }).systemAudio ?? false,
      }),
    }),

    clearRecordingState: assign({
      recordingId: () => null,
      correlationId: () => null,
      strategy: () => null,
      overlayTabId: () => null,
      recorderTabId: () => null,
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

    setOverlayTabId: assign({
      overlayTabId: (_, params: { tabId: number | null }) => params.tabId,
    }),

    setRecorderTabId: assign({
      recorderTabId: (_, params: { tabId: number | null }) => params.tabId,
    }),

    setOverlayInjected: assign({
      overlayInjected: () => true,
    }),

    updateLastActivity: assign({
      lastActivityAt: () => Date.now(),
    }),

    setError: assign({
      error: ({ event }) => (event as { type: 'OFFSCREEN_ERROR' | 'RECORDER_ERROR' }).error,
    }),

    incrementFailedChunks: assign({
      failedChunkCount: ({ context }) => context.failedChunkCount + 1,
    }),

    reconcileFromSnapshot: assign({
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

  actors: {
    // Callback actor for confirmation timeout
    confirmationTimeoutCallback: {
      src: function* confirmationTimeoutCallback() {
        // Timeout is managed by RecordingService
        // This actor just yields to allow the transition
      },
      onDone: 'recording',
    },

    // Callback actor for save timeout
    saveTimeoutCallback: {
      src: function* saveTimeoutCallback() {
        // Timeout is managed by RecordingService
      },
      onDone: 'recoverable',
    },
  },

  delays: {
    CONFIRMATION_DELAY: TIMEOUTS.CONFIRMATION,
    SAVE_DELAY: TIMEOUTS.SAVE,
    CHECKPOINT_INTERVAL: TIMEOUTS.CHECKPOINT,
  },
}).create();

const { actions: recordingActions, guards, actors } = actions;

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MACHINE DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export const recordingMachine = createMachine({
  id: 'recording',
  initial: 'idle',
  types: {} as {
    context: RecordingContext;
    events: RecordingEvent;
  },
  context: initialContext,

  // ═══════════════════════════════════════════════════════════════════════════
  // STATES
  // ═══════════════════════════════════════════════════════════════════════════
  states: {
    // ─────────────────────────────────────────────────────────────────────────
    // IDLE STATE
    // ─────────────────────────────────────────────────────────────────────────
    idle: {
      entry: assign({
        recordingId: () => null,
        correlationId: () => null,
        strategy: () => null,
        overlayTabId: () => null,
        recorderTabId: () => null,
        startedAt: () => null,
        lastActivityAt: () => null,
        options: () => ({ mode: null, includeMic: false, includeSystemAudio: false }),
        error: () => null,
        failedChunkCount: () => 0,
        overlayInjected: () => false,
      }),
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
    // ─────────────────────────────────────────────────────────────────────────
    starting: {
      entry: assign({
        strategy: ({ context }) => (context.options.includeMic ? 'page' : 'offscreen'),
      }),
      invoke: {
        src: 'confirmationTimeoutCallback',
        onDone: 'recording',
      },
      on: {
        OFFSCREEN_STARTED: [
          {
            target: 'recording',
            actions: [recordingActions.updateLastActivity],
          },
        ],
        RECORDER_STARTED: [
          {
            target: 'recording',
            actions: [recordingActions.updateLastActivity],
          },
        ],
        CONFIRMATION_TIMEOUT: [
          {
            target: 'recording',
            actions: [recordingActions.updateLastActivity],
          },
        ],
        OFFSCREEN_ERROR: [
          {
            target: 'failed',
            actions: assign({
              error: ({ event }) => (event as { type: 'OFFSCREEN_ERROR'; error: string }).error,
            }),
          },
        ],
        RECORDER_ERROR: [
          {
            target: 'failed',
            actions: assign({
              error: ({ event }) => (event as { type: 'RECORDER_ERROR'; error: string }).error,
            }),
          },
        ],
        STOP: [
          {
            target: 'idle',
          },
        ],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RECORDING STATE
    // Note: checkpointTimerActor removed - handled by RecordingService
    // ─────────────────────────────────────────────────────────────────────────
    recording: {
      entry: assign({
        lastActivityAt: () => Date.now(),
      }),
      on: {
        STOP: { target: 'stopping' },
        OFFSCREEN_ERROR: [
          {
            target: 'failed',
            actions: assign({
              error: ({ event }) => (event as { type: 'OFFSCREEN_ERROR'; error: string }).error,
            }),
          },
        ],
        RECORDER_ERROR: [
          {
            target: 'failed',
            actions: assign({
              error: ({ event }) => (event as { type: 'RECORDER_ERROR'; error: string }).error,
            }),
          },
        ],
        CHUNK_FAILED: {
          actions: recordingActions.incrementFailedChunks,
        },
        UPDATE_STATE: {
          actions: recordingActions.updateLastActivity,
        },
        TAB_CLOSING: {
          // Guard: only if closing the recorder tab
          guard: ({ event, context }) => {
            const tabId = (event as { type: 'TAB_CLOSING'; tabId: number }).tabId;
            return context.recorderTabId === tabId || context.overlayTabId === tabId;
          },
          actions: assign({
            error: () => 'Tab closed during recording',
          }),
          target: 'failed',
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STOPPING STATE
    // ─────────────────────────────────────────────────────────────────────────
    stopping: {
      entry: assign({
        lastActivityAt: () => Date.now(),
      }),
      invoke: {
        src: 'saveTimeoutCallback',
        onDone: 'recoverable',
      },
      on: {
        OFFSCREEN_DATA: [
          {
            target: 'saved',
          },
        ],
        RECORDER_DATA: [
          {
            target: 'saved',
          },
        ],
        SAVE_TIMEOUT: [
          {
            target: 'recoverable',
          },
        ],
        STOP: { target: 'stopping' }, // Idempotent
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // SAVED STATE (terminal with auto-reset after 1 second)
    // ─────────────────────────────────────────────────────────────────────────
    saved: {
      entry: assign({
        lastActivityAt: () => Date.now(),
      }),
      after: {
        1000: { target: 'idle' },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // FAILED STATE
    // ─────────────────────────────────────────────────────────────────────────
    failed: {
      entry: assign({
        lastActivityAt: () => Date.now(),
      }),
      on: {
        RESET: { target: 'idle' },
        RECOVERY_DISCARD: [
          {
            target: 'idle',
          },
        ],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RECOVERABLE STATE
    // ─────────────────────────────────────────────────────────────────────────
    recoverable: {
      on: {
        RECOVERY_RESUME: [
          {
            target: 'recording',
            actions: [recordingActions.updateLastActivity],
            guard: guards.isValidUUID,
          },
        ],
        RECOVERY_DISCARD: [
          {
            target: 'idle',
          },
        ],
        RESET: { target: 'idle' },
      },
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GLOBAL EVENT HANDLERS
  // ───────────────────────────────────────────────────────────────────────────
  on: {
    RESET: { target: 'idle' },
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type { RecordingContext, RecordingEvent, SessionSnapshot, RecordingMode, RecordingStrategy } from './types.js';