/**
 * CaptureCast Background Service Worker Entry Point
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
import { validateMessageStrict, schemas } from './messages.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & GLOBALS
// ═══════════════════════════════════════════════════════════════════════════════

const logger = createLogger('Background');

// Rate limiting
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 50;
const OUTBOUND_CONTROL_MESSAGES = new Set([
  'OFFSCREEN_START',
  'OFFSCREEN_STOP',
  'RECORDER_STOP',
  'OFFSCREEN_TEST',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CHROME API WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

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
    sendMessage: (tabId: number, message: Record<string, unknown>) =>
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
      chrome.offscreen.createDocument(options),
    closeDocument: () => chrome.offscreen.closeDocument(),
    hasDocument: () => chrome.offscreen.hasDocument(),
  },
  action: {
    setBadgeBackgroundColor: (options: { color: string }) =>
      chrome.action.setBadgeBackgroundColor(options),
    setBadgeText: (options: { text: string }) => chrome.action.setBadgeText(options),
  },
  runtime: {
    getURL: (path: string) => chrome.runtime.getURL(path),
    sendMessage: (message: Record<string, unknown>) => chrome.runtime.sendMessage(message),
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
};

async function hasLiveRecorderTab(recordingId: string): Promise<boolean> {
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

async function hasLikelyLiveSnapshot(snapshot: SessionSnapshotForReconcile | undefined): Promise<boolean> {
  if (!snapshot?.recordingId || snapshot.status === 'idle') {
    return false;
  }

  if (snapshot.strategy === 'offscreen') {
    try {
      return await chrome.offscreen.hasDocument();
    } catch {
      return false;
    }
  }

  if (snapshot.strategy === 'page') {
    return hasLiveRecorderTab(snapshot.recordingId);
  }

  return false;
}

async function recoverOrphanedRecordings(skipRecordingId: string | null): Promise<number> {
  let recoveredCount = 0;
  try {
    const recordings = await getAllRecordings();
    for (const recording of recordings) {
      if (recording.status === 'active') {
        if (recording.id === skipRecordingId) {
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
  let skipRecordingId: string | null = null;

  // Periodic reconciliation also runs while this service worker is alive. Do
  // not mistake the current in-memory recording for an interrupted session.
  if (currentState.recording) {
    return;
  }

  try {
    result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    snapshot = result[SESSION_SNAPSHOT_KEY] as
      | SessionSnapshotForReconcile
      | undefined;

    if (await hasLikelyLiveSnapshot(snapshot)) {
      skipRecordingId = snapshot?.recordingId ?? null;
    }

    recoveredOrphanCount = await recoverOrphanedRecordings(skipRecordingId);

    if (snapshot?.status && snapshot.status !== 'idle') {
      if (skipRecordingId === snapshot.recordingId) {
        logger.log('Found likely active session snapshot, deferring recovery', {
          status: snapshot.status,
          recordingId: snapshot.recordingId,
        });
      } else {
        logger.log('Found interrupted session snapshot, marking recoverable', {
          status: snapshot.status,
        });
        await chrome.storage.local.remove(SESSION_SNAPSHOT_KEY);

        if (snapshot.recordingId && (await hasChunks(snapshot.recordingId))) {
          await markRecordingRecoverable(snapshot.recordingId);
          logger.log('Marked recording as recoverable', { recordingId: snapshot.recordingId });
        }
        await showRecoveryPrompt();
      }
    } else if (recoveredOrphanCount > 0) {
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
  service.handleTabClosing(tabId);
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
const RECONCILE_ALARM_NAME = 'capturecast-reconcile';
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
