/**
 * CaptureCast Background Service Worker Entry Point
 * XState v5 with Recording Service
 *
 * Bundled by esbuild from this TypeScript source.
 * All Chrome API side effects live in RecordingService.
 */

import { createRecordingService } from './services/recordingService.js';
import { cleanupOldRecordings } from '../db.js';
import { createLogger } from '../logger.js';
import { STOP_TIMEOUT_MS, AUTO_DELETE_AGE_MS } from '../constants.js';
import { hasChunks, markRecordingRecoverable } from '../chunkStorage.js';
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
    sendMessage: (tabId: number, message: Record<string, unknown>) => chrome.tabs.sendMessage(tabId, message),
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
  windows: {
    update: (windowId: number, options: { focused: boolean }) => chrome.windows.update(windowId, options),
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
// UUID VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════════

async function reconcileUnfinishedSessions(): Promise<void> {
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
          logger.log('Marked recording as recoverable', { recordingId: snapshot.recordingId });
        }
      }
    } else {
      // Active session — show recovery prompt
      logger.log('Found active session, showing recovery prompt', { age, status: snapshot.status });
      if (snapshot.status === 'recording' || snapshot.status === 'stopping') {
        await showRecoveryPrompt(snapshot);
      }
    }
  } catch (e) {
    logger.error('Session reconciliation failed:', e);
  }
}

async function showRecoveryPrompt(snapshot: { recordingId: string; status: string }): Promise<void> {
  try {
    await chrome.storage.local.set({ [SESSION_SNAPSHOT_KEY]: snapshot });
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
setInterval(async () => {
  await reconcileUnfinishedSessions();
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS (for testing)
// ═══════════════════════════════════════════════════════════════════════════════

export { reconcileUnfinishedSessions };