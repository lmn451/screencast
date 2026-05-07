/**
 * Recording Service
 * 
 * Bridges XState machine with Chrome APIs.
 * This service handles all Chrome-specific operations and
 * translates them to machine events.
 * 
 * Phase: Implementation
 */

import {
  createRecordingManager,
  getRecordingManager,
  type RecordingEvent,
  type RecordingContext,
} from '../machines/recordingMachine';
import { setChromeApi } from '../machines/recordingMachine';
import { validateMessageStrict, schemas } from '../messages';
import { checkStorageQuota } from './storage-utils';
import { TIMEOUTS } from '../machines/types';

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API WRAPPER
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
    console.warn(`[RateLimit] Exceeded for sender: ${senderId}`);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UUID VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDING SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export class RecordingService {
  private chrome: ChromeAPI;
  private manager: ReturnType<typeof createRecordingManager>;
  private confirmationTimeout: ReturnType<typeof setTimeout> | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;

  constructor(chrome: ChromeAPI) {
    this.chrome = chrome;
    
    // Initialize XState machine with Chrome API
    setChromeApi(chrome);
    this.manager = createRecordingManager();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CORE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start a new recording
   */
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

    // Send START event to machine
    this.manager.send({
      type: 'START',
      mode,
      mic: includeMic,
      systemAudio: includeSystemAudio,
    });

    const context = this.manager.getSnapshot().context;

    // Inject overlay on active tab
    let overlayInjected = false;
    const [activeTab] = await this.chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      overlayInjected = await this.injectOverlay(activeTab.id);
      this.manager.send({
        type: 'UPDATE_STATE',
        status: 'recording',
      });
    }

    // Set confirmation timeout
    this.confirmationTimeout = setTimeout(() => {
      this.manager.send({ type: 'CONFIRMATION_TIMEOUT' });
    }, TIMEOUTS.CONFIRMATION);

    // Start checkpoint interval
    this.startCheckpointTimer();

    return { ok: true, overlayInjected };
  }

  /**
   * Stop the current recording
   */
  async stopRecording(): Promise<{ ok: boolean; error?: string }> {
    const state = this.manager.getSnapshot().value;
    
    if (state !== 'recording') {
      return { ok: false, error: `Cannot stop: invalid state ${state}` };
    }

    // Send STOP event
    this.manager.send({ type: 'STOP' });

    // Set save timeout
    this.saveTimeout = setTimeout(() => {
      this.manager.send({ type: 'SAVE_TIMEOUT' });
    }, TIMEOUTS.SAVE);

    // Send stop message to offscreen/recorder
    const context = this.manager.getSnapshot().context;
    if (context.strategy === 'offscreen') {
      await this.chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    } else {
      await this.chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
    }

    return { ok: true };
  }

  /**
   * Handle message from offscreen/recorder confirming start
   */
  async handleOffscreenStarted(): Promise<void> {
    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    this.manager.send({ type: 'OFFSCREEN_STARTED' });
  }

  /**
   * Handle message from recorder tab confirming start
   */
  async handleRecorderStarted(): Promise<void> {
    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    this.manager.send({ type: 'RECORDER_STARTED' });
  }

  /**
   * Handle recording data from offscreen
   */
  async handleOffscreenData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    this.manager.send({ type: 'OFFSCREEN_DATA', recordingId, mimeType });

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });

    // Clean up
    this.cleanup();
  }

  /**
   * Handle recording data from recorder tab
   */
  async handleRecorderData(recordingId: string, mimeType: string): Promise<void> {
    if (!isValidUUID(recordingId)) {
      console.error('[RecordingService] Invalid recording ID:', recordingId);
      return;
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    this.manager.send({ type: 'RECORDER_DATA', recordingId, mimeType });

    // Open preview page
    const url = this.chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
    await this.chrome.tabs.create({ url });

    // Clean up
    this.cleanup();
  }

  /**
   * Handle error from offscreen
   */
  handleOffscreenError(error: string): void {
    this.manager.send({ type: 'OFFSCREEN_ERROR', error });
    this.cleanup();
  }

  /**
   * Handle error from recorder
   */
  handleRecorderError(error: string): void {
    this.manager.send({ type: 'RECORDER_ERROR', error });
    this.cleanup();
  }

  /**
   * Get current state for popup/UI
   */
  getState() {
    const snapshot = this.manager.getSnapshot();
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

  /**
   * Reset to idle state
   */
  reset(): void {
    this.cleanup();
    this.manager.send({ type: 'RESET' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
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
      // This would need a message to the overlay
      // For now it's handled via OVERLAY_REMOVE message
    } catch (e) {
      console.warn('[RecordingService] Overlay removal failed:', e);
    }
  }

  private startCheckpointTimer(): void {
    this.stopCheckpointTimer();
    this.checkpointInterval = setInterval(async () => {
      const state = this.manager.getSnapshot().value;
      if (state === 'recording' || state === 'stopping') {
        const context = this.manager.getSnapshot().context;
        if (context.recordingId) {
          // Persist checkpoint
          await this.chrome.storage.set({
            sessionSnapshot: {
              recordingId: context.recordingId,
              status: state,
              startedAt: context.startedAt,
              lastActivityAt: Date.now(),
              options: context.options,
              strategy: context.strategy,
              correlationId: context.correlationId,
            },
          });
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

  private cleanup(): void {
    // Clear all timers
    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout);
      this.confirmationTimeout = null;
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.stopCheckpointTimer();

    // Clear overlay
    const context = this.manager.getSnapshot().context;
    if (context.overlayTabId) {
      this.removeOverlay(context.overlayTabId);
    }

    // Close recorder tab
    if (context.recorderTabId) {
      this.chrome.tabs.remove(context.recorderTabId).catch(() => {});
    }

    // Close offscreen document
    this.chrome.offscreen.closeDocument().catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle incoming message from popup/offscreen/recorder
   */
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
    const schema = schemas[message.type as string];
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
        await this.handleOffscreenStarted();
        return { ok: true };

      case 'RECORDER_STARTED':
        await this.handleRecorderStarted();
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
        this.handleOffscreenError(message.error as string);
        return { ok: true };

      case 'RECORDER_ERROR':
        this.handleRecorderError(message.error as string);
        return { ok: true };

      case 'GET_STATE':
        return { ok: true, ...this.getState() };

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