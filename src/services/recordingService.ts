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
import {
  TIMEOUTS,
  STORAGE_KEYS,
  isValidUUID,
  RecordingStatus,
  type StructuredErrorPayload,
} from '../machines/types.js';

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
    update: (tabId: number, options: { active: boolean }) => Promise<unknown>;
    get: (tabId: number) => Promise<{ windowId: number }>;
    sendMessage: (tabId: number, message: Record<string, unknown>) => Promise<void>;
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
    update: (windowId: number, options: { focused: boolean }) => Promise<unknown>;
  };
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
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;
  private overlayTabId: number | null = null;
  private recorderTabId: number | null = null;
  private readonly expectedClosedTabs = new Set<number>();
  private stateEffectQueue: Promise<void> = Promise.resolve();
  private stateEffectSequence = 0;

  private static readonly SESSION_SNAPSHOT_KEY = STORAGE_KEYS.SESSION_SNAPSHOT;

  constructor(chrome: ChromeAPI) {
    this.chrome = chrome;

    // Create XState actor
    this.actor = createActor(recordingMachine);

    // Subscribe to state changes for side effects (badge, persistence, overlay)
    this.actor.subscribe((snapshot) => {
      this.enqueueStateTransition(snapshot);
    });

    this.actor.start();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE CHANGE HANDLER (Chrome API side effects)
  // ═══════════════════════════════════════════════════════════════════════════

  private enqueueStateTransition(snapshot: { value: string; context: RecordingContext }): void {
    const effectId = ++this.stateEffectSequence;
    const payload = {
      id: effectId,
      state: snapshot.value,
      context: { ...snapshot.context },
      overlayTabId: this.overlayTabId,
    };

    this.stateEffectQueue = this.stateEffectQueue
      .then(() => this.applyStateTransitionEffects(payload))
      .catch((error) => {
        console.error('[RecordingService] Failed to process serialized state effects:', {
          effectId,
          state: payload.state,
          recordingId: payload.context.recordingId,
          error,
        });
      });
  }

  public async drainStateEffects(): Promise<void> {
    await this.stateEffectQueue;
  }

  private async applyStateTransitionEffects(snapshot: {
    id: number;
    state: string;
    context: RecordingContext;
    overlayTabId: number | null;
  }): Promise<void> {
    const { state, context, overlayTabId } = snapshot;

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
      await this.clearSessionSnapshot(context.recordingId);
    }

    // Overlay removal on transition back to idle.
    // (Injection is driven explicitly from startRecording, not from state changes,
    // since overlayTabId is owned by the service instance, not the machine context.)
    if (state === 'idle' && overlayTabId) {
      await this.removeOverlayIfCurrentRecording(overlayTabId, context.recordingId);
      if (this.overlayTabId === overlayTabId) {
        this.overlayTabId = null;
      }
    }

    // Offscreen document lifecycle
    if (state === 'idle') {
      await this.closeOffscreenDocumentIfIdle(context.recordingId);
    } else if (state === 'recoverable') {
      await this.cleanup(context.recordingId);
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
      current.context.recordingId !== context.recordingId ||
      !(current.matches('recording') || current.matches('stopping'))
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
      await this.chrome.storage.set({ [RecordingService.SESSION_SNAPSHOT_KEY]: snapshot });
    } catch (e) {
      console.warn('[RecordingService] Failed to persist session snapshot:', e);
    }
  }

  private async clearSessionSnapshot(recordingId: string | null): Promise<void> {
    const current = this.actor.getSnapshot();
    if (current.context.recordingId !== recordingId) {
      return;
    }

    try {
      await this.chrome.storage.remove(RecordingService.SESSION_SNAPSHOT_KEY);
    } catch (e) {
      console.warn('[RecordingService] Failed to clear session snapshot:', e);
    }
  }

  private async removeOverlayIfCurrentRecording(
    tabId: number,
    expectedRecordingId: string | null
  ): Promise<void> {
    const current = this.actor.getSnapshot();
    if (current.context.recordingId !== expectedRecordingId) {
      return;
    }

    await this.removeOverlay(tabId);
  }

  private async clearActiveSessionArtifacts(): Promise<void> {
    await this.clearSessionSnapshot(this.actor.getSnapshot().context.recordingId);
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

  private async closeOffscreenDocumentIfIdle(expectedRecordingId: string | null): Promise<void> {
    const current = this.actor.getSnapshot();
    if (current.context.recordingId !== expectedRecordingId || !current.matches('idle')) {
      return;
    }

    try {
      const existing = await this.chrome.offscreen.hasDocument();
      if (existing) {
        await this.chrome.offscreen.closeDocument();
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
    this.checkpointInterval = setInterval(async () => {
      const state = this.actor.getSnapshot().value;
      if (state === 'recording' || state === 'stopping') {
        const context = this.actor.getSnapshot().context;
        if (context.recordingId) {
          await this.persistSessionSnapshot(context);
        }
      }
    }, TIMEOUTS.CHECKPOINT);
  }

  private stopCheckpointTimer(): void {
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = null;
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

  async handleOffscreenError(
    error: unknown,
    code?: string,
    recordingId?: string
  ): Promise<boolean> {
    if (!recordingId) {
      console.error('[RecordingService] Ignoring malformed OFFSCREEN_ERROR: missing recordingId');
      return false;
    }

    const normalized = this.normalizeErrorPayload(error);
    if (!normalized) {
      console.error('[RecordingService] Ignoring malformed OFFSCREEN_ERROR payload:', error);
      return false;
    }

    if (recordingId && !this.isCurrentRecording(recordingId)) {
      console.warn(
        '[RecordingService] Ignoring OFFSCREEN_ERROR for non-active recording:',
        recordingId
      );
      return true;
    }
    this.clearTimers();
    this.actor.send({
      type: 'OFFSCREEN_ERROR',
      recordingId: recordingId as string,
      error: normalized,
      code: code || normalized.code,
    });
    await this.clearActiveSessionArtifacts();
    await this.cleanup();

    return true;
  }

  async handleRecorderError(error: unknown, recordingId?: string): Promise<boolean> {
    if (!recordingId) {
      console.error('[RecordingService] Ignoring malformed RECORDER_ERROR: missing recordingId');
      return false;
    }

    const normalized = this.normalizeErrorPayload(error);
    if (!normalized) {
      console.error('[RecordingService] Ignoring malformed RECORDER_ERROR payload:', error);
      return false;
    }

    if (recordingId && !this.isCurrentRecording(recordingId)) {
      console.warn(
        '[RecordingService] Ignoring RECORDER_ERROR for non-active recording:',
        recordingId
      );
      return true;
    }
    this.clearTimers();
    this.actor.send({
      type: 'RECORDER_ERROR',
      recordingId: recordingId as string,
      error: normalized,
      code: normalized.code,
    });
    await this.clearActiveSessionArtifacts();
    await this.cleanup();

    return true;
  }

  private normalizeErrorPayload(error: unknown): StructuredErrorPayload | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const candidate = error as Record<string, unknown>;
    const code = candidate.code;
    const userMessage = candidate.userMessage;

    if (typeof code !== 'string' || typeof userMessage !== 'string') {
      return null;
    }

    return {
      ok: candidate.ok === false || candidate.ok === true ? (candidate.ok as boolean) : false,
      code,
      userMessage,
      technicalMessage:
        typeof candidate.technicalMessage === 'string'
          ? (candidate.technicalMessage as string)
          : '',
      retryable:
        typeof candidate.retryable === 'boolean' ? (candidate.retryable as boolean) : undefined,
      correlationId:
        typeof candidate.correlationId === 'string' || candidate.correlationId === null
          ? (candidate.correlationId as string | null)
          : undefined,
      ...candidate,
    };
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
    status: RecordingStatus;
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

  private async cleanup(
    expectedRecordingId: string | null = this.actor.getSnapshot().context.recordingId
  ): Promise<void> {
    const current = this.actor.getSnapshot();
    if (current.context.recordingId !== expectedRecordingId) {
      return;
    }

    // Remove overlay
    if (this.overlayTabId) {
      await this.removeOverlay(this.overlayTabId);
      this.overlayTabId = null;
    }

    // Close recorder tab
    if (this.recorderTabId) {
      const recorderTabId = this.recorderTabId;
      this.expectedClosedTabs.add(recorderTabId);
      try {
        await this.chrome.tabs.remove(recorderTabId);
      } catch (e) {
        console.warn('[RecordingService] Recorder tab removal failed:', e);
        this.expectedClosedTabs.delete(recorderTabId);
      }
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
    _sender?: { id?: string }
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
        if (
          !(await this.handleOffscreenError(
            message.error,
            message.code as string | undefined,
            message.recordingId as string | undefined
          ))
        ) {
          return { ok: false, error: 'Malformed OFFSCREEN_ERROR payload' };
        }
        return { ok: true };

      case 'RECORDER_ERROR':
        if (
          !(await this.handleRecorderError(
            message.error,
            message.recordingId as string | undefined
          ))
        ) {
          return { ok: false, error: 'Malformed RECORDER_ERROR payload' };
        }
        return { ok: true };

      case 'GET_STATE':
        return { ok: true, ...this.getState() };

      case 'TAB_CLOSING':
        await this.handleTabClosing(message.tabId as number);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // TAB CLOSE FILTERING
  // ═══════════════════════════════════════════════════════════════════════════

  private consumeExpectedClosedTab(tabId: number): boolean {
    return this.expectedClosedTabs.delete(tabId);
  }

  async handleTabClosing(tabId: number): Promise<void> {
    if (!tabId || this.consumeExpectedClosedTab(tabId)) {
      return;
    }

    // Only treat these as terminal failures while actively recording.
    const state = this.actor.getSnapshot().value;
    if (state !== 'recording') {
      return;
    }

    if (this.overlayTabId === tabId) {
      this.clearTimers();
      this.actor.send({ type: 'OVERLAY_TAB_CLOSED' });
      await this.cleanup();
      return;
    }

    if (this.recorderTabId === tabId) {
      this.clearTimers();
      this.actor.send({ type: 'RECORDER_TAB_CLOSED' });
      await this.cleanup();
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
