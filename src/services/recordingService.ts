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
import { validateMessageStrict, schemas, MSG_RECOVERY_RESUME, MSG_RECOVERY_DISCARD } from '../messages.js';
import { checkStorageQuota } from '../../storage-utils.js';
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
    query: (query: { active?: boolean; currentWindow?: boolean }) => Promise<Array<{ id?: number; windowId?: number }>>;
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
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════

const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 50;

function checkRateLimit(senderId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(senderId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(senderId, { count: 1, windowStart: now });
    return true;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    console.warn(`[RecordingService] Rate limit exceeded for sender: ${senderId}`);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDING SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export class RecordingService {
  private chrome: ChromeAPI;
  private actor: ReturnType<typeof createActor<typeof recordingMachine>>;
  private confirmationTimeout: ReturnType<typeof setTimeout> | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;
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

  private async onStateChange(snapshot: { value: string; context: RecordingContext }): Promise<void> {
    const state = snapshot.value as string;
    const context = snapshot.context;

    // Badge management
    await this.updateBadge(state);

    // Session persistence based on state
    if (state === 'recording' || state === 'stopping') {
      await this.persistSessionSnapshot(context);
    } else if (state === 'idle' || state === 'saved') {
      await this.clearSessionSnapshot();
    }

    // Overlay injection/removal on state transitions
    if (state === 'recording' && context.overlayTabId && !context.overlayInjected) {
      await this.injectOverlay(context.overlayTabId);
    } else if (state === 'idle' && this.overlayTabId) {
      await this.removeOverlay(this.overlayTabId);
      this.overlayTabId = null;
    }

    // Offscreen document lifecycle
    if (state === 'idle') {
      await this.closeOffscreenDocumentIfIdle();
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
    try {
      const snapshot = {
        recordingId: context.recordingId,
        status: this.actor.getSnapshot().value,
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

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERLAY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private async injectOverlay(tabId: number): Promise<boolean> {
    try {
      await this.chrome.scripting.executeScript({
        target: { tabId },
        files: ['overlay.js'],
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

  private async ensureOffscreenDocument(mode: string, includeSystemAudio: boolean, recordingId: string, targetTabId: number | null): Promise<void> {
    try {
      const existing = await this.chrome.offscreen.hasDocument();
      if (existing) return;

      await this.chrome.offscreen.createDocument({
        url: this.chrome.runtime.getURL('offscreen.html'),
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.',
      });

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

    // Inject overlay
    let overlayInjected = false;
    if (this.overlayTabId) {
      overlayInjected = await this.injectOverlay(this.overlayTabId);
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

    if (state !== 'recording') {
      return { ok: false, error: `Cannot stop: invalid state ${state}` };
    }

    // Send STOP event
    this.actor.send({ type: 'STOP' });

    // Set save timeout
    this.saveTimeout = setTimeout(() => {
      this.actor.send({ type: 'SAVE_TIMEOUT' });
    }, TIMEOUTS.SAVE);

    // Send stop message to offscreen/recorder
    const context = this.actor.getSnapshot().context;
    if (context.strategy === 'offscreen') {
      await this.chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    } else {
      await this.chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
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
    const context = this.actor.getSnapshot().context;
    if (context.overlayTabId) {
      this.focusTab(context.overlayTabId);
    }
  }

  async handleOffscreenData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }

    this.clearTimers();

    this.actor.send({ type: 'OFFSCREEN_DATA', recordingId, mimeType });

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

    this.clearTimers();

    this.actor.send({ type: 'RECORDER_DATA', recordingId, mimeType });

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });

    // Clean up
    await this.cleanup();
  }

  handleOffscreenError(error: string, code?: string): void {
    this.clearTimers();
    this.actor.send({ type: 'OFFSCREEN_ERROR', error, code: code || undefined });
  }

  handleRecorderError(error: string): void {
    this.clearTimers();
    this.actor.send({ type: 'RECORDER_ERROR', error });
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
      recording: context.strategy !== null && context.strategy !== undefined,
    };
  }

  reset(): void {
    this.clearTimers();
    this.actor.send({ type: 'RESET' });
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
    sender: { id: string }
  ): Promise<{ ok: boolean; error?: string } | null> {
    // Validate sender
    if (sender.id !== this.chrome.runtime.id) {
      console.warn('[RecordingService] Unauthorized message sender');
      return { ok: false, error: 'Unauthorized sender' };
    }

    // Rate limiting
    if (!checkRateLimit(sender.id)) {
      return { ok: false, error: 'Rate limited' };
    }

    // Validate message against schema
    const schema = schemas[message.type as keyof typeof schemas];
    if (!schema) {
      console.warn('[RecordingService] Unknown message type:', message.type);
      return { ok: false, error: 'Unknown message type' };
    }

    const validation = validateMessageStrict(message as any, schema);
    if (!validation.valid) {
      console.warn('[RecordingService] Validation failed:', validation.errors);
      return { ok: false, error: `Validation failed: ${validation.errors.join(', ')}` };
    }

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
        await this.handleOffscreenData(
          message.recordingId as string,
          message.mimeType as string
        );
        return { ok: true };

      case 'RECORDER_DATA':
        await this.handleRecorderData(
          message.recordingId as string,
          message.mimeType as string
        );
        return { ok: true };

      case 'OFFSCREEN_ERROR':
        this.handleOffscreenError(
          message.error as string,
          message.code as string | undefined
        );
        return { ok: true };

      case 'RECORDER_ERROR':
        this.handleRecorderError(message.error as string);
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