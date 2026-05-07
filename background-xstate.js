/**
 * CaptureCast Background Service Worker
 * 
 * Refactored with XState v5 state machine
 * Phase: Implementation
 * 
 * This file provides the integration layer between Chrome APIs
 * and the XState recording machine.
 */

import { createRecordingService, getRecordingService } from './src/services/recordingService';
import { cleanupOldRecordings } from './db.js';
import { createLogger } from './logger.js';
import { STOP_TIMEOUT_MS, AUTO_DELETE_AGE_MS } from './constants.js';
import { hasChunks, markRecordingRecoverable } from './chunkStorage.js';
import { SESSION_SNAPSHOT_KEY } from './src/machines/types';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & GLOBALS
// ═══════════════════════════════════════════════════════════════════════════════

const logger = createLogger('Background');

let service: ReturnType<typeof createRecordingService> | null = null;

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
  },
  scripting: {
    executeScript: (options: { target: { tabId: number }; files: string[] }) => 
      chrome.scripting.executeScript(options),
  },
  offscreen: {
    createDocument: (options: { url: string; reasons: string[]; justification: string }) => 
      chrome.offscreen.createDocument(options),
    closeDocument: () => chrome.offscreen.closeDocument(),
    hasDocument: () => chrome.offscreen.hasDocument(),
  },
  action: {
    setBadgeBackgroundColor: (options: { color: string }) => chrome.action.setBadgeBackgroundColor(options),
    setBadgeText: (options: { text: string }) => chrome.action.setBadgeText(options),
  },
  runtime: {
    getURL: (path: string) => chrome.runtime.getURL(path),
    sendMessage: (message: Record<string, unknown>) => chrome.runtime.sendMessage(message),
    id: chrome.runtime.id,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the recording service
 */
function initService() {
  if (!service) {
    service = createRecordingService(chromeAPI);
    logger.log('Recording service initialized');
  }
  return service;
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
  const svc = initService();

  (async () => {
    try {
      const result = await svc.handleMessage(message, sender);
      if (result) {
        sendResponse(result);
      }
    } catch (e) {
      logger.error('Error handling message', message.type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // Keep message channel open for async response
});

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════════

async function reconcileUnfinishedSessions() {
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    const snapshot = result[SESSION_SNAPSHOT_KEY];
    if (!snapshot) return;

    logger.log('Found session snapshot, checking age…', { snapshot });
    const age = Date.now() - snapshot.lastActivityAt;

    if (age > STOP_TIMEOUT_MS) {
      // Stale session — clean up
      logger.warn('Found stale recording session, cleaning up', { age, snapshot });
      await chrome.storage.local.remove(SESSION_SNAPSHOT_KEY);

      // Check for partial recordings
      if (snapshot.recordingId) {
        const hasChunksResult = await hasChunks(snapshot.recordingId);
        if (hasChunksResult) {
          await markRecordingRecoverable(snapshot.recordingId);
          logger.log('Marked recording as recoverable', {
            recordingId: snapshot.recordingId,
          });
        }
      }
    } else {
      // Active session — show recovery prompt
      logger.log('Found active session, showing recovery prompt', {
        age,
        status: snapshot.status,
      });
      if (snapshot.status === 'recording' || snapshot.status === 'stopping') {
        await showRecoveryPrompt(snapshot);
      }
    }
  } catch (e) {
    logger.error('Session reconciliation failed:', e);
  }
}

async function showRecoveryPrompt(snapshot: {
  recordingId: string;
  status: string;
}) {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('recovery.html') });
  } catch (e) {
    logger.error('Failed to show recovery prompt:', e);
  }
}

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

// Periodic reconciliation (every 5 minutes while SW is active)
// This ensures stale sessions are cleaned up even if startup was missed
setInterval(async () => {
  await reconcileUnfinishedSessions();
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS (for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export { reconcileUnfinishedSessions };