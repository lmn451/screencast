/**
 * Recording Service
 *
 * Bridges XState machine with Chrome APIs.
 * This service handles all Chrome-specific operations and
 * translates them to machine events.
 *
 * Key principle: The XState machine is PURE (state + assign only).
 * All Chrome API side effects live in this service.
 */

import { createActor } from 'xstate';
import {
  recordingMachine,
  type RecordingContext,
  type SessionSnapshot,
} from '../machines/recordingMachine.js';
import {
  MSG_RECOVERY_DISCARD,
  MSG_STATE_UPDATE,
  MSG_OVERLAY_REMOVE,
  MSG_OFFSCREEN_START,
  MSG_OFFSCREEN_STOP,
  MSG_RECORDER_STOP,
  MSG_HEARTBEAT,
  buildMessage,
  type ExtensionMessage,
  type RecordingMode,
  type StructuredError,
} from '../messages.js';
import { checkStorageQuota } from '../lib/storage-utils.js';
import {
  TIMEOUTS,
  STORAGE_KEYS,
  isValidUUID,
  sessionSnapshotStorageKey,
  sessionRetirementStorageKey,
  type SessionRetirement,
} from '../machines/types.js';
import {
  claimSessionOwner,
  readSessionOwner,
  retireSessionOwner,
  updateSessionOwner,
  type SessionOwner,
} from '../lib/session-metadata.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ChromeAPI {
  storage: {
    get: (key: string | string[] | null) => Promise<Record<string, unknown>>;
    set: (data: Record<string, unknown>) => Promise<void>;
    remove: (key: string | string[]) => Promise<void>;
  };
  tabs: {
    query: (query: {
      active?: boolean;
      currentWindow?: boolean;
    }) => Promise<Array<{ id?: number; windowId?: number; url?: string }>>;
    create: (options: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    remove: (tabId: number) => Promise<void>;
    update: (tabId: number, options: { active: boolean }) => Promise<unknown>;
    get: (tabId: number) => Promise<{ windowId: number }>;
    sendMessage: (tabId: number, message: ExtensionMessage) => Promise<void>;
  };
  scripting: {
    executeScript: (options: {
      target: { tabId: number };
      files?: string[];
      func?: () => void;
    }) => Promise<unknown>;
  };
  offscreen: {
    createDocument: (options: {
      url: string;
      reasons: string[];
      justification: string;
    }) => Promise<void>;
    closeDocument: () => Promise<void>;
    hasDocument: () => Promise<boolean>;
  };
  capabilities?: {
    offscreen: boolean;
  };
  action: {
    setBadgeBackgroundColor: (options: { color: string }) => Promise<void>;
    setBadgeText: (options: { text: string }) => Promise<void>;
  };
  runtime: {
    getURL: (path: string) => string;
    findRecorderTabIds?: (recordingId: string) => Promise<number[]>;
    sendMessage: (message: ExtensionMessage) => Promise<unknown>;
    id: string;
  };
  windows: {
    update: (windowId: number, options: { focused: boolean }) => Promise<unknown>;
  };
  // Optional so existing test doubles that omit it stay valid; the production
  // wrapper in background.ts always supplies it. MV3 checkpoint scheduling.
  alarms?: {
    create: (
      name: string,
      alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }
    ) => void;
    clear: (name: string) => Promise<boolean>;
  };
}

/**
 * Normalize a wire error payload (structured object from createError, or a
 * plain string) into the display string the recording machine stores in
 * context.error.
 */
function toErrorText(error: string | StructuredError): string {
  if (typeof error === 'string') return error;
  return error?.userMessage || 'Recording failed';
}

/**
 * Name of the self-rescheduling checkpoint alarm. Shared with background.ts,
 * which owns the chrome.alarms.onAlarm listener and dispatches to
 * RecordingService.handleCheckpointAlarm.
 */
export const CHECKPOINT_ALARM_NAME = 'screensilo-checkpoint';

/** State owned by one asynchronous start attempt. */
interface StartupAttempt {
  recordingId: string;
  generation: number;
  strategy: RecordingContext['strategy'];
  cancelled: boolean;
  recorderTabId: number | null;
  offscreenStartRequested: boolean;
}

interface PersistedSessionState {
  snapshots: SessionSnapshot[];
  retirements: SessionRetirement[];
}

const LIVE_SESSION_STATUSES = new Set(['starting', 'recording', 'stopping']);
const RESOURCE_LOCK_NAME = 'screensilo-recording-resources';
let fallbackResourceLock: Promise<void> = Promise.resolve();

/**
 * Serialize browser-context creation and teardown across service workers. The
 * IndexedDB owner fence protects metadata, while Web Locks closes the
 * read/check/Chrome-call gap for the global offscreen document and tab IDs.
 * The local queue is used by unit environments that do not expose
 * navigator.locks; supported extension browsers use the cross-worker lock.
 */
function withResourceLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (locks) {
    return locks.request(RESOURCE_LOCK_NAME, operation);
  }
  const result = fallbackResourceLock.then(operation);
  fallbackResourceLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPersistedSessionSnapshot(value: unknown): value is SessionSnapshot {
  return (
    isObject(value) &&
    typeof value.recordingId === 'string' &&
    isValidUUID(value.recordingId) &&
    typeof value.status === 'string' &&
    (value.startedAt === undefined || typeof value.startedAt === 'number') &&
    (value.lastActivityAt === undefined || typeof value.lastActivityAt === 'number') &&
    (value.options === undefined || isObject(value.options)) &&
    (value.strategy === undefined ||
      value.strategy === 'offscreen' ||
      value.strategy === 'page' ||
      value.strategy === null) &&
    (value.correlationId === undefined || typeof value.correlationId === 'string') &&
    (value.generation === undefined || typeof value.generation === 'number')
  );
}

function isSessionRetirement(value: unknown): value is SessionRetirement {
  return (
    isObject(value) &&
    typeof value.recordingId === 'string' &&
    isValidUUID(value.recordingId) &&
    (value.strategy === 'offscreen' || value.strategy === 'page' || value.strategy === null) &&
    (value.recorderTabId === null || typeof value.recorderTabId === 'number') &&
    (value.overlayTabId === null || typeof value.overlayTabId === 'number')
  );
}

class StartupCancelledError extends Error {
  constructor() {
    super('Recording start was cancelled during initialization');
    this.name = 'StartupCancelledError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDING SERVICE
//
// Sender validation, schema validation, and rate limiting all live in
// `src/background.ts`'s `chrome.runtime.onMessage` listener — the single
// extension-wide entry point. handleMessage assumes the message has already
// been validated and is from a trusted sender.
// ═══════════════════════════════════════════════════════════════════════════════

export class RecordingService {
  private readonly chrome: ChromeAPI;
  private readonly actor: ReturnType<typeof createActor<typeof recordingMachine>>;
  private confirmationTimeout: ReturnType<typeof setTimeout> | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private overlayTabId: number | null = null;
  private recorderTabId: number | null = null;
  private lastActorState: string | null = null;
  // Ticks the action badge once per second with the live recording duration
  // while the machine is in `recording`. The badge text is owned by the browser,
  // so it survives a service-worker eviction; the timer is re-armed on restore.
  private badgeTimer: ReturnType<typeof setInterval> | null = null;
  // Serializes onStateChange so persist/clear/close/badge side effects cannot
  // interleave across rapid transitions (notably saved→idle).
  private stateChangeQueue: Promise<void> = Promise.resolve();
  private sessionStorageQueue: Promise<void> = Promise.resolve();
  private checkpointActive = false;
  private startInProgress = false;
  private startupAttempt: StartupAttempt | null = null;
  // Terminal transitions can precede asynchronous snapshot removal. Never let
  // a wakeup in this worker reclaim a session it has already finished/cancelled.
  private readonly retiredRecordingIds = new Set<string>();
  private readonly retirementWrites = new Map<string, Promise<void>>();
  private lastSessionRecordingId: string | null = null;
  private sessionGeneration: number | null = null;

  constructor(chrome: ChromeAPI) {
    this.chrome = chrome;

    // Create XState actor
    this.actor = createActor(recordingMachine);

    // Start the actor before subscribing. XState publishes its initial idle
    // snapshot to subscribers during start; treating that publication as a
    // real idle transition would clear a persisted live session and close its
    // offscreen document before the first heartbeat/GET_STATE can reclaim it.
    this.actor.start();
    this.lastActorState = this.actor.getSnapshot().value;

    // Subscribe to state changes for side effects (badge, persistence, overlay).
    // Chained through a promise queue so each onStateChange fully settles before
    // the next runs, preventing interleaved storage/offscreen operations.
    this.actor.subscribe((snapshot) => {
      const recordingId = snapshot.context.recordingId ?? this.lastSessionRecordingId;
      if (snapshot.context.recordingId) this.lastSessionRecordingId = snapshot.context.recordingId;
      if (
        snapshot.matches('saved') ||
        snapshot.matches('failed') ||
        snapshot.matches('recoverable')
      ) {
        void this.retireRecording(snapshot.context.recordingId);
      }
      this.stateChangeQueue = this.stateChangeQueue
        .then(() => this.onStateChange(snapshot, recordingId))
        .catch((e) => {
          console.warn('[RecordingService] onStateChange failed:', e);
        });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE CHANGE HANDLER (Chrome API side effects)
  // ═══════════════════════════════════════════════════════════════════════════

  private async onStateChange(
    snapshot: {
      value: string;
      context: RecordingContext;
    },
    recordingId: string | null
  ): Promise<void> {
    const state = snapshot.value;
    const context = snapshot.context;
    const previousState = this.lastActorState;
    this.lastActorState = state;
    if (state === 'saved' || state === 'failed' || state === 'recoverable') {
      await this.retireRecording(context.recordingId);
    }

    // Badge management
    await this.updateBadge(state);

    // Keep the duration badge ticking once per second while recording. The
    // badge timer is a secondary keepalive; the capture-context heartbeat
    // remains the primary one and also re-arms this timer after a restart.
    if (state === 'recording') {
      this.startBadgeTimer();
    } else {
      this.stopBadgeTimer();
    }

    // Push the new status to the overlay button. The overlay's initial
    // GET_STATE races the recorder acknowledgment: if it resolves during
    // `starting`, the button renders a disabled "Starting…" and, without this
    // push, never learns about the starting→recording transition.
    if (
      this.overlayTabId &&
      (state === 'starting' || state === 'recording' || state === 'stopping')
    ) {
      try {
        await this.chrome.tabs.sendMessage(
          this.overlayTabId,
          buildMessage(MSG_STATE_UPDATE, { status: state })
        );
      } catch (e) {
        // Non-critical: overlay may not be injected (yet) on this tab.
      }
    }

    // Session persistence based on state. Persist from `starting` onward so a
    // service-worker restart during startup still leaves a restorable snapshot.
    if (state === 'starting' || state === 'recording' || state === 'stopping') {
      await this.persistSessionSnapshot(context);
    } else if (
      state === 'idle' ||
      state === 'saved' ||
      state === 'failed' ||
      state === 'recoverable'
    ) {
      await this.clearSessionSnapshot(recordingId);
    }

    // Overlay removal on transition back to idle.
    // (Injection is driven explicitly from startRecording, not from state changes,
    // since overlayTabId is owned by the service instance, not the machine context.)
    if (state === 'idle' && this.overlayTabId && previousState && previousState !== 'idle') {
      const overlayTabId = this.overlayTabId;
      await withResourceLock(async () => {
        const owner = await this.readDurableOwner();
        const protectedByAnotherOwner =
          owner === undefined ||
          (owner?.status === 'active' &&
            owner.recordingId !== recordingId &&
            owner.overlayTabId === overlayTabId);
        if (!protectedByAnotherOwner) await this.removeOverlay(overlayTabId);
        if (this.overlayTabId === overlayTabId) this.overlayTabId = null;
      });
    }

    // Offscreen document lifecycle
    if (state === 'idle') {
      await this.closeOffscreenDocumentIfIdle(recordingId);
    } else if (state === 'recoverable' || state === 'failed') {
      await this.cleanupResources(recordingId);
      if (recordingId) await this.finishRetirement(recordingId);
    }
  }

  private async updateBadge(state: string): Promise<void> {
    try {
      let color = '#00000000';
      let text = '';

      if (state === 'recording') {
        color = '#d93025';
        text = this.formatBadgeDuration();
      } else if (state === 'stopping') {
        color = '#f9ab00';
        text = 'SAVE';
      }

      await this.chrome.action.setBadgeBackgroundColor({ color });
      await this.chrome.action.setBadgeText({ text });
    } catch (e) {
      // Non-critical
    }
  }

  /** Elapsed recording time as `M:SS` (fits Chrome's ~4-char badge budget). */
  private formatBadgeDuration(): string {
    const startedAt = this.actor.getSnapshot().context.startedAt;
    if (!startedAt) return 'REC';
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private startBadgeTimer(): void {
    if (this.badgeTimer) return;
    this.badgeTimer = setInterval(() => {
      void this.updateBadge('recording');
    }, 1000);
  }

  private stopBadgeTimer(): void {
    if (this.badgeTimer) {
      clearInterval(this.badgeTimer);
      this.badgeTimer = null;
    }
  }

  private queueSessionStorage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionStorageQueue.then(operation);
    this.sessionStorageQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async readDurableOwner(): Promise<SessionOwner | null | undefined> {
    try {
      return await readSessionOwner();
    } catch (e) {
      console.warn('[RecordingService] Failed to read durable session owner:', e);
      // `null` means the metadata store is healthy and has no owner. Keep an
      // unavailable store distinct so recovery and destructive cleanup fail
      // closed instead of treating an unknown owner as idle.
      return undefined;
    }
  }

  private async claimDurableOwner(
    recordingId: string,
    strategy: RecordingContext['strategy'],
    recorderTabId: number | null,
    overlayTabId: number | null,
    persistedSnapshot?: SessionSnapshot
  ): Promise<SessionOwner | null> {
    try {
      const current = this.actor.getSnapshot();
      const snapshot =
        persistedSnapshot ??
        (current.context.recordingId === recordingId
          ? this.snapshotFromContext(current.context)
          : undefined);
      const owner = await claimSessionOwner({
        recordingId,
        strategy,
        recorderTabId,
        overlayTabId,
        snapshot,
      });
      if (owner) this.sessionGeneration = owner.generation;
      return owner;
    } catch (e) {
      console.warn('[RecordingService] Failed to claim durable session owner:', e);
      return null;
    }
  }

  private async retireDurableOwner(
    recordingId: string,
    strategy: RecordingContext['strategy'],
    recorderTabId: number | null,
    overlayTabId: number | null
  ): Promise<boolean> {
    try {
      return await retireSessionOwner(recordingId, {
        strategy,
        recorderTabId,
        overlayTabId,
      });
    } catch (e) {
      console.warn('[RecordingService] Failed to retire durable session owner:', e);
      return false;
    }
  }

  private async updateDurableOwner(
    recordingId: string,
    strategy: RecordingContext['strategy'],
    recorderTabId: number | null,
    overlayTabId: number | null
  ): Promise<boolean> {
    try {
      return await updateSessionOwner(recordingId, {
        strategy,
        recorderTabId,
        overlayTabId,
      });
    } catch (e) {
      console.warn('[RecordingService] Failed to update durable session owner:', e);
      return false;
    }
  }

  /**
   * Read the small session metadata set in one operation. New workers keep
   * each recording in its own key, while the singleton keys are read only for
   * upgrades from versions that predate per-recording storage.
   */
  private async readPersistedSessionState(): Promise<PersistedSessionState> {
    const values = await this.chrome.storage.get(null);
    const snapshotsById = new Map<string, SessionSnapshot>();
    const snapshotIsPerRecording = new Map<string, boolean>();
    const retirementsById = new Map<string, SessionRetirement>();

    for (const [key, value] of Object.entries(values)) {
      if (
        (key === STORAGE_KEYS.SESSION_SNAPSHOT ||
          key.startsWith(STORAGE_KEYS.SESSION_SNAPSHOT_PREFIX)) &&
        isPersistedSessionSnapshot(value)
      ) {
        const existing = snapshotsById.get(value.recordingId);
        const isPerRecording = key.startsWith(STORAGE_KEYS.SESSION_SNAPSHOT_PREFIX);
        const existingIsPerRecording = snapshotIsPerRecording.get(value.recordingId) ?? false;
        if (
          !existing ||
          (isPerRecording && !existingIsPerRecording) ||
          (isPerRecording === existingIsPerRecording &&
            (value.lastActivityAt ?? 0) >= (existing.lastActivityAt ?? 0))
        ) {
          snapshotsById.set(value.recordingId, value);
          snapshotIsPerRecording.set(value.recordingId, isPerRecording);
        }
      }

      if (
        (key === STORAGE_KEYS.SESSION_RETIREMENT ||
          key.startsWith(STORAGE_KEYS.SESSION_RETIREMENT_PREFIX)) &&
        isSessionRetirement(value)
      ) {
        retirementsById.set(value.recordingId, value);
      }
    }

    return {
      snapshots: [...snapshotsById.values()],
      retirements: [...retirementsById.values()],
    };
  }

  private selectPersistedSnapshot(
    state: PersistedSessionState,
    owner: SessionOwner | null = null,
    retiredIds = new Set(state.retirements.map((retirement) => retirement.recordingId))
  ): SessionSnapshot | undefined {
    // The owner claim includes a full snapshot in the same transaction. It
    // remains recoverable even if the worker dies before chrome.storage.set.
    const snapshots =
      owner?.status === 'active' && isPersistedSessionSnapshot(owner.snapshot)
        ? [
            {
              ...owner.snapshot,
              generation: owner.generation,
              recorderTabId: owner.recorderTabId,
              overlayTabId: owner.overlayTabId,
            },
          ]
        : state.snapshots;
    return snapshots
      .filter((snapshot) => !retiredIds.has(snapshot.recordingId))
      .filter((snapshot) => snapshot.status !== 'idle')
      .filter((snapshot) => {
        if (!owner) return true;
        if (owner.status !== 'active' || snapshot.recordingId !== owner.recordingId) return false;
        return snapshot.generation == null || snapshot.generation === owner.generation;
      })
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
  }

  /** Public read used by background reconciliation without exposing storage. */
  async getPersistedSessionSnapshot(): Promise<SessionSnapshot | undefined> {
    const state = await this.readPersistedSessionState();
    const owner = await this.readDurableOwner();
    if (owner === undefined)
      throw new Error('Session ownership is unavailable; retry reconciliation');
    return this.selectPersistedSnapshot(state, owner);
  }

  private snapshotFromContext(context: RecordingContext): SessionSnapshot {
    return {
      recordingId: context.recordingId!,
      ...(this.sessionGeneration == null ? {} : { generation: this.sessionGeneration }),
      status: this.actor.getSnapshot().value as SessionSnapshot['status'],
      startedAt: context.startedAt ?? Date.now(),
      lastActivityAt: Date.now(),
      options: { ...context.options },
      strategy: context.strategy,
      correlationId: context.correlationId ?? context.recordingId!,
      recorderTabId: context.recorderTabId,
      overlayTabId: context.overlayTabId,
    };
  }

  private async persistSessionSnapshot(context: RecordingContext): Promise<void> {
    return this.queueSessionStorage(() => this.writeSessionSnapshot(context));
  }

  private async writeSessionSnapshot(context: RecordingContext): Promise<void> {
    if (!context.recordingId || this.retiredRecordingIds.has(context.recordingId)) return;
    this.lastSessionRecordingId = context.recordingId;
    const current = this.actor.getSnapshot();
    if (
      !(
        current.matches('starting') ||
        current.matches('recording') ||
        current.matches('stopping')
      ) ||
      current.context.recordingId !== context.recordingId
    ) {
      return;
    }

    try {
      const snapshot = this.snapshotFromContext(current.context);
      await updateSessionOwner(context.recordingId, {
        strategy: current.context.strategy,
        recorderTabId: current.context.recorderTabId,
        overlayTabId: current.context.overlayTabId,
        snapshot,
      });
      // The per-recording key is authoritative. A delayed operation from an
      // older worker can never overwrite another recording's key.
      await this.chrome.storage.set({ [sessionSnapshotStorageKey(context.recordingId)]: snapshot });
    } catch (e) {
      console.warn('[RecordingService] Failed to persist session snapshot:', e);
    }
  }

  private async clearSessionSnapshot(recordingId = this.lastSessionRecordingId): Promise<void> {
    if (!recordingId) return;
    try {
      await this.queueSessionStorage(async () => {
        await this.chrome.storage.remove(sessionSnapshotStorageKey(recordingId));
      });
    } catch (e) {
      console.warn('[RecordingService] Failed to clear session snapshot:', e);
    }
  }

  private async clearActiveSessionArtifacts(): Promise<void> {
    // The terminal transition already queued badge and snapshot cleanup.
    // A second removal outside that queue could erase a later retry's state.
    await this.settleStateChanges();
  }

  async clearInterruptedSessionSnapshot(recordingId: string): Promise<boolean> {
    return this.queueSessionStorage(async () => {
      const isLive = () => {
        const current = this.actor.getSnapshot();
        return (
          current.matches('starting') || current.matches('recording') || current.matches('stopping')
        );
      };
      if (isLive()) return false;
      const state = await this.readPersistedSessionState();
      const persisted = state.snapshots.find((snapshot) => snapshot.recordingId === recordingId);
      if (
        !persisted ||
        state.retirements.some((retirement) => retirement.recordingId === recordingId)
      ) {
        return false;
      }

      // Turn an interrupted legacy snapshot into an isolated retirement marker
      // before clearing its per-recording copy. The legacy singleton is left
      // untouched because a delayed old worker must never delete a newer
      // worker's mirror from that shared key.
      const retired = await this.retireDurableOwner(
        recordingId,
        persisted.strategy ?? null,
        persisted.recorderTabId ?? null,
        persisted.overlayTabId ?? null
      );
      if (!retired || isLive()) return false;
      await this.chrome.storage.set({
        [sessionRetirementStorageKey(recordingId)]: {
          recordingId,
          strategy: persisted.strategy,
          recorderTabId: persisted.recorderTabId ?? null,
          overlayTabId: persisted.overlayTabId ?? null,
        } satisfies SessionRetirement,
      });
      if (isLive()) return false;
      await this.chrome.storage.remove(sessionSnapshotStorageKey(recordingId));
      return true;
    });
  }

  /** Wait until all queued state side effects observed so far have settled. */
  private async settleStateChanges(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.stateChangeQueue;
      await pending;
    } while (pending !== this.stateChangeQueue);
  }

  /**
   * Return whether an asynchronous startup still owns the machine. The object
   * identity check matters when a later recording has already begun: a late
   * resolution from an older tab/document must never arm timers or publish a
   * start acknowledgement for the new session.
   */
  private isCurrentStartup(attempt: StartupAttempt): boolean {
    const snapshot = this.actor.getSnapshot();
    return (
      this.startupAttempt === attempt &&
      !attempt.cancelled &&
      (snapshot.matches('starting') || snapshot.matches('recording')) &&
      snapshot.context.recordingId === attempt.recordingId
    );
  }

  private isStoppingStartup(attempt: StartupAttempt): boolean {
    const snapshot = this.actor.getSnapshot();
    return (
      !attempt.cancelled &&
      snapshot.matches('stopping') &&
      snapshot.context.recordingId === attempt.recordingId
    );
  }

  /** Mark startup cancelled synchronously before any asynchronous teardown. */
  private invalidateStartup(recordingId?: string): boolean {
    const attempt = this.startupAttempt;
    if (!attempt || (recordingId && attempt.recordingId !== recordingId)) {
      return false;
    }
    attempt.cancelled = true;
    return true;
  }

  private async sendStartupStop(attempt: StartupAttempt | null): Promise<void> {
    const snapshot = this.actor.getSnapshot();
    const strategy = attempt?.strategy ?? snapshot.context.strategy;

    // A stop command is best effort here. In particular, OFFSCREEN_START or
    // getDisplayMedia may still be awaiting a picker; waiting for that request
    // would prevent cancellation from closing the context that owns it.
    if (strategy === 'offscreen' && (attempt == null || attempt.offscreenStartRequested)) {
      try {
        await this.chrome.runtime.sendMessage(buildMessage(MSG_OFFSCREEN_STOP));
      } catch (e) {
        console.warn('[RecordingService] Startup offscreen stop failed:', e);
      }
      return;
    }

    const recorderTabId = attempt?.recorderTabId ?? this.recorderTabId;
    if (strategy === 'page' && recorderTabId != null) {
      try {
        await this.chrome.tabs.sendMessage(recorderTabId, buildMessage(MSG_RECORDER_STOP));
      } catch (e) {
        // The tab may still be loading or may already have been closed. The
        // subsequent tabs.remove call is what aborts a pending picker.
      }
    }
  }

  /**
   * Cancel a startup and tear down every resource that may have been created
   * before the cancellation arrived. The stop command is issued before the
   * generic cleanup so a live recorder gets a chance to flush/stop, while
   * tabs.remove/offscreen.closeDocument still abort a pending picker.
   */
  private async cancelStartup(attempt: StartupAttempt | null): Promise<void> {
    const currentContext = this.actor.getSnapshot().context;
    this.clearTimers();
    await this.retireRecording(currentContext.recordingId);
    const stopAttempt =
      attempt ??
      ({
        recordingId: currentContext.recordingId ?? '',
        generation: this.sessionGeneration ?? 0,
        strategy: currentContext.strategy,
        cancelled: true,
        recorderTabId: this.recorderTabId,
        offscreenStartRequested: false,
      } satisfies StartupAttempt);
    if (attempt) attempt.cancelled = true;

    // Mark the machine idle immediately so late acknowledgements are rejected;
    // invalidateStartup above makes the in-flight initializer reject as soon
    // as its pending Chrome call settles.
    if (this.actor.getSnapshot().matches('starting')) {
      this.actor.send({ type: 'STOP' });
    }

    // Do not wait for the acknowledgement: the start request itself may be
    // waiting on a browser permission picker and a test or browser runtime can
    // keep that request pending until the document is torn down. The command
    // is invoked synchronously before cleanup, while cleanup owns the actual
    // tab/document close that aborts the picker.
    void this.sendStartupStop(stopAttempt);
    await this.cleanup();
    await this.settleStateChanges();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private async injectOverlay(tabId: number): Promise<boolean> {
    try {
      await this.chrome.scripting.executeScript({
        target: { tabId },
        files: ['build/overlay.js'],
      });
      return true;
    } catch (e) {
      console.log('[RecordingService] Overlay injection failed:', e);
      return false;
    }
  }

  private async removeOverlay(tabId: number): Promise<void> {
    try {
      await this.chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const el = document.getElementById('cc-overlay');
          if (el) el.remove();
        },
      });
    } catch (e) {
      console.warn('[RecordingService] Overlay removal failed:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OFFSCREEN DOCUMENT LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  private async ensureOffscreenDocument(
    mode: RecordingMode,
    includeSystemAudio: boolean,
    bestQuality: boolean,
    recordingId: string,
    targetTabId: number | null,
    attempt: StartupAttempt
  ): Promise<void> {
    try {
      await withResourceLock(async () => {
        const existing = await this.chrome.offscreen.hasDocument();
        if (!this.isCurrentStartup(attempt)) throw new StartupCancelledError();
        const owner = await this.readDurableOwner();
        if (
          !owner ||
          owner.status !== 'active' ||
          owner.recordingId !== attempt.recordingId ||
          owner.generation !== attempt.generation
        ) {
          throw new StartupCancelledError();
        }
        if (!existing) {
          await this.chrome.offscreen.createDocument({
            url: this.chrome.runtime.getURL('offscreen.html'),
            reasons: ['USER_MEDIA', 'BLOBS'],
            justification:
              'Record a screen capture stream using MediaRecorder in an offscreen document.',
          });
        }
      });

      if (!this.isCurrentStartup(attempt)) throw new StartupCancelledError();
      const owner = await this.readDurableOwner();
      if (
        !owner ||
        owner.status !== 'active' ||
        owner.recordingId !== attempt.recordingId ||
        owner.generation !== attempt.generation
      ) {
        throw new StartupCancelledError();
      }

      // Send start message to offscreen
      attempt.offscreenStartRequested = true;
      await this.chrome.runtime.sendMessage(
        buildMessage(MSG_OFFSCREEN_START, {
          mode,
          includeAudio: includeSystemAudio,
          bestQuality,
          recordingId,
          targetTabId: targetTabId ?? undefined,
        })
      );
      if (!this.isCurrentStartup(attempt)) throw new StartupCancelledError();
    } catch (e) {
      if (e instanceof StartupCancelledError || !this.isCurrentStartup(attempt)) {
        throw new StartupCancelledError();
      }
      console.error('[RecordingService] Failed to create offscreen document:', e);
      throw e;
    }
  }

  private async openRecorderTab(
    mode: 'tab' | 'window' | 'screen',
    includeMic: boolean,
    includeSystemAudio: boolean,
    bestQuality: boolean,
    recordingId: string,
    attempt: StartupAttempt
  ): Promise<void> {
    const params = new URLSearchParams({
      id: recordingId,
      mode,
      mic: includeMic ? '1' : '0',
      sys: includeSystemAudio ? '1' : '0',
      best: bestQuality ? '1' : '0',
    });
    const tab = await this.chrome.tabs.create({
      url: this.chrome.runtime.getURL(`recorder.html?${params.toString()}`),
      active: true,
    });
    const recorderTabId = tab.id;

    if (recorderTabId == null) {
      throw new Error('Recorder tab was not created');
    }

    // Record ownership as soon as tabs.create resolves. tabs.get can race a
    // user cancellation (or a tab close), and cleanup still needs this ID to
    // abort the page's pending getDisplayMedia picker.
    attempt.recorderTabId = recorderTabId;
    this.recorderTabId = recorderTabId;
    this.actor.send({
      type: 'SET_RECORDER_TAB_ID',
      tabId: recorderTabId,
    });

    const ownerUpdated = await this.updateDurableOwner(
      attempt.recordingId,
      attempt.strategy,
      recorderTabId,
      this.overlayTabId
    );
    if (!ownerUpdated && this.isCurrentStartup(attempt)) {
      throw new Error('Failed to update durable recorder ownership');
    }

    if (!this.isCurrentStartup(attempt)) {
      if (this.isStoppingStartup(attempt)) return;
      try {
        await this.chrome.tabs.remove(recorderTabId);
      } catch (e) {
        // The tab may have been removed by the cancellation path already.
      }
      throw new StartupCancelledError();
    }

    // Verify the tab still exists before recording service ownership.
    try {
      await this.chrome.tabs.get(recorderTabId);
    } catch (e) {
      if (!this.isCurrentStartup(attempt)) throw new StartupCancelledError();
      throw e;
    }

    if (!this.isCurrentStartup(attempt)) {
      if (this.isStoppingStartup(attempt)) return;
      try {
        await this.chrome.tabs.remove(recorderTabId);
      } catch (e) {
        // The tab may have been removed by the cancellation path already.
      }
      throw new StartupCancelledError();
    }
  }

  private async closeOffscreenDocumentIfIdle(
    recordingId = this.lastSessionRecordingId
  ): Promise<void> {
    await withResourceLock(async () => {
      try {
        const existing = await this.chrome.offscreen.hasDocument();
        if (existing) {
          const state = this.actor.getSnapshot().value;
          const owner = await this.readDurableOwner();
          const ownedByAnotherActiveSession =
            owner === undefined ||
            (owner?.status === 'active' &&
              owner.recordingId !== recordingId &&
              owner.strategy === 'offscreen');
          if (state === 'idle' && !ownedByAnotherActiveSession) {
            await this.chrome.offscreen.closeDocument();
          }
        }
      } catch (e) {
        console.warn('[RecordingService] Failed to close offscreen document:', e);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private startCheckpointTimer(): void {
    this.stopCheckpointTimer();
    this.checkpointActive = true;
    // MV3: setInterval does not survive service-worker suspension. Use a
    // chrome.alarms-backed checkpoint instead. TIMEOUTS.CHECKPOINT (30s) sits
    // AT the ~30s alarms floor, so we schedule a one-shot alarm and re-arm it
    // on each fire (handleCheckpointAlarm) rather than relying on a sub-floor
    // periodic alarm. background.ts owns the onAlarm listener.
    this.chrome.alarms?.create(CHECKPOINT_ALARM_NAME, {
      delayInMinutes: TIMEOUTS.CHECKPOINT / 60000,
    });
  }

  private stopCheckpointTimer(): void {
    this.checkpointActive = false;
    // Fire-and-forget clear; keeps this method synchronous for callers.
    void this.chrome.alarms?.clear(CHECKPOINT_ALARM_NAME);
  }

  /**
   * Handle a checkpoint alarm fire (dispatched from background.ts's onAlarm
   * listener). Persists the session snapshot while recording/stopping and
   * re-arms the one-shot alarm; stops re-arming once the machine leaves an
   * active state.
   */
  async handleCheckpointAlarm(): Promise<void> {
    if (!this.checkpointActive) {
      // This alarm fired after a service-worker restart. The in-memory machine
      // was lost; if a live capture still exists, reclaim it before deciding
      // whether to persist and re-arm.
      await this.restoreSession();
    }

    const snapshot = this.actor.getSnapshot();
    const state = snapshot.value;
    const isActiveState = state === 'recording' || state === 'stopping';

    if (this.checkpointActive && isActiveState) {
      if (snapshot.context.recordingId) {
        await this.persistSessionSnapshot(snapshot.context);
      }

      const currentState = this.actor.getSnapshot().value;
      if (this.checkpointActive && (currentState === 'recording' || currentState === 'stopping')) {
        this.chrome.alarms?.create(CHECKPOINT_ALARM_NAME, {
          delayInMinutes: TIMEOUTS.CHECKPOINT / 60000,
        });
      }
    }
  }

  private clearTimers(): void {
    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.stopCheckpointTimer();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CORE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async startRecording(
    mode: 'tab' | 'window' | 'screen',
    includeMic: boolean,
    includeSystemAudio: boolean,
    bestQuality = false
  ): Promise<{ ok: boolean; error?: string; overlayInjected?: boolean }> {
    if (this.startInProgress) {
      return { ok: false, error: 'Cannot start: initialization already in progress' };
    }

    // Claim the start slot before any cleanup or restore awaits. This also
    // serializes retries issued while a failed startup is being torn down.
    this.startInProgress = true;
    try {
      let currentState = this.actor.getSnapshot().value;
      if (currentState === 'failed') {
        // A failed startup has no live state-machine session, but its recorder
        // context may still be around while the error message is being handled.
        // Close that context before accepting a retry. cleanup only tears down
        // browser resources; it deliberately leaves any partial DB data intact.
        // The failed transition clears the persisted session through the
        // serialized state-change queue. Wait for that clear before consulting
        // storage below, otherwise a retry can mistake its own stale snapshot
        // for a live session during this same turn.
        await this.settleStateChanges();
        currentState = this.actor.getSnapshot().value;
      }
      if (currentState !== 'idle' && currentState !== 'failed') {
        return { ok: false, error: `Cannot start: invalid state ${currentState}` };
      }

      // A service-worker restart loses the in-memory machine. If a live capture
      // from a previous session still exists (offscreen document / recorder tab),
      // reclaim it instead of silently starting a second recording on top.
      const restored = await this.restoreSession();
      const postRestoreState = this.actor.getSnapshot().value;
      if (restored || postRestoreState === 'recording' || postRestoreState === 'stopping') {
        return { ok: false, error: 'A recording is already in progress' };
      }
      // A concurrent GET_STATE/heartbeat may have restored the snapshot while
      // this START was waiting in restoreSession(). Do not pass that false
      // return through to initializeRecording: START is ignored in recording,
      // which would otherwise make the initializer send a second start to the
      // live capture context.
      if (postRestoreState !== 'idle' && postRestoreState !== 'failed') {
        return { ok: false, error: `Cannot start: invalid state ${postRestoreState}` };
      }
      return await this.initializeRecording(mode, includeMic, includeSystemAudio, bestQuality);
    } finally {
      this.startInProgress = false;
    }
  }

  private async initializeRecording(
    mode: 'tab' | 'window' | 'screen',
    includeMic: boolean,
    includeSystemAudio: boolean,
    bestQuality: boolean
  ): Promise<{ ok: boolean; error?: string; overlayInjected?: boolean }> {
    const initialState = this.actor.getSnapshot().value;
    if (initialState !== 'idle' && initialState !== 'failed') {
      return {
        ok: false,
        error:
          initialState === 'recording' || initialState === 'stopping'
            ? 'A recording is already in progress'
            : `Cannot start: invalid state ${initialState}`,
      };
    }

    // Check storage quota
    const quotaCheck = await checkStorageQuota();
    if (!quotaCheck.ok) {
      return { ok: false, error: quotaCheck.error };
    }

    const stateBeforeTabQuery = this.actor.getSnapshot().value;
    if (stateBeforeTabQuery !== 'idle' && stateBeforeTabQuery !== 'failed') {
      return {
        ok: false,
        error:
          stateBeforeTabQuery === 'recording' || stateBeforeTabQuery === 'stopping'
            ? 'A recording is already in progress'
            : `Cannot start: invalid state ${stateBeforeTabQuery}`,
      };
    }

    // Get active tab for overlay
    const [activeTab] = await this.chrome.tabs.query({ active: true, currentWindow: true });
    // An error can arrive during quota/tab lookups. Complete its queued
    // teardown before a retry creates browser resources or a new snapshot.
    // Check the queue and send START in the same continuation. An extra async
    // helper return would allow teardown to be queued between the final drain
    // check and START, then close resources belonging to the new session.
    let pendingStateChanges: Promise<void>;
    do {
      pendingStateChanges = this.stateChangeQueue;
      await pendingStateChanges;
    } while (pendingStateChanges !== this.stateChangeQueue);

    // Liveness wakeups can complete while the active-tab query is pending. Do
    // the ownership check immediately before START, before mutating overlay
    // fields or sending an event that the active machine would ignore.
    const stateBeforeStart = this.actor.getSnapshot().value;
    if (stateBeforeStart !== 'idle' && stateBeforeStart !== 'failed') {
      return {
        ok: false,
        error:
          stateBeforeStart === 'recording' || stateBeforeStart === 'stopping'
            ? 'A recording is already in progress'
            : `Cannot start: invalid state ${stateBeforeStart}`,
      };
    }
    this.overlayTabId = activeTab?.id ?? null;

    // Send START event to machine
    this.actor.send({
      type: 'START',
      mode,
      mic: includeMic,
      systemAudio: includeSystemAudio,
      bestQuality,
      strategy: this.chrome.capabilities?.offscreen === false ? 'page' : undefined,
    });
    this.actor.send({ type: 'SET_OVERLAY_TAB_ID', tabId: this.overlayTabId });

    const context = this.actor.getSnapshot().context;
    if (!context.recordingId) {
      this.actor.send({ type: 'RESET' });
      return { ok: false, error: 'Failed to initialize recording session' };
    }
    const recordingId = context.recordingId;

    // Claim the durable owner before creating an overlay, tab, or offscreen
    // document. A second worker can then protect this session while this
    // startup is still waiting on browser APIs, and a stale worker's cleanup
    // cannot close the new owner's offscreen document.
    const owner = await withResourceLock(() =>
      this.claimDurableOwner(
        recordingId,
        context.strategy,
        context.recorderTabId ?? null,
        context.overlayTabId ?? null
      )
    );
    if (
      !owner ||
      !this.actor.getSnapshot().matches('starting') ||
      this.actor.getSnapshot().context.recordingId !== recordingId
    ) {
      if (this.actor.getSnapshot().matches('starting')) this.actor.send({ type: 'RESET' });
      return {
        ok: false,
        error: owner
          ? 'Recording start was cancelled during initialization'
          : 'A recording is already in progress',
      };
    }
    this.sessionGeneration = owner.generation;

    const attempt: StartupAttempt = {
      recordingId: context.recordingId,
      generation: owner.generation,
      strategy: context.strategy,
      cancelled: false,
      recorderTabId: null,
      offscreenStartRequested: false,
    };
    this.startupAttempt = attempt;

    // Inject overlay
    let overlayInjected = false;
    if (this.overlayTabId != null) {
      overlayInjected = await this.injectOverlay(this.overlayTabId);
    }

    if (!this.isCurrentStartup(attempt)) {
      this.clearTimers();
      await this.cleanup();
      await this.settleStateChanges();
      return { ok: false, error: 'Recording start was cancelled during initialization' };
    }

    try {
      if (context.strategy === 'offscreen') {
        await this.ensureOffscreenDocument(
          mode,
          includeSystemAudio,
          bestQuality,
          context.recordingId,
          this.overlayTabId,
          attempt
        );
      } else {
        await this.openRecorderTab(
          mode,
          includeMic,
          includeSystemAudio,
          bestQuality,
          context.recordingId,
          attempt
        );
      }
    } catch (e) {
      const cancelled = e instanceof StartupCancelledError || !this.isCurrentStartup(attempt);
      const stopOwnsSession =
        !attempt.cancelled &&
        this.actor.getSnapshot().matches('stopping') &&
        this.actor.getSnapshot().context.recordingId === attempt.recordingId;
      // The acknowledgement may have moved the machine to recording before
      // the final tab/document lookup settled. A normal STOP then owns the
      // stopping context; do not let this stale initializer close the page
      // before its RECORDER_DATA/OFFSCREEN_DATA response arrives.
      if (stopOwnsSession) {
        if (this.startupAttempt === attempt) this.startupAttempt = null;
        return { ok: false, error: 'Recording start was cancelled during initialization' };
      }
      this.clearTimers();
      if (!cancelled && this.actor.getSnapshot().matches('starting')) {
        this.retireRecording(attempt.recordingId);
        this.actor.send({ type: 'RESET' });
      }
      await this.cleanup();
      await this.settleStateChanges();
      if (this.startupAttempt === attempt) this.startupAttempt = null;
      return {
        ok: false,
        error: cancelled
          ? 'Recording start was cancelled during initialization'
          : e instanceof Error
          ? e.message
          : String(e),
      };
    }

    const startedSnapshot = this.actor.getSnapshot();
    const isSameSession = startedSnapshot.context.recordingId === context.recordingId;
    const isActiveStart =
      startedSnapshot.matches('starting') || startedSnapshot.matches('recording');

    if (!isSameSession || !isActiveStart) {
      // An acknowledgement can move the machine to recording before this
      // initializer's final await settles. If the user then issued a normal
      // STOP, leave the stop→data flow in charge of the live context instead
      // of closing it here.
      if (isSameSession && startedSnapshot.matches('stopping') && !attempt.cancelled) {
        if (this.startupAttempt === attempt) this.startupAttempt = null;
        return { ok: false, error: 'Recording start was cancelled during initialization' };
      }
      this.clearTimers();
      await this.cleanup();
      await this.settleStateChanges();
      if (this.startupAttempt === attempt) this.startupAttempt = null;
      return { ok: false, error: 'Recording start was cancelled during initialization' };
    }

    // Only arm confirmation while an acknowledgment is still pending.
    if (startedSnapshot.matches('starting')) {
      this.confirmationTimeout = setTimeout(() => {
        this.actor.send({ type: 'CONFIRMATION_TIMEOUT' });
      }, TIMEOUTS.CONFIRMATION);
    }

    // Start checkpoint timer
    this.startCheckpointTimer();

    // The resources are now fully owned by the service fields and the machine;
    // future STOP requests can tear them down from the normal starting path.
    if (this.startupAttempt === attempt) this.startupAttempt = null;

    return { ok: true, overlayInjected };
  }

  async stopRecording(): Promise<{ ok: boolean; error?: string }> {
    let state = this.actor.getSnapshot().value;

    // A worker wakeup starts with a fresh idle machine while the capture page
    // or offscreen document can still be alive. Reclaim that session before
    // deciding that STOP has nothing to act on.
    if (state === 'idle') {
      await this.restoreSession();
      state = this.actor.getSnapshot().value;
    }

    // The machine handles STOP from `starting` (cancels start) and idempotently
    // from `stopping`. Only reject when there's nothing to stop.
    if (state !== 'recording' && state !== 'starting' && state !== 'stopping') {
      return { ok: false, error: `Cannot stop: invalid state ${state}` };
    }

    // If user cancels during `starting`, just return to idle and skip the
    // save-timeout / outbound stop messages (there's nothing recording yet).
    if (state === 'starting') {
      const attempt = this.startupAttempt;
      this.invalidateStartup(this.actor.getSnapshot().context.recordingId ?? undefined);
      await this.cancelStartup(attempt);
      if (this.startupAttempt === attempt) this.startupAttempt = null;
      return { ok: true };
    }

    // Idempotent stop while already stopping.
    if (state === 'stopping') {
      return { ok: true };
    }

    // state === 'recording' — proceed with normal stop flow.
    this.actor.send({ type: 'STOP' });

    // Set save timeout. Kept as setTimeout (not an alarm): the stop→data message
    // traffic keeps the SW alive through this short window, and the alarm-based
    // periodic reconcile is the backstop for a hung `stopping`.
    this.saveTimeout = setTimeout(() => {
      this.actor.send({ type: 'SAVE_TIMEOUT' });
    }, TIMEOUTS.SAVE);

    try {
      await this.sendStopCommand(this.actor.getSnapshot().context.strategy);
    } catch (e) {
      this.actor.send({ type: 'SAVE_TIMEOUT' });
      await this.clearActiveSessionArtifacts();
      await this.cleanup();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Best-effort overlay removal
    if (this.overlayTabId) {
      try {
        await this.chrome.tabs.sendMessage(this.overlayTabId, buildMessage(MSG_OVERLAY_REMOVE));
      } catch (e) {
        // Non-critical
      }
      await this.removeOverlay(this.overlayTabId);
      this.actor.send({ type: 'SET_OVERLAY_TAB_ID', tabId: null });
    }

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLERS (called by message handler)
  // ═══════════════════════════════════════════════════════════════════════════

  handleOffscreenStarted(recordingId: string): boolean {
    const snapshot = this.actor.getSnapshot();
    const isExpectedAcknowledgment =
      isValidUUID(recordingId) &&
      !this.retiredRecordingIds.has(recordingId) &&
      snapshot.matches('starting') &&
      snapshot.context.recordingId === recordingId &&
      snapshot.context.strategy === 'offscreen';

    if (!isExpectedAcknowledgment) {
      console.warn('[RecordingService] Ignoring stale OFFSCREEN_STARTED:', recordingId);
      return false;
    }

    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    this.actor.send({ type: 'OFFSCREEN_STARTED', recordingId });
    return true;
  }

  handleRecorderStarted(recordingId: string): boolean {
    const snapshot = this.actor.getSnapshot();
    const isExpectedAcknowledgment =
      isValidUUID(recordingId) &&
      !this.retiredRecordingIds.has(recordingId) &&
      snapshot.matches('starting') &&
      snapshot.context.recordingId === recordingId &&
      snapshot.context.strategy === 'page';

    if (!isExpectedAcknowledgment) {
      console.warn('[RecordingService] Ignoring stale RECORDER_STARTED:', recordingId);
      return false;
    }

    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    this.actor.send({ type: 'RECORDER_STARTED', recordingId });

    // Focus original tab only after accepting the acknowledgment.
    if (this.overlayTabId) {
      void this.focusTab(this.overlayTabId);
    }
    return true;
  }

  async handleOffscreenData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }
    if (!this.isCurrentRecording(recordingId)) {
      // The SW may have restarted mid-recording. Reclaim the live session from
      // the persisted snapshot before deciding this data is truly stale.
      await this.restoreSession();
      if (!this.isCurrentRecording(recordingId)) {
        console.warn(
          '[RecordingService] Ignoring OFFSCREEN_DATA for non-active recording:',
          recordingId
        );
        return;
      }
    }

    this.clearTimers();

    this.retireRecording(recordingId);
    this.actor.send({ type: 'OFFSCREEN_DATA', recordingId, mimeType });
    await this.clearActiveSessionArtifacts();
    await this.cleanup(recordingId);

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });
  }

  async handleRecorderData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }
    if (!this.isCurrentRecording(recordingId)) {
      // Same restart-recovery path as handleOffscreenData.
      await this.restoreSession();
      if (!this.isCurrentRecording(recordingId)) {
        console.warn(
          '[RecordingService] Ignoring RECORDER_DATA for non-active recording:',
          recordingId
        );
        return;
      }
    }

    this.clearTimers();

    this.retireRecording(recordingId);
    this.actor.send({ type: 'RECORDER_DATA', recordingId, mimeType });
    await this.clearActiveSessionArtifacts();
    await this.cleanup(recordingId);

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });
  }

  async handleOffscreenError(
    error: string | StructuredError,
    code?: string,
    recordingId?: string
  ): Promise<void> {
    this.invalidateStartup(recordingId);
    if (recordingId && !this.isCurrentRecording(recordingId)) {
      await this.restoreSession();
      if (recordingId && !this.isCurrentRecording(recordingId)) {
        console.warn(
          '[RecordingService] Ignoring OFFSCREEN_ERROR for non-active recording:',
          recordingId
        );
        return;
      }
    }
    this.clearTimers();
    this.retireRecording(this.actor.getSnapshot().context.recordingId);
    this.actor.send({
      type: 'OFFSCREEN_ERROR',
      error: toErrorText(error),
      code: code || undefined,
    });
    await this.clearActiveSessionArtifacts();
  }

  async handleRecorderError(error: string | StructuredError, recordingId?: string): Promise<void> {
    this.invalidateStartup(recordingId);
    if (recordingId && !this.isCurrentRecording(recordingId)) {
      await this.restoreSession();
      if (recordingId && !this.isCurrentRecording(recordingId)) {
        console.warn(
          '[RecordingService] Ignoring RECORDER_ERROR for non-active recording:',
          recordingId
        );
        return;
      }
    }
    this.clearTimers();
    this.retireRecording(this.actor.getSnapshot().context.recordingId);
    this.actor.send({ type: 'RECORDER_ERROR', error: toErrorText(error) });
    await this.clearActiveSessionArtifacts();
  }

  async handleTabClosing(tabId: number): Promise<boolean> {
    const snapshot = this.actor.getSnapshot();
    const state = snapshot.value;
    const ownsOverlayTab = tabId === this.overlayTabId;
    const ownsRecorderTab = tabId === this.recorderTabId;
    const isActiveState = state === 'starting' || state === 'recording';

    if (!isActiveState || (!ownsOverlayTab && !ownsRecorderTab)) {
      return false;
    }

    if (state === 'starting') {
      this.invalidateStartup(snapshot.context.recordingId ?? undefined);
    }
    this.clearTimers();
    this.retireRecording(snapshot.context.recordingId);
    this.actor.send({ type: 'TAB_CLOSING', tabId });

    // Do not attempt to remove the tab Chrome has already reported as closed.
    if (ownsOverlayTab) {
      this.overlayTabId = null;
      this.actor.send({ type: 'SET_OVERLAY_TAB_ID', tabId: null });
    }
    if (ownsRecorderTab) {
      this.recorderTabId = null;
      this.actor.send({ type: 'SET_RECORDER_TAB_ID', tabId: null });
    }

    await this.cleanup();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERY HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  async handleRecoveryDiscard(recordingId: string): Promise<boolean> {
    const snapshot = this.actor.getSnapshot();
    const state = snapshot.value;
    const isDiscardableState = state === 'failed' || state === 'recoverable';
    const isCurrentSession =
      isValidUUID(recordingId) && snapshot.context.recordingId === recordingId;

    if (!isDiscardableState || !isCurrentSession) {
      console.warn('[RecordingService] Ignoring stale RECOVERY_DISCARD:', recordingId);
      return false;
    }

    this.clearTimers();
    this.retireRecording(recordingId);
    this.actor.send({ type: 'RECOVERY_DISCARD', recordingId });
    await this.cleanup();
    await this.settleStateChanges();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSION RESTORE & HEARTBEAT
  //
  // MV3 terminates the service worker after ~30s of inactivity, which destroys
  // the in-memory XState machine mid-recording. The offscreen/recorder context
  // keeps capturing independently and saves chunks to IndexedDB, so the capture
  // survives — only the SW's tracking dies. Two mechanisms repair that:
  //   1. The capture context heartbeats every ~20s (under the 30s suspension
  //      floor), keeping the SW awake so its machine never restarts.
  //   2. If a restart still happens, restoreSession() reclaims the live session
  //      from the persisted snapshot so late OFFSCREEN_DATA/ERROR/STOP messages
  //      are accepted instead of silently dropped.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reclaim a still-live recording session after a service-worker restart.
   * Verifies the capture is actually alive (offscreen document present, or the
   * recorder tab still open for the same recordingId) before restoring the
   * machine to `recording`.
   *
   * @returns true when an active session is being tracked (either it never
   *          stopped, or it was successfully restored from the snapshot).
   */
  async restoreSession(): Promise<boolean> {
    const machine = this.actor.getSnapshot();
    if (machine.matches('recording') || machine.matches('stopping')) {
      return true;
    }

    // Only a fresh idle machine can consume a persisted session. A live
    // starting/failed/recoverable transition belongs to the current lifecycle
    // and must not be overwritten by a stale snapshot or wakeup.
    if (!machine.matches('idle')) {
      return false;
    }

    let persistedState: PersistedSessionState;
    try {
      persistedState = await this.readPersistedSessionState();
    } catch (e) {
      console.warn('[RecordingService] Failed to read persisted session state for restore:', e);
      return false;
    }

    const durableOwner = await this.readDurableOwner();
    if (durableOwner === undefined) return false;
    const persisted = this.selectPersistedSnapshot(persistedState, durableOwner);
    // A crash or failed browser close can leave only the durable retirement.
    // Keep retrying cleanup even after the Chrome storage marker was removed.
    if (
      durableOwner?.status === 'retired' &&
      !persistedState.retirements.some((entry) => entry.recordingId === durableOwner.recordingId)
    ) {
      persistedState.retirements.push(durableOwner);
    }
    const retiredIds = new Set(
      persistedState.retirements.map((retirement) => retirement.recordingId)
    );

    // Retirement is independent of the live snapshot. Process every marker,
    // including marker-only state left after the old snapshot was removed.
    // When another active snapshot exists, resource-aware cleanup protects its
    // offscreen document and shared overlay while still removing an orphaned
    // recorder tab belonging to the retired ID.
    for (const retirement of persistedState.retirements) {
      await this.cleanupRetiredSession(
        retirement,
        persisted?.recordingId === retirement.recordingId ? undefined : persisted
      );
    }

    if (!this.actor.getSnapshot().matches('idle')) {
      return (
        this.actor.getSnapshot().matches('recording') ||
        this.actor.getSnapshot().matches('stopping')
      );
    }

    if (!persisted) {
      // The owner claim is committed before the first browser resource is
      // created. If the worker dies in that short window there is no snapshot
      // to restore, so retire the owner only after proving that no capture
      // context exists. The same resource lock used by startup prevents this
      // check from racing a still-running creator in another worker.
      if (durableOwner?.status === 'active') {
        await withResourceLock(async () => {
          const owner = await this.readDurableOwner();
          if (!owner || owner.status !== 'active') return;
          const live = await this.hasLiveOwnerContext(owner);
          if (!live) {
            await this.retireDurableOwner(
              owner.recordingId,
              owner.strategy,
              owner.recorderTabId,
              owner.overlayTabId
            );
          }
        });
      }
      return false;
    }
    if (retiredIds.has(persisted.recordingId)) return false;
    if (!LIVE_SESSION_STATUSES.has(persisted.status)) return false;
    if (persisted.strategy !== 'offscreen' && persisted.strategy !== 'page') return false;

    // Reserve the persisted owner before awaiting tabs/offscreen liveness. A
    // concurrent START in another worker must observe this reservation and
    // wait for retirement instead of creating a second capture context.
    if (!this.actor.getSnapshot().matches('idle')) return false;
    const claimedOwner = await this.claimDurableOwner(
      persisted.recordingId,
      persisted.strategy,
      persisted.recorderTabId ?? null,
      persisted.overlayTabId ?? null,
      persisted
    );
    if (!claimedOwner) return false;
    if (!this.actor.getSnapshot().matches('idle')) return false;

    let restoredRecorderTabId: number | null = null;
    if (persisted.strategy === 'offscreen') {
      let docAlive: boolean | null = null;
      try {
        docAlive = await this.chrome.offscreen.hasDocument();
      } catch (e) {
        console.warn('[RecordingService] Offscreen liveness check failed:', e);
        // An unavailable liveness check cannot prove that the owner is orphaned.
        // Keep the snapshot and durable owner for a later wakeup.
        return false;
      }
      if (!docAlive) {
        await this.retireDurableOwner(
          persisted.recordingId,
          persisted.strategy,
          persisted.recorderTabId ?? null,
          persisted.overlayTabId ?? null
        );
        await this.clearSessionSnapshot(persisted.recordingId);
        return false;
      }
    } else if (persisted.strategy === 'page') {
      let recorderTabId: number | null;
      try {
        recorderTabId = await this.findRecorderTabId(
          persisted.recordingId,
          persisted.recorderTabId,
          true
        );
      } catch (e) {
        console.warn('[RecordingService] Recorder-tab liveness check failed:', e);
        return false;
      }
      if (recorderTabId == null) {
        await this.retireDurableOwner(
          persisted.recordingId,
          persisted.strategy,
          persisted.recorderTabId ?? null,
          persisted.overlayTabId ?? null
        );
        await this.clearSessionSnapshot(persisted.recordingId);
        return false;
      }
      restoredRecorderTabId = recorderTabId;
    } else {
      return false;
    }

    // A cancellation may have committed while the browser liveness lookup
    // was pending. Re-read all retirement keys before accepting RESTORE.
    let latestState: PersistedSessionState;
    try {
      latestState = await this.readPersistedSessionState();
    } catch (e) {
      console.warn('[RecordingService] Failed to recheck persisted session state:', e);
      return false;
    }
    const retirement = latestState.retirements.find(
      (candidate) => candidate.recordingId === persisted.recordingId
    );
    const latestOwner = await this.readDurableOwner();
    if (retirement || latestOwner?.status === 'retired') {
      if (retirement) await this.cleanupRetiredSession(retirement);
      return false;
    }
    if (
      !latestOwner ||
      latestOwner.status !== 'active' ||
      latestOwner.recordingId !== persisted.recordingId ||
      (persisted.generation != null && persisted.generation !== latestOwner.generation)
    ) {
      return false;
    }

    // START/STOP/GET_STATE can race this liveness query. Do not let a late
    // restore replace a newly-created session.
    if (
      !this.actor.getSnapshot().matches('idle') ||
      this.retiredRecordingIds.has(persisted.recordingId)
    ) {
      return false;
    }

    this.actor.send({ type: 'RESTORE', snapshot: persisted });
    if (
      !(
        this.actor.getSnapshot().matches('recording') ||
        this.actor.getSnapshot().matches('starting')
      ) ||
      this.actor.getSnapshot().context.recordingId !== persisted.recordingId
    ) {
      return false;
    }
    // RESTORE carries the recorder tab ID into the recording context in the
    // same synchronous transition. Assign the service field only after the
    // final idle ownership check above, so a late page lookup cannot mutate a
    // newer startup while the machine is still idle.
    if (restoredRecorderTabId != null) {
      this.recorderTabId = restoredRecorderTabId;
    }
    this.overlayTabId = persisted.overlayTabId ?? null;
    this.startCheckpointTimer();
    return true;
  }

  /**
   * Handle a keepalive heartbeat from the capture context (offscreen document
   * or recorder tab) while a recording is active. Each delivery wakes the
   * service worker and resets its 30s idle suspension timer; on a post-restart
   * SW the heartbeat also triggers session restore.
   */
  async handleHeartbeat(recordingId: string): Promise<{ ok: boolean; error?: string }> {
    if (!isValidUUID(recordingId)) {
      return { ok: false, error: 'Invalid recording ID' };
    }

    if (!this.isCurrentRecording(recordingId)) {
      const restored = await this.restoreSession();
      if (!restored && !this.isCurrentRecording(recordingId)) {
        return { ok: false, error: 'Heartbeat for unknown session' };
      }
    }

    if (this.actor.getSnapshot().matches('recording')) {
      // Refresh lastActivityAt and keep the checkpoint alarm armed as a
      // backstop if the heartbeat stream ever stalls.
      this.actor.send({ type: 'UPDATE_STATE', status: 'recording' });
      this.startCheckpointTimer();
      // Re-arm the duration badge after a potential service-worker restart and
      // refresh it immediately (no waiting for the next 1s tick).
      this.startBadgeTimer();
      await this.updateBadge('recording');
    }
    return { ok: true };
  }

  private async findRecorderTabId(
    recordingId: string,
    persistedTabId?: number | null,
    failClosedOnQueryError = false
  ): Promise<number | null> {
    if (this.chrome.runtime.findRecorderTabIds) {
      try {
        const ids = await this.chrome.runtime.findRecorderTabIds(recordingId);
        return persistedTabId != null && ids.includes(persistedTabId)
          ? persistedTabId
          : ids[0] ?? null;
      } catch (error) {
        if (failClosedOnQueryError) throw error;
        return null;
      }
    }
    // Extension pages do not receive tab URLs without the broad `tabs`
    // permission. Persisting the owned tab ID lets a worker restart reclaim a
    // recorder page using the narrower tab access already granted here.
    if (persistedTabId != null) {
      try {
        const tab = await this.chrome.tabs.get(persistedTabId);
        if (tab) return persistedTabId;
      } catch {
        // Fall through to URL matching for older snapshots or a stale ID.
      }
    }

    try {
      const tabs = await this.chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        try {
          const parsed = new URL(tab.url);
          if (
            parsed.pathname.endsWith('/recorder.html') &&
            parsed.searchParams.get('id') === recordingId
          ) {
            return tab.id ?? null;
          }
        } catch {
          // Malformed URL — not our recorder tab.
        }
      }
    } catch (e) {
      console.warn('[RecordingService] Failed to locate recorder tab:', e);
      if (failClosedOnQueryError) throw e;
    }
    return null;
  }

  private async hasLiveOwnerContext(owner: SessionOwner): Promise<boolean> {
    if (owner.strategy === 'offscreen') {
      try {
        return await this.chrome.offscreen.hasDocument();
      } catch (e) {
        console.warn('[RecordingService] Failed to inspect owner offscreen document:', e);
        return true;
      }
    }
    if (owner.strategy === 'page') {
      try {
        return (await this.findRecorderTabId(owner.recordingId, owner.recorderTabId, true)) != null;
      } catch (e) {
        console.warn('[RecordingService] Failed to inspect owner recorder tab:', e);
        // Keep an active owner when the browser query is unavailable; another
        // worker may still be creating or using the recorder page.
        return true;
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERY
  // ═══════════════════════════════════════════════════════════════════════════

  getState() {
    const snapshot = this.actor.getSnapshot();
    const context = snapshot.context;

    return {
      status: snapshot.value,
      recordingId: context.recordingId,
      correlationId: context.correlationId,
      error: context.error,
      startedAt: context.startedAt,
      lastActivityAt: context.lastActivityAt,
      options: { ...context.options },
      strategy: context.strategy,
      recording:
        snapshot.matches('starting') ||
        snapshot.matches('recording') ||
        snapshot.matches('stopping'),
    };
  }

  reset(): void {
    this.retireRecording(this.actor.getSnapshot().context.recordingId);
    this.invalidateStartup(this.actor.getSnapshot().context.recordingId ?? undefined);
    this.clearTimers();
    this.actor.send({ type: 'RESET' });
    this.actor.send({ type: 'SET_OVERLAY_TAB_ID', tabId: null });
    this.actor.send({ type: 'SET_RECORDER_TAB_ID', tabId: null });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private async focusTab(tabId: number): Promise<void> {
    try {
      const tab = await this.chrome.tabs.get(tabId);
      if (tab?.windowId) {
        await this.chrome.windows.update(tab.windowId, { focused: true });
      }
      await this.chrome.tabs.update(tabId, { active: true });
    } catch (e) {
      console.warn('[RecordingService] Tab focus failed:', e);
    }
  }

  private async sendStopCommand(strategy: RecordingContext['strategy']): Promise<void> {
    if (strategy === 'offscreen') {
      await this.chrome.runtime.sendMessage(buildMessage(MSG_OFFSCREEN_STOP));
      return;
    }
    if (strategy === 'page' && this.recorderTabId) {
      await this.chrome.tabs.sendMessage(this.recorderTabId, buildMessage(MSG_RECORDER_STOP));
      return;
    }
    throw new Error('Recorder tab is not available');
  }

  private isCurrentRecording(recordingId: string): boolean {
    const snapshot = this.actor.getSnapshot();
    return (
      (snapshot.matches('starting') ||
        snapshot.matches('recording') ||
        snapshot.matches('stopping') ||
        snapshot.matches('recoverable')) &&
      snapshot.context.recordingId === recordingId
    );
  }

  private retireRecording(recordingId: string | null): Promise<void> {
    if (!recordingId) return Promise.resolve();
    const existingWrite = this.retirementWrites.get(recordingId);
    if (existingWrite) return existingWrite;
    this.retiredRecordingIds.add(recordingId);
    const context = this.actor.getSnapshot().context;
    if (context.recordingId !== recordingId) return Promise.resolve();

    // This per-recording key is intentionally outside sessionStorageQueue: a
    // suspended live write must not delay durable cancellation, and a later
    // worker's snapshot cannot overwrite this marker.
    const retirement = Promise.all([
      this.chrome.storage.set({
        [sessionRetirementStorageKey(recordingId)]: {
          recordingId,
          strategy: context.strategy,
          recorderTabId: context.recorderTabId,
          overlayTabId: context.overlayTabId,
        } satisfies SessionRetirement,
      }),
      this.retireDurableOwner(
        recordingId,
        context.strategy,
        context.recorderTabId ?? null,
        context.overlayTabId ?? null
      ),
    ])
      .then(() => undefined)
      .catch((e) => {
        console.warn('[RecordingService] Failed to persist session retirement:', e);
      });
    this.retirementWrites.set(recordingId, retirement);

    return retirement;
  }

  private async cleanupRetiredSession(
    retirement: SessionRetirement,
    protectedSnapshot?: SessionSnapshot
  ): Promise<void> {
    await withResourceLock(async () => {
      if (!this.actor.getSnapshot().matches('idle')) return;
      this.retiredRecordingIds.add(retirement.recordingId);

      const pendingRetirement = this.retirementWrites.get(retirement.recordingId);
      if (pendingRetirement) await pendingRetirement;

      // The metadata transaction is the durable fence that survives a worker
      // restart. If another worker has already claimed a different recording,
      // this marker is still safe to clean, but that owner's browser resources
      // must be protected below.
      const ownerBeforeRetire = await this.readDurableOwner();
      if (ownerBeforeRetire === undefined) return;
      await this.retireDurableOwner(
        retirement.recordingId,
        retirement.strategy,
        retirement.recorderTabId,
        retirement.overlayTabId
      );
      const durableOwner = await this.readDurableOwner();
      if (durableOwner === undefined) return;

      const protectsOverlay =
        protectedSnapshot?.recordingId !== retirement.recordingId &&
        protectedSnapshot?.overlayTabId != null &&
        protectedSnapshot.overlayTabId === retirement.overlayTabId;
      const protectsRecorderTab =
        protectedSnapshot?.recordingId !== retirement.recordingId &&
        protectedSnapshot?.recorderTabId != null &&
        protectedSnapshot.recorderTabId === retirement.recorderTabId;
      const protectsOffscreen =
        protectedSnapshot?.recordingId !== retirement.recordingId &&
        protectedSnapshot?.strategy === 'offscreen' &&
        retirement.strategy === 'offscreen';
      const protectsDurableOwnerOverlay =
        durableOwner?.status === 'active' &&
        durableOwner.recordingId !== retirement.recordingId &&
        durableOwner.overlayTabId != null &&
        durableOwner.overlayTabId === retirement.overlayTabId;
      const protectsDurableOwnerRecorder =
        durableOwner?.status === 'active' &&
        durableOwner.recordingId !== retirement.recordingId &&
        durableOwner.recorderTabId != null &&
        durableOwner.recorderTabId === retirement.recorderTabId;
      const protectsDurableOwnerOffscreen =
        durableOwner?.status === 'active' &&
        durableOwner.recordingId !== retirement.recordingId &&
        durableOwner.strategy === 'offscreen' &&
        retirement.strategy === 'offscreen';

      // A newer live worker can claim the machine while browser cleanup awaits a
      // Chrome call. Recheck ownership before each destructive operation.
      if (!this.actor.getSnapshot().matches('idle')) return;
      if (retirement.overlayTabId != null && !protectsOverlay && !protectsDurableOwnerOverlay) {
        await this.removeOverlay(retirement.overlayTabId);
        if (!this.actor.getSnapshot().matches('idle')) return;
      }

      if (
        retirement.strategy === 'page' &&
        retirement.recorderTabId != null &&
        !protectsRecorderTab &&
        !protectsDurableOwnerRecorder
      ) {
        try {
          const ownedTab = await this.findRecorderTabId(
            retirement.recordingId,
            retirement.recorderTabId,
            true
          );
          if (ownedTab === retirement.recorderTabId) await this.chrome.tabs.remove(ownedTab);
        } catch (e) {
          console.warn('[RecordingService] Retired recorder tab cleanup failed:', e);
          return;
        }
        if (!this.actor.getSnapshot().matches('idle')) return;
      }

      if (
        retirement.strategy === 'offscreen' &&
        !protectsOffscreen &&
        !protectsDurableOwnerOffscreen
      ) {
        try {
          const existing = await this.chrome.offscreen.hasDocument();
          if (existing && this.actor.getSnapshot().matches('idle')) {
            await this.chrome.offscreen.closeDocument();
          }
        } catch (e) {
          console.warn('[RecordingService] Retired offscreen cleanup failed:', e);
          return;
        }
        if (!this.actor.getSnapshot().matches('idle')) return;
      }

      if (this.recorderTabId === retirement.recorderTabId) this.recorderTabId = null;
      if (this.overlayTabId === retirement.overlayTabId) this.overlayTabId = null;

      // Only remove isolated metadata. The legacy singleton remains readable for
      // older extension pages. The durable owner fence prevents a delayed old
      // worker write from becoming restorable after this marker is removed.
      const ownerBeforeMetadataCleanup = await this.readDurableOwner();
      if (
        ownerBeforeMetadataCleanup === undefined ||
        (ownerBeforeMetadataCleanup?.status === 'active' &&
          ownerBeforeMetadataCleanup.recordingId === retirement.recordingId)
      ) {
        return;
      }
      await this.queueSessionStorage(async () => {
        await this.chrome.storage.remove(sessionSnapshotStorageKey(retirement.recordingId));
        await this.chrome.storage.remove(sessionRetirementStorageKey(retirement.recordingId));
      });
    });
  }

  private cleanup(
    recordingId: string | null = this.actor.getSnapshot().context.recordingId ??
      this.lastSessionRecordingId
  ): Promise<void> {
    // Cleanup shares the startup/state-transition barrier. If a newer session
    // already owns the machine, this delayed caller has no resources to close.
    const cleanup = this.stateChangeQueue.then(async () => {
      const current = this.actor.getSnapshot();
      if (current.context.recordingId !== recordingId && !current.matches('idle')) return;
      await this.cleanupResources(recordingId);
      if (recordingId) await this.finishRetirement(recordingId);
    });
    this.stateChangeQueue = cleanup.catch((e) => {
      console.warn('[RecordingService] Cleanup failed:', e);
    });
    return cleanup;
  }

  /**
   * Remove isolated terminal metadata only after browser resources have been
   * reclaimed. The durable owner record remains as the bounded fence that
   * rejects a late write from a suspended worker after this removal.
   */
  private async finishRetirement(recordingId: string): Promise<void> {
    const pendingRetirement = this.retirementWrites.get(recordingId);
    if (pendingRetirement) await pendingRetirement;
    const owner = await this.readDurableOwner();
    if (!owner || owner.recordingId !== recordingId || owner.status === 'active') return;
    // Browser API failures are logged by cleanupResources. Retain its marker
    // until absence is confirmed so the next wakeup can retry failed cleanup.
    if ((await this.hasLiveOwnerContext(owner)) !== false) return;
    await this.queueSessionStorage(async () => {
      await this.chrome.storage.remove(sessionSnapshotStorageKey(recordingId));
      await this.chrome.storage.remove(sessionRetirementStorageKey(recordingId));
    });
  }

  // Called directly only from a task that already owns stateChangeQueue.
  private async cleanupResources(recordingId = this.lastSessionRecordingId): Promise<void> {
    await withResourceLock(async () => {
      const overlayTabId = this.overlayTabId;
      const recorderTabId = this.recorderTabId;

      const ownerProtects = async (
        resource: 'overlay' | 'recorder' | 'offscreen',
        id?: number | null
      ): Promise<boolean> => {
        const owner = await this.readDurableOwner();
        if (owner === undefined) return true;
        if (!owner || owner.status !== 'active' || owner.recordingId === recordingId) return false;
        if (resource === 'offscreen') return owner.strategy === 'offscreen';
        return resource === 'overlay'
          ? owner.overlayTabId != null && owner.overlayTabId === id
          : owner.recorderTabId != null && owner.recorderTabId === id;
      };

      // Remove overlay
      if (overlayTabId && !(await ownerProtects('overlay', overlayTabId))) {
        await this.removeOverlay(overlayTabId);
        if (this.overlayTabId === overlayTabId) {
          this.actor.send({ type: 'SET_OVERLAY_TAB_ID', tabId: null });
          this.overlayTabId = null;
        }
      }

      // Close recorder tab without letting a stale/missing tab abort later cleanup.
      if (recorderTabId != null && !(await ownerProtects('recorder', recorderTabId))) {
        try {
          const ownedTab = recordingId
            ? await this.findRecorderTabId(recordingId, recorderTabId, true)
            : null;
          if (ownedTab === recorderTabId) await this.chrome.tabs.remove(ownedTab);
        } catch (e) {
          console.warn('[RecordingService] Recorder tab cleanup failed:', e);
        } finally {
          if (this.recorderTabId === recorderTabId) {
            this.actor.send({ type: 'SET_RECORDER_TAB_ID', tabId: null });
            this.recorderTabId = null;
          }
        }
      }

      // Close offscreen document
      try {
        const existing = await this.chrome.offscreen.hasDocument();
        if (existing && !(await ownerProtects('offscreen'))) {
          await this.chrome.offscreen.closeDocument();
        }
      } catch (e) {
        console.warn('[RecordingService] Offscreen cleanup failed:', e);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  async handleMessage(
    message: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sender: { id?: string }
  ): Promise<{ ok: boolean; error?: string | null } | null> {
    // Sender validation, schema validation, and rate limiting are performed
    // in src/background.ts before this is called. Do not duplicate them here.

    // Route to appropriate handler
    switch (message.type) {
      case 'START':
        return await this.startRecording(
          message.mode as 'tab' | 'window' | 'screen',
          message.mic as boolean,
          message.systemAudio as boolean,
          message.bestQuality === true
        );

      case 'STOP':
        return await this.stopRecording();

      case 'OFFSCREEN_STARTED':
        if (
          this.actor.getSnapshot().matches('idle') &&
          !this.retiredRecordingIds.has(message.recordingId as string)
        )
          await this.restoreSession();
        return this.handleOffscreenStarted(message.recordingId as string)
          ? { ok: true }
          : { ok: false, error: 'Stale OFFSCREEN_STARTED acknowledgment' };

      case 'RECORDER_STARTED':
        if (
          this.actor.getSnapshot().matches('idle') &&
          !this.retiredRecordingIds.has(message.recordingId as string)
        )
          await this.restoreSession();
        return this.handleRecorderStarted(message.recordingId as string)
          ? { ok: true }
          : { ok: false, error: 'Stale RECORDER_STARTED acknowledgment' };

      case 'OFFSCREEN_DATA':
        await this.handleOffscreenData(message.recordingId as string, message.mimeType as string);
        return { ok: true };

      case 'RECORDER_DATA':
        await this.handleRecorderData(message.recordingId as string, message.mimeType as string);
        return { ok: true };

      case 'OFFSCREEN_ERROR':
        await this.handleOffscreenError(
          message.error as string | StructuredError,
          message.code as string | undefined,
          message.recordingId as string | undefined
        );
        return { ok: true };

      case 'RECORDER_ERROR':
        await this.handleRecorderError(
          message.error as string | StructuredError,
          message.recordingId as string | undefined
        );
        return { ok: true };

      case 'GET_STATE':
        await this.restoreSession();
        return { ok: true, ...this.getState() };

      case 'TAB_CLOSING':
        await this.handleTabClosing(message.tabId as number);
        return { ok: true };

      case 'PREVIEW_READY':
        // Preview is ready - no state change needed
        return { ok: true };

      case MSG_RECOVERY_DISCARD:
        return (await this.handleRecoveryDiscard(message.recordingId as string))
          ? { ok: true }
          : { ok: false, error: 'Stale or invalid recovery discard' };

      case MSG_HEARTBEAT:
        return await this.handleHeartbeat(message.recordingId as string);

      // These are messages the background itself broadcasts via
      // chrome.runtime.sendMessage to other extension contexts (offscreen
      // document, recorder tab). The background's own onMessage listener
      // also receives them; treat as no-ops here.
      case 'OFFSCREEN_START':
      case 'OFFSCREEN_STOP':
      case 'RECORDER_STOP':
      case 'OFFSCREEN_TEST':
        return { ok: true };

      default:
        return { ok: false, error: 'Unhandled message type' };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

let service: RecordingService | null = null;

export function createRecordingService(chrome: ChromeAPI): RecordingService {
  if (service) {
    return service;
  }
  service = new RecordingService(chrome);
  return service;
}

export function getRecordingService(): RecordingService | null {
  return service;
}

/**
 * Reset the module-level singleton. Tests only — never call from production
 * code. Background.ts treats the service as a global; resetting between
 * `createRecordingService` calls in production would discard state.
 */
export function __resetRecordingServiceForTests(): void {
  service = null;
}
