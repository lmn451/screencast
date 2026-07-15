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
import { recordingMachine, type RecordingContext } from '../machines/recordingMachine.js';
import { MSG_RECOVERY_RESUME, MSG_RECOVERY_DISCARD } from '../messages.js';
import { checkStorageQuota } from '../lib/storage-utils.js';
import { TIMEOUTS, STORAGE_KEYS, isValidUUID } from '../machines/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ChromeAPI {
  storage: {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (data: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  tabs: {
    query: (query: {
      active?: boolean;
      currentWindow?: boolean;
    }) => Promise<Array<{ id?: number; windowId?: number }>>;
    create: (options: { url: string; active?: boolean }) => Promise<{ id?: number }>;
    remove: (tabId: number) => Promise<void>;
    update: (tabId: number, options: { active: boolean }) => Promise<void>;
    get: (tabId: number) => Promise<{ windowId: number }>;
    sendMessage: (tabId: number, message: Record<string, unknown>) => Promise<void>;
  };
  scripting: {
    executeScript: (options: { target: { tabId: number }; files: string[] }) => Promise<void>;
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
 * Name of the self-rescheduling checkpoint alarm. Shared with background.ts,
 * which owns the chrome.alarms.onAlarm listener and dispatches to
 * RecordingService.handleCheckpointAlarm.
 */
export const CHECKPOINT_ALARM_NAME = 'capturecast-checkpoint';

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

  constructor(chrome: ChromeAPI) {
    this.chrome = chrome;

    // Create XState actor
    this.actor = createActor(recordingMachine);

    // Subscribe to state changes for side effects (badge, persistence, overlay)
    this.actor.subscribe((snapshot) => {
      this.onStateChange(snapshot);
    });

    this.actor.start();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE CHANGE HANDLER (Chrome API side effects)
  // ═══════════════════════════════════════════════════════════════════════════

  private async onStateChange(snapshot: {
    value: string;
    context: RecordingContext;
  }): Promise<void> {
    const state = snapshot.value;
    const context = snapshot.context;

    // Badge management
    await this.updateBadge(state);

    // Session persistence based on state
    if (state === 'recording' || state === 'stopping') {
      await this.persistSessionSnapshot(context);
    } else if (
      state === 'idle' ||
      state === 'saved' ||
      state === 'failed' ||
      state === 'recoverable'
    ) {
      await this.clearSessionSnapshot();
    }

    // Overlay removal on transition back to idle.
    // (Injection is driven explicitly from startRecording, not from state changes,
    // since overlayTabId is owned by the service instance, not the machine context.)
    if (state === 'idle' && this.overlayTabId) {
      await this.removeOverlay(this.overlayTabId);
      this.overlayTabId = null;
    }

    // Offscreen document lifecycle
    if (state === 'idle') {
      await this.closeOffscreenDocumentIfIdle();
    } else if (state === 'recoverable') {
      await this.cleanup();
    }
  }

  private async updateBadge(state: string): Promise<void> {
    try {
      let color = '#00000000';
      let text = '';

      if (state === 'recording') {
        color = '#d93025';
        text = 'REC';
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

  private async persistSessionSnapshot(context: RecordingContext): Promise<void> {
    if (!context.recordingId) return;
    const current = this.actor.getSnapshot();
    if (
      !(current.matches('recording') || current.matches('stopping')) ||
      current.context.recordingId !== context.recordingId
    ) {
      return;
    }

    try {
      const snapshot = {
        recordingId: context.recordingId,
        status: current.value,
        startedAt: context.startedAt,
        lastActivityAt: Date.now(),
        options: { ...context.options },
        strategy: context.strategy,
        correlationId: context.correlationId,
      };
      await this.chrome.storage.set({ [STORAGE_KEYS.SESSION_SNAPSHOT]: snapshot });
    } catch (e) {
      console.warn('[RecordingService] Failed to persist session snapshot:', e);
    }
  }

  private async clearSessionSnapshot(): Promise<void> {
    try {
      await this.chrome.storage.remove(STORAGE_KEYS.SESSION_SNAPSHOT);
    } catch (e) {
      console.warn('[RecordingService] Failed to clear session snapshot:', e);
    }
  }

  private async clearActiveSessionArtifacts(): Promise<void> {
    await this.clearSessionSnapshot();
    await this.updateBadge('idle');
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
    mode: string,
    includeSystemAudio: boolean,
    recordingId: string,
    targetTabId: number | null
  ): Promise<void> {
    try {
      const existing = await this.chrome.offscreen.hasDocument();
      if (!existing) {
        await this.chrome.offscreen.createDocument({
          url: this.chrome.runtime.getURL('offscreen.html'),
          reasons: ['USER_MEDIA', 'BLOBS'],
          justification:
            'Record a screen capture stream using MediaRecorder in an offscreen document.',
        });
      }

      // Send start message to offscreen
      await this.chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        mode,
        includeAudio: includeSystemAudio,
        recordingId,
        targetTabId,
      });
    } catch (e) {
      console.error('[RecordingService] Failed to create offscreen document:', e);
      throw e;
    }
  }

  private async openRecorderTab(
    mode: 'tab' | 'window' | 'screen',
    includeMic: boolean,
    includeSystemAudio: boolean,
    recordingId: string
  ): Promise<void> {
    const params = new URLSearchParams({
      id: recordingId,
      mode,
      mic: includeMic ? '1' : '0',
      sys: includeSystemAudio ? '1' : '0',
    });
    const tab = await this.chrome.tabs.create({
      url: this.chrome.runtime.getURL(`recorder.html?${params.toString()}`),
      active: true,
    });
    this.recorderTabId = tab.id ?? null;
  }

  private async closeOffscreenDocumentIfIdle(): Promise<void> {
    try {
      const existing = await this.chrome.offscreen.hasDocument();
      if (existing) {
        const state = this.actor.getSnapshot().value;
        if (state === 'idle') {
          await this.chrome.offscreen.closeDocument();
        }
      }
    } catch (e) {
      console.warn('[RecordingService] Failed to close offscreen document:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private startCheckpointTimer(): void {
    this.stopCheckpointTimer();
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
    const snapshot = this.actor.getSnapshot();
    const state = snapshot.value;
    if (state === 'recording' || state === 'stopping') {
      if (snapshot.context.recordingId) {
        await this.persistSessionSnapshot(snapshot.context);
      }
      // Re-arm for the next checkpoint.
      this.chrome.alarms?.create(CHECKPOINT_ALARM_NAME, {
        delayInMinutes: TIMEOUTS.CHECKPOINT / 60000,
      });
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
    includeSystemAudio: boolean
  ): Promise<{ ok: boolean; error?: string; overlayInjected?: boolean }> {
    const currentState = this.actor.getSnapshot().value;
    if (currentState !== 'idle') {
      return { ok: false, error: `Cannot start: invalid state ${currentState}` };
    }

    // Check storage quota
    const quotaCheck = await checkStorageQuota();
    if (!quotaCheck.ok) {
      return { ok: false, error: quotaCheck.error };
    }

    // Get active tab for overlay
    const [activeTab] = await this.chrome.tabs.query({ active: true, currentWindow: true });
    this.overlayTabId = activeTab?.id ?? null;

    // Send START event to machine
    this.actor.send({
      type: 'START',
      mode,
      mic: includeMic,
      systemAudio: includeSystemAudio,
    });

    const context = this.actor.getSnapshot().context;
    if (!context.recordingId) {
      this.actor.send({ type: 'RESET' });
      return { ok: false, error: 'Failed to initialize recording session' };
    }

    // Inject overlay
    let overlayInjected = false;
    if (this.overlayTabId) {
      overlayInjected = await this.injectOverlay(this.overlayTabId);
    }

    try {
      if (context.strategy === 'offscreen') {
        await this.ensureOffscreenDocument(
          mode,
          includeSystemAudio,
          context.recordingId,
          this.overlayTabId
        );
      } else {
        await this.openRecorderTab(mode, includeMic, includeSystemAudio, context.recordingId);
      }
    } catch (e) {
      this.actor.send({ type: 'RESET' });
      this.clearTimers();
      if (this.overlayTabId) {
        await this.removeOverlay(this.overlayTabId);
        this.overlayTabId = null;
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Set confirmation timeout
    this.confirmationTimeout = setTimeout(() => {
      this.actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    }, TIMEOUTS.CONFIRMATION);

    // Start checkpoint timer
    this.startCheckpointTimer();

    return { ok: true, overlayInjected };
  }

  async stopRecording(): Promise<{ ok: boolean; error?: string }> {
    const state = this.actor.getSnapshot().value;

    // The machine handles STOP from `starting` (cancels start) and idempotently
    // from `stopping`. Only reject when there's nothing to stop.
    if (state !== 'recording' && state !== 'starting' && state !== 'stopping') {
      return { ok: false, error: `Cannot stop: invalid state ${state}` };
    }

    // If user cancels during `starting`, just return to idle and skip the
    // save-timeout / outbound stop messages (there's nothing recording yet).
    if (state === 'starting') {
      this.actor.send({ type: 'STOP' });
      this.clearTimers();
      if (this.overlayTabId) {
        try {
          await this.chrome.tabs.sendMessage(this.overlayTabId, { type: 'OVERLAY_REMOVE' });
        } catch (e) {
          // Non-critical
        }
        await this.removeOverlay(this.overlayTabId);
        this.overlayTabId = null;
      }
      return { ok: true };
    }

    // Idempotent stop while already stopping.
    if (state === 'stopping') {
      return { ok: true };
    }

    // state === 'recording' — proceed with normal stop flow.
    this.actor.send({ type: 'STOP' });

    // Set save timeout
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
        await this.chrome.tabs.sendMessage(this.overlayTabId, { type: 'OVERLAY_REMOVE' });
      } catch (e) {
        // Non-critical
      }
      await this.removeOverlay(this.overlayTabId);
    }

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLERS (called by message handler)
  // ═══════════════════════════════════════════════════════════════════════════

  handleOffscreenStarted(): void {
    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    this.actor.send({ type: 'OFFSCREEN_STARTED' });
  }

  handleRecorderStarted(): void {
    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    this.actor.send({ type: 'RECORDER_STARTED' });

    // Focus original tab
    if (this.overlayTabId) {
      this.focusTab(this.overlayTabId);
    }
  }

  async handleOffscreenData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }
    if (!this.isCurrentRecording(recordingId)) {
      console.warn(
        '[RecordingService] Ignoring OFFSCREEN_DATA for non-active recording:',
        recordingId
      );
      return;
    }

    this.clearTimers();

    this.actor.send({ type: 'OFFSCREEN_DATA', recordingId, mimeType });
    await this.clearActiveSessionArtifacts();

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });

    // Clean up
    await this.cleanup();
  }

  async handleRecorderData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }
    if (!this.isCurrentRecording(recordingId)) {
      console.warn(
        '[RecordingService] Ignoring RECORDER_DATA for non-active recording:',
        recordingId
      );
      return;
    }

    this.clearTimers();

    this.actor.send({ type: 'RECORDER_DATA', recordingId, mimeType });
    await this.clearActiveSessionArtifacts();

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });

    // Clean up
    await this.cleanup();
  }

  async handleOffscreenError(error: string, code?: string, recordingId?: string): Promise<void> {
    if (recordingId && !this.isCurrentRecording(recordingId)) {
      console.warn(
        '[RecordingService] Ignoring OFFSCREEN_ERROR for non-active recording:',
        recordingId
      );
      return;
    }
    this.clearTimers();
    this.actor.send({ type: 'OFFSCREEN_ERROR', error, code: code || undefined });
    await this.clearActiveSessionArtifacts();
    await this.cleanup();
  }

  async handleRecorderError(error: string, recordingId?: string): Promise<void> {
    if (recordingId && !this.isCurrentRecording(recordingId)) {
      console.warn(
        '[RecordingService] Ignoring RECORDER_ERROR for non-active recording:',
        recordingId
      );
      return;
    }
    this.clearTimers();
    this.actor.send({ type: 'RECORDER_ERROR', error });
    await this.clearActiveSessionArtifacts();
    await this.cleanup();
  }

  handleTabClosing(tabId: number): void {
    this.actor.send({ type: 'TAB_CLOSING', tabId });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERY HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  async handleRecoveryDiscard(recordingId: string): Promise<void> {
    this.clearTimers();
    this.actor.send({ type: 'RECOVERY_DISCARD', recordingId });
    await this.cleanup();
  }

  async handleRecoveryResume(recordingId: string): Promise<void> {
    this.actor.send({ type: 'RECOVERY_RESUME', recordingId });
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
    this.clearTimers();
    this.actor.send({ type: 'RESET' });
  }

  /**
   * Re-hydrate the state machine from a persisted session snapshot, e.g. when
   * the service worker restarts mid-recording. The machine transitions
   * idle → recording with the snapshot's recordingId/strategy/options/etc.
   */
  reconcile(snapshot: {
    recordingId: string;
    status: string;
    startedAt: number;
    lastActivityAt: number;
    options: {
      mode: 'tab' | 'window' | 'screen' | null;
      includeMic: boolean;
      includeSystemAudio: boolean;
    };
    strategy: 'offscreen' | 'page' | null;
    correlationId: string;
  }): void {
    if (this.actor.getSnapshot().value !== 'idle') {
      return; // already running; don't clobber
    }
    this.actor.send({ type: 'RECONCILE', snapshot });
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
      await this.chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
      return;
    }
    if (strategy === 'page' && this.recorderTabId) {
      await this.chrome.tabs.sendMessage(this.recorderTabId, { type: 'RECORDER_STOP' });
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

  private async cleanup(): Promise<void> {
    // Remove overlay
    if (this.overlayTabId) {
      await this.removeOverlay(this.overlayTabId);
      this.overlayTabId = null;
    }

    // Close recorder tab
    if (this.recorderTabId) {
      await this.chrome.tabs.remove(this.recorderTabId);
      this.recorderTabId = null;
    }

    // Close offscreen document
    try {
      const existing = await this.chrome.offscreen.hasDocument();
      if (existing) {
        await this.chrome.offscreen.closeDocument();
      }
    } catch (e) {
      console.warn('[RecordingService] Offscreen cleanup failed:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  async handleMessage(
    message: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _sender: { id: string }
  ): Promise<{ ok: boolean; error?: string } | null> {
    // Sender validation, schema validation, and rate limiting are performed
    // in src/background.ts before this is called. Do not duplicate them here.

    // Route to appropriate handler
    switch (message.type) {
      case 'START':
        return await this.startRecording(
          message.mode as 'tab' | 'window' | 'screen',
          message.mic as boolean,
          message.systemAudio as boolean
        );

      case 'STOP':
        return await this.stopRecording();

      case 'OFFSCREEN_STARTED':
        this.handleOffscreenStarted();
        return { ok: true };

      case 'RECORDER_STARTED':
        this.handleRecorderStarted();
        return { ok: true };

      case 'OFFSCREEN_DATA':
        await this.handleOffscreenData(message.recordingId as string, message.mimeType as string);
        return { ok: true };

      case 'RECORDER_DATA':
        await this.handleRecorderData(message.recordingId as string, message.mimeType as string);
        return { ok: true };

      case 'OFFSCREEN_ERROR':
        await this.handleOffscreenError(
          message.error as string,
          message.code as string | undefined,
          message.recordingId as string | undefined
        );
        return { ok: true };

      case 'RECORDER_ERROR':
        await this.handleRecorderError(
          message.error as string,
          message.recordingId as string | undefined
        );
        return { ok: true };

      case 'GET_STATE':
        return { ok: true, ...this.getState() };

      case 'TAB_CLOSING':
        this.handleTabClosing(message.tabId as number);
        return { ok: true };

      case 'PREVIEW_READY':
        // Preview is ready - no state change needed
        return { ok: true };

      case MSG_RECOVERY_RESUME:
        await this.handleRecoveryResume(message.recordingId as string);
        return { ok: true };

      case MSG_RECOVERY_DISCARD:
        await this.handleRecoveryDiscard(message.recordingId as string);
        return { ok: true };

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
