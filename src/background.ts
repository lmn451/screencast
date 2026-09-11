/**
 * ScreenSilo Background Service Worker Entry Point
 * XState v5 with Recording Service
 *
 * Bundled by esbuild from this TypeScript source.
 * All Chrome API side effects live in RecordingService.
 */

import { createRecordingService, CHECKPOINT_ALARM_NAME } from './services/recordingService.js';
import { cleanupOldRecordings } from './lib/db.js';
import { getAllRecordings } from './lib/recording.js';
import { createLogger } from './logger.js';
import { AUTO_DELETE_AGE_MS } from './lib/constants.js';
import { hasChunks, markRecordingRecoverable } from './lib/chunkStorage.js';
import { SESSION_SNAPSHOT_KEY } from './machines/types.js';
import {
  validateMessageStrict,
  schemas,
  OUTBOUND_CONTROL_MESSAGES,
  type ExtensionMessage,
} from './messages.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & GLOBALS
// ═══════════════════════════════════════════════════════════════════════════════

const logger = createLogger('Background');

// Rate limiting
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

// Firefox does not implement chrome.offscreen. Resolve it dynamically so the
// shared background bundle can feature-detect the Chromium-only API without
// invoking or statically requiring it in Firefox.
const optionalOffscreenAPI = Reflect.get(chrome, 'offscreen') as
  | typeof chrome.offscreen
  | undefined;

const chromeAPI = {
  storage: {
    get: (key: string) => chrome.storage.local.get(key),
    set: (data: Record<string, unknown>) => chrome.storage.local.set(data),
    remove: (key: string) => chrome.storage.local.remove(key),
  },
  tabs: {
    query: (query: { active?: boolean; currentWindow?: boolean }) => chrome.tabs.query(query),
    create: (options: { url: string; active?: boolean }) => chrome.tabs.create(options),
    remove: (tabId: number) => chrome.tabs.remove(tabId),
    update: (tabId: number, options: { active: boolean }) => chrome.tabs.update(tabId, options),
    get: (tabId: number) => chrome.tabs.get(tabId),
    sendMessage: (tabId: number, message: ExtensionMessage) =>
      chrome.tabs.sendMessage(tabId, message),
  },
  scripting: {
    executeScript: (options: { target: { tabId: number }; files: string[] }) =>
      chrome.scripting.executeScript(options),
  },
  offscreen: {
    createDocument: (options: {
      url: string;
      reasons: chrome.offscreen.CreateParameters['reasons'];
      justification: string;
    }) =>
      optionalOffscreenAPI
        ? optionalOffscreenAPI.createDocument(options)
        : Promise.reject(new Error('Offscreen documents are not supported by this browser')),
    closeDocument: () => optionalOffscreenAPI?.closeDocument() ?? Promise.resolve(),
    hasDocument: () => optionalOffscreenAPI?.hasDocument() ?? Promise.resolve(false),
  },
  capabilities: {
    offscreen: typeof optionalOffscreenAPI?.hasDocument === 'function',
  },
  action: {
    setBadgeBackgroundColor: (options: { color: string }) =>
      chrome.action.setBadgeBackgroundColor(options),
    setBadgeText: (options: { text: string }) => chrome.action.setBadgeText(options),
  },
  runtime: {
    getURL: (path: string) => chrome.runtime.getURL(path),
    sendMessage: (message: ExtensionMessage) => chrome.runtime.sendMessage(message),
    id: chrome.runtime.id,
  },
  windows: {
    update: (windowId: number, options: { focused: boolean }) =>
      chrome.windows.update(windowId, options),
  },
  alarms: {
    create: (name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }) => {
      chrome.alarms.create(name, alarmInfo);
    },
    clear: (name: string) => chrome.alarms.clear(name),
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

const service = createRecordingService(chromeAPI);
logger.log('Recording service initialized');

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════

function checkRateLimit(senderId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(senderId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(senderId, { count: 1, windowStart: now });
    return true;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    logger.warn('Rate limit exceeded for sender:', senderId, { count: entry.count });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════════

type SessionSnapshotForReconcile = {
  recordingId?: string;
  status?: string;
  strategy?: 'offscreen' | 'page' | null;
  recorderTabId?: number | null;
};

async function hasLiveRecorderTab(
  recordingId: string,
  persistedTabId?: number | null
): Promise<boolean> {
  if (persistedTabId != null) {
    try {
      const tab = await chrome.tabs.get(persistedTabId);
      if (tab) return true;
    } catch {
      // Fall through to URL matching for older snapshots or a stale ID.
    }
  }

  try {
    const tabs = (await chrome.tabs.query({})) as Array<{ url?: string }>;
    return tabs.some((tab) => {
      if (!tab.url || typeof tab.url !== 'string') return false;
      try {
        const parsed = new URL(tab.url);
        return (
          parsed.pathname.endsWith('/recorder.html') &&
          parsed.searchParams.get('id') === recordingId
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function hasLikelyLiveSnapshot(
  snapshot: SessionSnapshotForReconcile | undefined
): Promise<boolean> {
  if (!snapshot?.recordingId || snapshot.status === 'idle') {
    return false;
  }

  if (snapshot.strategy === 'offscreen') {
    try {
      return (await optionalOffscreenAPI?.hasDocument()) ?? false;
    } catch {
      return false;
    }
  }

  if (snapshot.strategy === 'page') {
    return hasLiveRecorderTab(snapshot.recordingId, snapshot.recorderTabId);
  }

  return false;
}

async function recoverOrphanedRecordings(protectedRecordingIds: Set<string>): Promise<number> {
  let recoveredCount = 0;
  try {
    const recordings = await getAllRecordings();
    for (const recording of recordings) {
      if (recording.status === 'active') {
        // The service can accept START while the DB enumeration is awaiting
        // rows. Re-read ownership for every row so a session that became live
        // during that await is protected even when the initial state was idle.
        const liveState = service.getState();
        if (liveState.recording && liveState.recordingId) {
          protectedRecordingIds.add(liveState.recordingId);
        }
        // Keep every session observed live during this pass. An older row in
        // this enumeration may already have been saved while a new session
        // started; stale enumeration data must not downgrade that recording.
        if (protectedRecordingIds.has(recording.id)) {
          logger.log('Skipping likely live active recording during orphan recovery', {
            recordingId: recording.id,
          });
          continue;
        }
        await markRecordingRecoverable(recording.id);
        recoveredCount++;
        logger.log('Swept orphaned active recording to partial', {
          recordingId: recording.id,
        });
      }
    }
  } catch (e) {
    logger.error('Orphan-active sweep failed:', e);
  }
  return recoveredCount;
}

async function reconcileUnfinishedSessions(): Promise<void> {
  const currentState = service.getState();
  let recoveredOrphanCount = 0;
  let result: Record<string, unknown>;
  let snapshot: SessionSnapshotForReconcile | undefined;
  // Periodic reconciliation also runs while this service worker is alive. Keep
  // the current in-memory session out of the orphan sweep, while still
  // recovering unrelated active rows left by an older worker.
  let skipRecordingId: string | null = currentState.recording
    ? currentState.recordingId ?? null
    : null;

  try {
    result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    snapshot = result[SESSION_SNAPSHOT_KEY] as SessionSnapshotForReconcile | undefined;

    if (await hasLikelyLiveSnapshot(snapshot)) {
      skipRecordingId = snapshot?.recordingId ?? null;
    }

    // A service-worker restart wipes the in-memory machine while the capture
    // (offscreen document / recorder tab) keeps running. Reclaim the live
    // session here so the periodic reconcile is itself a recovery path and the
    // machine re-tracks a still-recording session without waiting for its next
    // heartbeat.
    if (!currentState.recording && snapshot?.recordingId && (await service.restoreSession())) {
      logger.log('Reclaimed live recording session after service worker restart', {
        recordingId: snapshot.recordingId,
      });
      skipRecordingId = snapshot.recordingId;
    }

    const protectedRecordingIds = new Set<string>();
    if (skipRecordingId) protectedRecordingIds.add(skipRecordingId);
    if (currentState.recording && currentState.recordingId) {
      protectedRecordingIds.add(currentState.recordingId);
    }
    recoveredOrphanCount = await recoverOrphanedRecordings(protectedRecordingIds);

    // Reconciliation yields while sweeping DB rows. A new START can make the
    // service live during that await, so refresh the protected ID before any
    // snapshot recovery or cleanup decisions below.
    const stateAfterOrphanRecovery = service.getState();
    if (stateAfterOrphanRecovery.recording) {
      skipRecordingId = stateAfterOrphanRecovery.recordingId ?? null;
    }

    if (snapshot?.status && snapshot.status !== 'idle') {
      if (stateAfterOrphanRecovery.recording || skipRecordingId === snapshot.recordingId) {
        logger.log('Found likely active session snapshot, deferring recovery', {
          status: snapshot.status,
          recordingId: snapshot.recordingId,
        });
      } else {
        logger.log('Found interrupted session snapshot, marking recoverable', {
          status: snapshot.status,
        });

        // Snapshot writes and this conditional clear are serialized by the
        // recording service. A newer START snapshot therefore survives even
        // when it is persisted while this reconciliation pass is awaiting DB
        // work or an earlier clear operation.
        const cleared =
          snapshot.recordingId != null &&
          (await service.clearInterruptedSessionSnapshot(snapshot.recordingId));
        if (!cleared) {
          logger.log('Skipping stale session snapshot recovery after ownership changed', {
            recordingId: snapshot.recordingId,
          });
          return;
        }

        if (snapshot.recordingId && (await hasChunks(snapshot.recordingId))) {
          await markRecordingRecoverable(snapshot.recordingId);
          logger.log('Marked recording as recoverable', { recordingId: snapshot.recordingId });
        }
        await showRecoveryPrompt();
      }
    } else if (recoveredOrphanCount > 0 && !service.getState().recording) {
      // A crash can happen before the first session snapshot is persisted.
      // The metadata stub still makes the chunks recoverable, so notify the user.
      await showRecoveryPrompt();
    }
  } catch (e) {
    logger.error('Session reconciliation failed:', e);
  }
}

async function showRecoveryPrompt(): Promise<void> {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('recovery.html') });
  } catch (e) {
    logger.error('Failed to show recovery prompt:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});

globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // These messages are broadcast by the background to offscreen/recorder
  // contexts. The background must not respond to them, otherwise it can win the
  // sendResponse race and mask the target context's real acknowledgement.
  if (OUTBOUND_CONTROL_MESSAGES.has(message?.type)) {
    return false;
  }

  // Validate sender
  if (sender.id !== chrome.runtime.id) {
    logger.warn('Ignoring message from unauthorized sender:', sender.id);
    sendResponse({ ok: false, error: 'Unauthorized sender' });
    return;
  }

  // Phase 6: Strict validation
  const schema = schemas[message?.type as keyof typeof schemas];
  if (schema) {
    const { valid, errors } = validateMessageStrict(message, schema);
    if (!valid) {
      logger.warn('Message validation failed:', errors, message.type);
      sendResponse({ ok: false, error: `Validation failed: ${errors.join(', ')}` });
      return;
    }
  } else {
    logger.warn('Unknown message type rejected:', message.type);
    sendResponse({ ok: false, error: 'Unknown message type' });
    return;
  }

  // Rate limiting
  const senderId = sender.id || 'unknown';
  if (!checkRateLimit(senderId)) {
    sendResponse({ ok: false, error: 'Rate limited' });
    return;
  }

  (async () => {
    try {
      const result = await service.handleMessage(message as Record<string, unknown>, sender);
      if (result) {
        sendResponse(result);
      }
    } catch (e) {
      logger.error('Error handling message', message.type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // Keep channel open for async response
});

// Map tab teardown events into the recording recovery state machine.
chrome.tabs.onRemoved.addListener((tabId) => {
  void Promise.resolve(service.handleTabClosing(tabId)).catch((error) => {
    logger.error('Failed to handle tab removal:', error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// Clean badge on install/update and run cleanup
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#00000000' });
    await chrome.action.setBadgeText({ text: '' });
    await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
  } catch (e) {
    logger.error('Install handler failed:', e);
  }
});

// Run reconciliation and cleanup on startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    await reconcileUnfinishedSessions();
    await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
  } catch (e) {
    logger.error('Startup handler failed:', e);
  }
});

// Periodic reconciliation via chrome.alarms (setInterval does not survive MV3
// service-worker suspension). A named periodic alarm fires every 5 minutes.
const RECONCILE_ALARM_NAME = 'screensilo-reconcile';
chrome.alarms.create(RECONCILE_ALARM_NAME, { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM_NAME) {
    reconcileUnfinishedSessions().catch((e) => {
      logger.error('Periodic reconciliation failed:', e);
    });
  } else if (alarm.name === CHECKPOINT_ALARM_NAME) {
    // Self-rescheduling checkpoint owned by RecordingService; re-arms itself
    // while recording/stopping (see RecordingService.handleCheckpointAlarm).
    service.handleCheckpointAlarm().catch((e) => {
      logger.error('Checkpoint alarm handling failed:', e);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS (for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export { reconcileUnfinishedSessions };
