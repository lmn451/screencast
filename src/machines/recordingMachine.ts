/**
 * CaptureCast Recording State Machine
 * XState v5 Implementation
 * 
 * This machine replaces the manual state management in background.js with
 * a declarative, testable state machine.
 * 
 * States:
 *   idle → starting → recording → stopping → saving → saved → idle
 *                         ↓
 *                      failed
 *                         ↓
 *                   recoverable
 *                         ↓
 *                      idle
 */

import { setup, assign, createMachine, createActor, fromCallback, fromPromise } from 'xstate';
import type { RecordingContext, RecordingEvent, SessionSnapshot, RecordingMode } from './types';
import { TIMEOUTS, STORAGE_KEYS, isValidUUID, type RecordingStrategy } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChromeApi {
  storage: {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (data: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  tabs: {
    query: (query: { active?: boolean; currentWindow?: boolean }) => Promise<Array<{ id: number }>>;
    create: (options: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    remove: (tabId: number) => Promise<void>;
    get: (tabId: number) => Promise<{ windowId: number }>;
    update: (tabId: number, options: { active: boolean }) => Promise<void>;
    sendMessage: (tabId: number, message: Record<string, unknown>) => Promise<void>;
  };
  scripting: {
    executeScript: (options: { target: { tabId: number }; files: string[] }) => Promise<void>;
    executeScript: (options: { target: { tabId: number }; func: () => void }) => Promise<void>;
  };
  offscreen: {
    createDocument: (options: { url: string; reasons: string[]; justification: string }) => Promise<void>;
    closeDocument: () => Promise<void>;
    hasDocument: () => Promise<boolean>;
  };
  action: {
    setBadgeBackgroundColor: (options: { color: string }) => Promise<void>;
    setBadgeText: (options: { text: string }) => Promise<void>;
  };
  runtime: {
    getURL: (path: string) => string;
    sendMessage: (message: Record<string, unknown>) => Promise<unknown>;
    id: string;
  };
  windows: {
    update: (windowId: number, options: { focused: boolean }) => Promise<void>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIAL CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

const initialContext: RecordingContext = {
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
// CHROME API (to be injected)
// ═══════════════════════════════════════════════════════════════════════════════

let chromeApi: ChromeApi | null = null;

export function setChromeApi(api: ChromeApi): void {
  chromeApi = api;
}

export function getChromeApi(): ChromeApi | null {
  return chromeApi;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function persistSnapshot(context: RecordingContext): Promise<void> {
  if (!chromeApi) return;
  
  const snapshot: SessionSnapshot = {
    recordingId: context.recordingId!,
    status: 'recording',
    startedAt: context.startedAt!,
    lastActivityAt: Date.now(),
    options: { ...context.options },
    strategy: context.strategy!,
    correlationId: context.correlationId!,
  };
  
  await chromeApi.storage.set({ [STORAGE_KEYS.SESSION_SNAPSHOT]: snapshot });
}

async function clearSnapshot(): Promise<void> {
  if (!chromeApi) return;
  await chromeApi.storage.remove(STORAGE_KEYS.SESSION_SNAPSHOT);
}

async function loadSnapshot(): Promise<SessionSnapshot | null> {
  if (!chromeApi) return null;
  const result = await chromeApi.storage.get(STORAGE_KEYS.SESSION_SNAPSHOT);
  return result[STORAGE_KEYS.SESSION_SNAPSHOT] as SessionSnapshot | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BADGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function updateBadge(status: string): Promise<void> {
  if (!chromeApi) return;
  
  let color = '#00000000';
  let text = '';
  
  if (status === 'recording') {
    color = '#d93025';
    text = 'REC';
  } else if (status === 'saving') {
    color = '#f9ab00';
    text = 'SAVE';
  }
  
  try {
    await chromeApi.action.setBadgeBackgroundColor({ color });
    await chromeApi.action.setBadgeText({ text });
  } catch (e) {
    // Non-critical
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFSCREEN HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function canUseOffscreen(): boolean {
  return !!(chromeApi?.offscreen?.createDocument);
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!canUseOffscreen()) {
    throw new Error('Offscreen API is not available; cannot create offscreen document.');
  }
  const existing = await chromeApi!.offscreen.hasDocument();
  if (existing) return;

  await chromeApi!.offscreen.createDocument({
    url: chromeApi!.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.',
  });
}

async function closeOffscreenDocumentIfIdle(): Promise<void> {
  if (!canUseOffscreen()) return;
  const existing = await chromeApi!.offscreen.hasDocument();
  if (existing) {
    await chromeApi!.offscreen.closeDocument();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function injectOverlay(tabId: number): Promise<boolean> {
  if (!chromeApi) return false;
  try {
    await chromeApi.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    console.log('Overlay injection failed (may be restricted page):', e);
    return false;
  }
}

async function removeOverlay(tabId: number): Promise<void> {
  if (!chromeApi) return;
  try {
    await chromeApi.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById('cc-overlay');
        if (el) el.remove();
      },
    });
  } catch (e) {
    console.warn('Overlay removal failed:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getActiveTabId(): Promise<number | null> {
  if (!chromeApi) return null;
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function focusTab(tabId: number): Promise<void> {
  if (!chromeApi) return;
  try {
    const tab = await chromeApi.tabs.get(tabId);
    if (tab?.windowId) {
      await chromeApi.windows.update(tab.windowId, { focused: true });
    }
    await chromeApi.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn('Tab focus failed:', e);
  }
}

async function removeRecorderTab(tabId: number): Promise<void> {
  if (!chromeApi) return;
  try {
    await chromeApi.tabs.remove(tabId);
  } catch (e) {
    console.warn('Recorder tab removal failed:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE QUOTA CHECK
// ═══════════════════════════════════════════════════════════════════════════════

export interface StorageCheckResult {
  ok: boolean;
  error?: string;
}

export async function checkStorageQuota(): Promise<StorageCheckResult> {
  // This would be implemented to check chrome.storage.local quota
  // For now, return ok - the service layer can override this
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONCURRENT RECORDING CHECK
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConcurrentCheckResult {
  ok: boolean;
  error?: string;
}

export async function checkNoConcurrentRecording(): Promise<ConcurrentCheckResult> {
  if (!chromeApi) return { ok: true };
  
  try {
    const result = await chromeApi.storage.get(STORAGE_KEYS.SESSION_SNAPSHOT);
    const snapshot = result[STORAGE_KEYS.SESSION_SNAPSHOT] as SessionSnapshot | undefined;
    
    if (snapshot) {
      const activeStatuses = ['starting', 'recording', 'stopping', 'saving'];
      if (activeStatuses.includes(snapshot.status)) {
        const age = Date.now() - snapshot.lastActivityAt;
        if (age < 30000) {
          return { ok: false, error: 'Recording already in progress' };
        }
      }
    }
  } catch (e) {
    console.warn('Failed to check for concurrent recording:', e);
  }
  
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// XSTATE V5 SETUP - ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const recordingActions = setup({
  actions: {
    // Initialize recording context on START
    initializeRecording: assign({
      recordingId: () => crypto.randomUUID(),
      correlationId: () => crypto.randomUUID(),
      startedAt: () => Date.now(),
      lastActivityAt: () => Date.now(),
      error: () => null,
      failedChunkCount: () => 0,
      overlayInjected: () => false,
    }),
    
    // Set recording options from START event
    setRecordingOptions: assign({
      options: ({ event }) => ({
        mode: (event as { type: 'START'; mode: RecordingMode }).mode,
        includeMic: (event as { type: 'START'; mic?: boolean }).mic ?? false,
        includeSystemAudio: (event as { type: 'START'; systemAudio?: boolean }).systemAudio ?? false,
      }),
    }),
    
    // Clear all state on idle/reset
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
    
    // Determine strategy based on includeMic option
    determineStrategy: assign({
      strategy: ({ context }) => context.options.includeMic ? 'page' : 'offscreen',
    }),
    
    // Set overlay tab ID
    setOverlayTabId: assign({
      overlayTabId: () => getActiveTabId() as unknown as number | null,
    }),
    
    // Mark overlay as injected
    setOverlayInjected: assign({
      overlayInjected: () => true,
    }),
    
    // Update last activity timestamp
    updateLastActivity: assign({
      lastActivityAt: () => Date.now(),
    }),
    
    // Set error
    setError: assign({
      error: ({ event }) => (event as { type: 'OFFSCREEN_ERROR' | 'RECORDER_ERROR'; error: string }).error,
    }),
    
    // Increment failed chunk count
    incrementFailedChunks: assign({
      failedChunkCount: ({ context }) => context.failedChunkCount + 1,
    }),
    
    // Persist session snapshot
    persistSession: async ({ context }) => {
      await persistSnapshot(context);
    },
    
    // Clear session snapshot
    clearSession: async () => {
      await clearSnapshot();
    },
    
    // Update badge to recording
    updateBadgeRecording: async () => {
      await updateBadge('recording');
    },
    
    // Update badge to saving
    updateBadgeSaving: async () => {
      await updateBadge('saving');
    },
    
    // Clear badge
    updateBadgeClear: async () => {
      await updateBadge('');
    },
    
    // Inject overlay on target tab
    injectOverlayAction: async ({ context }) => {
      if (context.overlayTabId) {
        const injected = await injectOverlay(context.overlayTabId);
        if (injected) {
          // This will be handled via context update
        }
      }
    },
    
    // Remove overlay
    removeOverlayAction: async ({ context }) => {
      if (context.overlayTabId) {
        await removeOverlay(context.overlayTabId);
      }
    },
    
    // Remove recorder tab
    removeRecorderTabAction: async ({ context }) => {
      if (context.recorderTabId) {
        await removeRecorderTab(context.recorderTabId);
      }
    },
    
    // Close offscreen document
    closeOffscreenDocument: async () => {
      await closeOffscreenDocumentIfIdle();
    },
    
    // Focus original tab
    focusOriginalTab: async ({ context }) => {
      if (context.overlayTabId) {
        await focusTab(context.overlayTabId);
      }
    },
    
    // Open preview tab
    openPreviewTab: async ({ context }) => {
      if (!chromeApi || !context.recordingId) return;
      const url = chromeApi.runtime.getURL(`preview.html?id=${encodeURIComponent(context.recordingId)}`);
      await chromeApi.tabs.create({ url });
    },
    
    // Reconcile from snapshot
    reconcileFromSnapshot: assign({
      recordingId: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { recordingId: string } }).snapshot.recordingId,
      strategy: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { strategy: RecordingStrategy } }).snapshot.strategy,
      startedAt: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { startedAt: number } }).snapshot.startedAt,
      lastActivityAt: () => Date.now(),
      options: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { options: RecordingContext['options'] } }).snapshot.options,
      correlationId: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { correlationId: string } }).snapshot.correlationId,
    }),
    
    // Start checkpoint timer (stores interval ID in context)
    startCheckpointTimer: assign({
      checkpointIntervalId: () => {
        // Note: This is a simplified version. In production, you'd use
        // XState's spawn mechanism with actors for proper interval management
        return setInterval(async () => {
          const api = getChromeApi();
          if (!api) return;
          const result = await api.storage.get(STORAGE_KEYS.SESSION_SNAPSHOT);
          const snapshot = result[STORAGE_KEYS.SESSION_SNAPSHOT] as SessionSnapshot | undefined;
          if (snapshot && (snapshot.status === 'recording' || snapshot.status === 'stopping')) {
            // Update snapshot with new timestamp
            await api.storage.set({
              [STORAGE_KEYS.SESSION_SNAPSHOT]: {
                ...snapshot,
                lastActivityAt: Date.now(),
              }
            });
          }
        }, TIMEOUTS.CHECKPOINT);
      },
    }),
    
    // Stop checkpoint timer
    stopCheckpointTimer: assign({
      checkpointIntervalId: ({ context }) => {
        if (context.checkpointIntervalId) {
          clearInterval(context.checkpointIntervalId);
        }
        return null;
      },
    }),
  },
  
  guards: {
    // Check if recording can start (no concurrent recording, storage quota ok)
    canStart: () => true, // Actual check done in service layer
    
    // Check if offscreen is available
    canUseOffscreen: () => canUseOffscreen(),
    
    // Check if mic is included (determines strategy)
    hasMicrophone: ({ context }) => context.options.includeMic,
    
    // Validate UUID format
    isValidUUID: ({ event }) => {
      if ('recordingId' in event && typeof (event as { recordingId?: string }).recordingId === 'string') {
        return isValidUUID((event as { recordingId: string }).recordingId);
      }
      return false;
    },
    
    // Check if recovery is possible
    canRecover: ({ event }) => {
      if ('recordingId' in event) {
        return isValidUUID((event as { recordingId: string }).recordingId);
      }
      return false;
    },
    
    // Check if session is stale (for recovery)
    isSessionStale: ({ context }) => {
      if (!context.lastActivityAt) return true;
      return Date.now() - context.lastActivityAt > TIMEOUTS.SAVE;
    },
  },
  
  actors: {
    // Actor to handle offscreen document setup
    setupOffscreen: fromPromise(async ({ input }: { input: { mode: RecordingMode; includeSystemAudio: boolean; recordingId: string; targetTabId: number | null } }) => {
      if (!chromeApi) throw new Error('Chrome API not initialized');
      
      await ensureOffscreenDocument();
      
      // Send OFFSCREEN_START message to offscreen document
      await chromeApi.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        mode: input.mode,
        includeAudio: input.includeSystemAudio,
        recordingId: input.recordingId,
        targetTabId: input.targetTabId,
      });
      
      return { strategy: 'offscreen' as const };
    }),
    
    // Actor to create recorder tab
    createRecorderTab: fromPromise(async ({ input }: { input: { recordingId: string; mode: RecordingMode; includeMic: boolean; includeSystemAudio: boolean } }) => {
      if (!chromeApi) throw new Error('Chrome API not initialized');
      
      const url = chromeApi.runtime.getURL(
        `recorder.html?id=${encodeURIComponent(input.recordingId)}&mode=${encodeURIComponent(input.mode)}&mic=${input.includeMic ? 1 : 0}&sys=${input.includeSystemAudio ? 1 : 0}`
      );
      
      const tab = await chromeApi.tabs.create({ url, active: true });
      
      return {
        strategy: 'page' as const,
        recorderTabId: tab.id ?? null,
      };
    }),
    
    // Actor to send stop message to recorder/offscreen
    sendStopMessage: fromPromise(async ({ input }: { input: { strategy: RecordingStrategy } }) => {
      if (!chromeApi) throw new Error('Chrome API not initialized');
      
      const messageType = input.strategy === 'page' ? 'RECORDER_STOP' : 'OFFSCREEN_STOP';
      await chromeApi.runtime.sendMessage({ type: messageType });
      
      return { stopped: true };
    }),
    
    // Callback actor for confirmation timeout
    confirmationTimeoutCallback: fromCallback<{ type: 'CONFIRMATION_TIMEOUT' }>(({ sendBack }) => {
      const timeout = setTimeout(() => {
        sendBack({ type: 'CONFIRMATION_TIMEOUT' });
      }, TIMEOUTS.CONFIRMATION);
      
      return () => clearTimeout(timeout);
    }),
    
    // Callback actor for save timeout
    saveTimeoutCallback: fromCallback<{ type: 'SAVE_TIMEOUT' }>(({ sendBack }) => {
      const timeout = setTimeout(() => {
        sendBack({ type: 'SAVE_TIMEOUT' });
      }, TIMEOUTS.SAVE);
      
      return () => clearTimeout(timeout);
    }),
  },
  
  delays: {
    CONFIRMATION_DELAY: TIMEOUTS.CONFIRMATION,
    SAVE_DELAY: TIMEOUTS.SAVE,
    CHECKPOINT_INTERVAL: TIMEOUTS.CHECKPOINT,
  },
}).create();

const { actions, guards, actors, delays } = recordingActions;

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
          guards: guards.canStart,
        },
        RECONCILE: {
          target: 'recording',
          actions: assign({
            recordingId: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { recordingId: string } }).snapshot.recordingId,
            strategy: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { strategy: RecordingStrategy } }).snapshot.strategy,
            startedAt: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { startedAt: number } }).snapshot.startedAt,
            lastActivityAt: () => Date.now(),
            options: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { options: RecordingContext['options'] } }).snapshot.options,
            correlationId: ({ event }) => (event as { type: 'RECONCILE'; snapshot: { correlationId: string } }).snapshot.correlationId,
          }),
        },
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // STARTING STATE
    // ─────────────────────────────────────────────────────────────────────────
    starting: {
      entry: assign({
        strategy: ({ context }) => context.options.includeMic ? 'page' : 'offscreen',
      }),
      invoke: {
        id: 'confirmationTimeout',
        src: 'confirmationTimeoutCallback',
        onDone: {
          target: 'recording',
        },
      },
      on: {
        OFFSCREEN_STARTED: [
          {
            target: 'recording',
            actions: [
              actions.updateLastActivity,
              actions.persistSession,
              actions.updateBadgeRecording,
            ],
          },
        ],
        RECORDER_STARTED: [
          {
            target: 'recording',
            actions: [
              actions.updateLastActivity,
              actions.persistSession,
              actions.updateBadgeRecording,
              actions.focusOriginalTab,
            ],
          },
        ],
        CONFIRMATION_TIMEOUT: [
          {
            target: 'recording',
            actions: [
              actions.updateLastActivity,
              actions.persistSession,
              actions.updateBadgeRecording,
            ],
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
            actions: [
              actions.clearSession,
              actions.updateBadgeClear,
            ],
          },
        ],
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // RECORDING STATE
    // ─────────────────────────────────────────────────────────────────────────
    recording: {
      entry: assign({
        lastActivityAt: () => Date.now(),
      }),
      invoke: {
        id: 'checkpointTimer',
        src: 'checkpointTimerActor',
      },
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
          actions: actions.incrementFailedChunks,
        },
        UPDATE_STATE: {
          actions: actions.updateLastActivity,
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
        id: 'saveTimeout',
        src: 'saveTimeoutCallback',
        onDone: {
          target: 'recoverable',
        },
      },
      on: {
        OFFSCREEN_DATA: [
          {
            target: 'saved',
            actions: [
              actions.clearSession,
              actions.updateBadgeClear,
              actions.openPreviewTab,
              actions.closeOffscreenDocument,
              actions.removeOverlayAction,
            ],
          },
        ],
        RECORDER_DATA: [
          {
            target: 'saved',
            actions: [
              actions.clearSession,
              actions.updateBadgeClear,
              actions.openPreviewTab,
              actions.removeOverlayAction,
              actions.removeRecorderTabAction,
            ],
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
    // SAVED STATE (terminal with auto-reset)
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
            actions: [
              actions.clearSession,
              actions.updateBadgeClear,
              actions.removeOverlayAction,
              actions.removeRecorderTabAction,
              actions.closeOffscreenDocument,
            ],
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
            actions: [
              actions.updateLastActivity,
              actions.persistSession,
              actions.updateBadgeRecording,
            ],
            guards: guards.isValidUUID,
          },
        ],
        RECOVERY_DISCARD: [
          {
            target: 'idle',
            actions: [
              actions.clearSession,
              actions.updateBadgeClear,
              actions.removeOverlayAction,
              actions.removeRecorderTabAction,
              actions.closeOffscreenDocument,
            ],
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
// HELPER ACTORS (not in setup due to XState v5 structure)
// ═══════════════════════════════════════════════════════════════════════════════

// Checkpoint timer actor that runs periodically
const checkpointTimerActor = fromCallback<{ type: 'CHECKPOINT_TICK' }>(({ sendBack }) => {
  const interval = setInterval(() => {
    sendBack({ type: 'CHECKPOINT_TICK' });
  }, TIMEOUTS.CHECKPOINT);
  
  return () => clearInterval(interval);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ACTOR CLASS WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

export class RecordingStateManager {
  private actor: ReturnType<typeof createActor<typeof recordingMachine>>;
  private subscription: { unsubscribe: () => void };
  private isRunning: boolean = false;
  
  constructor() {
    this.actor = createActor(recordingMachine);
    
    this.subscription = this.actor.subscribe((snapshot) => {
      this.handleStateChange(snapshot);
    });
    
    this.actor.start();
    this.isRunning = true;
  }
  
  private handleStateChange(snapshot: { value: string; context: RecordingContext }): void {
    const state = snapshot.value as string;
    console.log(`[RecordingStateManager] State: ${state}`, {
      recordingId: snapshot.context.recordingId,
    });
    
    // Update badge based on state
    updateBadge(state === 'recording' ? 'recording' : state === 'stopping' || state === 'saving' ? 'saving' : '');
    
    // Persist state during active recording
    if (state === 'recording' || state === 'stopping') {
      persistSnapshot(snapshot.context).catch(console.error);
    } else if (state === 'idle' || state === 'saved') {
      clearSnapshot().catch(console.error);
    }
  }
  
  /**
   * Send an event to the machine
   */
  send(event: RecordingEvent): void {
    this.actor.send(event);
  }
  
  /**
   * Get current snapshot
   */
  getSnapshot() {
    return this.actor.getSnapshot();
  }
  
  /**
   * Get current state name
   */
  getState(): string {
    return this.getSnapshot().value as string;
  }
  
  /**
   * Get current context
   */
  getContext(): RecordingContext {
    return this.getSnapshot().context;
  }
  
  /**
   * Check if recording is active
   */
  isRecording(): boolean {
    const state = this.getState();
    return state === 'recording' || state === 'stopping';
  }
  
  /**
   * Get current recording ID
   */
  getRecordingId(): string | null {
    return this.getContext().recordingId;
  }
  
  /**
   * Start recording with given options
   */
  async start(mode: RecordingMode, includeMic?: boolean, includeSystemAudio?: boolean): Promise<{ ok: boolean; overlayInjected?: boolean; error?: string }> {
    // Check for concurrent recording
    const concurrentCheck = await checkNoConcurrentRecording();
    if (!concurrentCheck.ok) {
      return { ok: false, error: concurrentCheck.error };
    }
    
    // Check storage quota
    const storageCheck = await checkStorageQuota();
    if (!storageCheck.ok) {
      return { ok: false, error: storageCheck.error };
    }
    
    // Get active tab for overlay
    const overlayTabId = await getActiveTabId();
    
    // Send START event
    this.send({
      type: 'START',
      mode,
      mic: includeMic,
      systemAudio: includeSystemAudio,
    } as RecordingEvent);
    
    // Wait for recording to actually start (give time for offscreen/tab creation)
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Try to inject overlay
    let overlayInjected = false;
    if (overlayTabId) {
      overlayInjected = await injectOverlay(overlayTabId);
    }
    
    return { ok: true, overlayInjected };
  }
  
  /**
   * Stop recording
   */
  async stop(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isRecording()) {
      return { ok: false, error: 'Not recording' };
    }
    
    this.send({ type: 'STOP' } as RecordingEvent);
    return { ok: true };
  }
  
  /**
   * Reset to idle state
   */
  reset(): void {
    this.send({ type: 'RESET' } as RecordingEvent);
  }
  
  /**
   * Destroy the manager
   */
  destroy(): void {
    if (this.isRunning) {
      this.actor.stop();
      this.subscription.unsubscribe();
      this.isRunning = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

let manager: RecordingStateManager | null = null;

export function createRecordingManager(): RecordingStateManager {
  if (manager) {
    return manager;
  }
  manager = new RecordingStateManager();
  return manager;
}

export function getRecordingManager(): RecordingStateManager | null {
  return manager;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RE-EXPORT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type { RecordingContext, RecordingEvent, SessionSnapshot, RecordingMode } from './types';