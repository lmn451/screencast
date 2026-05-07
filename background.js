import { cleanupOldRecordings } from './db.js';
import { createLogger } from './logger.js';
import { STOP_TIMEOUT_MS, AUTO_DELETE_AGE_MS } from './constants.js';
import { checkStorageQuota } from './storage-utils.js';
import { hasChunks, markRecordingRecoverable } from './chunkStorage.js';
import {
  schemas,
  validateMessageStrict,
  validateStateTransition,
  STATE_IDLE,
  STATE_STARTING,
  STATE_RECORDING,
  STATE_STOPPING,
  STATE_SAVING,
  STATE_SAVED,
  STATE_FAILED,
  MSG_RECOVERY_RESUME,
  MSG_RECOVERY_DISCARD,
} from './src/messages.js';

// CaptureCast background service worker (MV3)
// Manages offscreen document, recording state, overlay injection, and preview handoff

const logger = createLogger('Background');

// Global error handlers
globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

const STATE = {
  status: STATE_IDLE,
  recordingId: null,
  correlationId: null,
  overlayTabId: null,
  recorderTabId: null,
  strategy: null, // 'offscreen' | 'page'
  stopTimeoutId: null,
  // Timestamp-based tracking for heartbeat reconciliation (no periodic pings)
  startedAt: null,
  lastActivityAt: null,
  // Recording options
  options: {
    mode: null, // 'tab' | 'screen' | 'window'
    includeMic: false,
    includeSystemAudio: false,
  },
};

// Session snapshot for crash recovery
const SESSION_SNAPSHOT_KEY = 'sessionSnapshot';

/**
 * Persist session snapshot to chrome.storage.local for crash recovery
 * @param {object} [extra] - Extra fields to include in snapshot
 */
async function persistSessionSnapshot(extra = {}) {
  try {
    const snapshot = {
      recordingId: STATE.recordingId,
      status: STATE.status,
      startedAt: STATE.startedAt,
      lastActivityAt: STATE.lastActivityAt,
      options: { ...STATE.options },
      strategy: STATE.strategy,
      correlationId: STATE.correlationId,
      ...extra,
    };
    await chrome.storage.local.set({ [SESSION_SNAPSHOT_KEY]: snapshot });
    logger.log('Session snapshot persisted', { status: STATE.status });
  } catch (e) {
    logger.warn('Failed to persist session snapshot:', e);
  }
}

/**
 * Clear session snapshot from chrome.storage.local
 */
async function clearSessionSnapshot() {
  try {
    await chrome.storage.local.remove(SESSION_SNAPSHOT_KEY);
    logger.log('Session snapshot cleared');
  } catch (e) {
    logger.warn('Failed to clear session snapshot:', e);
  }
}

// Checkpoint interval: 30 seconds
const CHECKPOINT_INTERVAL_MS = 30_000;

let checkpointIntervalId = null;

/**
 * Start periodic session snapshot checkpointing
 * Persists state every CHECKPOINT_INTERVAL_MS to survive SW termination
 */
function startCheckpointTimer() {
  stopCheckpointTimer();
  checkpointIntervalId = setInterval(async () => {
    if (
      (STATE.status === STATE_RECORDING || STATE.status === STATE_STOPPING) &&
      STATE.recordingId
    ) {
      STATE.lastActivityAt = Date.now();
      await persistSessionSnapshot();
    }
  }, CHECKPOINT_INTERVAL_MS);
}

/**
 * Stop periodic checkpoint timer
 */
function stopCheckpointTimer() {
  if (checkpointIntervalId) {
    clearInterval(checkpointIntervalId);
    checkpointIntervalId = null;
  }
}

/**
 * On startup, check for unfinished sessions and clean up stale ones.
 * Uses timestamp-based reconciliation — no periodic heartbeat pings.
 */
async function reconcileUnfinishedSessions() {
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    const snapshot = result[SESSION_SNAPSHOT_KEY];
    if (!snapshot) return;

    logger.log('Found session snapshot, checking age…', { snapshot });
    const age = Date.now() - snapshot.lastActivityAt;

    if (age > STOP_TIMEOUT_MS) {
      // Stale session — clean up
      logger.warn('Found stale recording session, cleaning up', {
        age,
        snapshot,
      });
      await clearSessionSnapshot();

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
      // ACTIVE SESSION — show recovery prompt
      logger.log('Found active session, showing recovery prompt', {
        age,
        status: snapshot.status,
      });
      if (snapshot.status === STATE_RECORDING || snapshot.status === STATE_STOPPING) {
        await showRecoveryPrompt(snapshot);
      }
    }
  } catch (e) {
    logger.error('Session reconciliation failed:', e);
  }
}

/**
 * Show recovery prompt by opening recovery.html
 * @param {object} snapshot - Session snapshot to recover
 */
async function showRecoveryPrompt(snapshot) {
  try {
    await chrome.storage.local.set({ [SESSION_SNAPSHOT_KEY]: snapshot });
    await chrome.tabs.create({ url: chrome.runtime.getURL('recovery.html') });
  } catch (e) {
    logger.error('Failed to show recovery prompt:', e);
  }
}

// Helper to update badge based on status
async function updateBadge() {
  try {
    let color = '#00000000';
    let text = '';

    if (STATE.status === STATE_RECORDING) {
      color = '#d93025';
      text = 'REC';
    } else if (STATE.status === STATE_SAVING) {
      color = '#f9ab00';
      text = 'SAVE';
    }

    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    logger.warn('Badge update failed (non-critical):', e);
  }
}

function canUseOffscreen() {
  return !!(chrome.offscreen && chrome.offscreen.createDocument);
}

async function ensureOffscreenDocument() {
  if (!canUseOffscreen()) {
    throw new Error('Offscreen API is not available; cannot create offscreen document.');
  }
  const existing = await chrome.offscreen.hasDocument?.();
  logger.log('Checking offscreen document, existing:', existing);
  if (existing) return;

  logger.log('Creating offscreen document');
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.',
  });
  logger.log('Offscreen document created');
}

async function closeOffscreenDocumentIfIdle() {
  try {
    if (!canUseOffscreen()) return;
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing && STATE.status === STATE_IDLE) {
      logger.log('Closing idle offscreen document to free resources');
      await chrome.offscreen.closeDocument?.();
    }
  } catch (e) {
    logger.warn('Failed to close offscreen document:', e);
  }
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    logger.log('Overlay injection failed (may be restricted page):', e.message);
    return false;
  }
}

async function removeOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById('cc-overlay');
        if (el) el.remove();
      },
    });
  } catch (e) {
    logger.warn('Overlay removal failed (non-critical):', e);
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        logger.warn('Window focus failed (non-critical):', e);
      }
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    logger.warn('Tab focus failed (non-critical):', e);
  }
}

async function startRecording(mode, includeMic, includeSystemAudio) {
  const transition = validateStateTransition(STATE.status, STATE_STARTING);
  if (!transition.valid) {
    logger.warn('Invalid state transition:', transition.error);
    return { ok: false, error: transition.error };
  }
  if (STATE.status !== STATE_IDLE) return { ok: false, error: 'Already recording or saving' };

  // Task 4.3: Concurrent recording lock
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    const snapshot = result[SESSION_SNAPSHOT_KEY];
    if (snapshot) {
      const activeStatuses = [STATE_STARTING, STATE_RECORDING, STATE_STOPPING, STATE_SAVING];
      if (activeStatuses.includes(snapshot.status)) {
        const age = Date.now() - snapshot.lastActivityAt;
        if (age < 30000) {
          logger.warn('Recording already in progress, rejecting new start', { snapshot, age });
          return { ok: false, error: 'Recording already in progress' };
        }
      }
    }
  } catch (e) {
    logger.warn('Failed to check for concurrent recording:', e);
  }

  // Check storage quota before starting
  const storageCheck = await checkStorageQuota();
  if (!storageCheck.ok) {
    logger.error('Storage check failed:', storageCheck.error);
    return { ok: false, error: storageCheck.error };
  }

  // Initialize timestamps
  const now = Date.now();
  STATE.startedAt = now;
  STATE.lastActivityAt = now;
  STATE.options = {
    mode,
    includeMic: !!includeMic,
    includeSystemAudio: !!includeSystemAudio,
  };
  STATE.status = STATE_STARTING;
  STATE.recordingId = crypto.randomUUID();
  STATE.correlationId = crypto.randomUUID();
  STATE.overlayTabId = await getActiveTabId();

  // Task 4.2: Persist session snapshot
  await persistSessionSnapshot();

  const useOffscreen = !STATE.options.includeMic && canUseOffscreen();

  if (useOffscreen) {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode,
      includeAudio: STATE.options.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId,
    });
    STATE.strategy = 'offscreen';
  } else {
    // Use a dedicated recorder page (extension tab) where mic is allowed or as a fallback when offscreen is unavailable
    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
        mode
      )}&mic=${STATE.options.includeMic ? 1 : 0}&sys=${STATE.options.includeSystemAudio ? 1 : 0}`
    );
    const tab = await chrome.tabs.create({ url, active: true });
    STATE.recorderTabId = tab.id ?? null;
    STATE.strategy = 'page';
  }

  // Best-effort overlay on the active tab
  let overlayInjected = false;
  if (STATE.overlayTabId) {
    overlayInjected = await injectOverlay(STATE.overlayTabId);
  }

  // Task 4.2: Wait for confirmation from recorder/offscreen before transitioning to RECORDING
  // Best-effort: if no confirmation within 5 seconds, fall back to RECORDING
  const confirmationTimeout = setTimeout(() => {
    if (STATE.status === STATE_STARTING) {
      logger.warn('No confirmation received within 5 seconds, falling back to RECORDING', {
        correlationId: STATE.correlationId,
      });
      STATE.status = STATE_RECORDING;
      STATE.lastActivityAt = Date.now();
      persistSessionSnapshot();
      updateBadge();
    }
  }, 5000);

  // Store timeout ID for cleanup
  STATE.stopTimeoutId = confirmationTimeout;

  logger.log('Recording starting', {
    recordingId: STATE.recordingId,
    correlationId: STATE.correlationId,
    strategy: STATE.strategy,
  });
  // Start periodic checkpoint timer
  startCheckpointTimer();
  return { ok: true, overlayInjected };
}

async function stopRecording() {
  const transition = validateStateTransition(STATE.status, STATE_STOPPING);
  if (!transition.valid) {
    logger.warn('Invalid state transition:', transition.error);
    return { ok: false, error: transition.error };
  }
  if (STATE.status !== STATE_RECORDING) return { ok: false, error: 'Not recording' };

  // Task 4.4: Transition to STOPPING and update session snapshot
  STATE.status = STATE_STOPPING;
  STATE.lastActivityAt = Date.now();
  stopCheckpointTimer(); // Stop periodic checkpoint
  await persistSessionSnapshot();
  await updateBadge();
  logger.log('Stopping recording', { correlationId: STATE.correlationId });

  // Best-effort immediate overlay removal to avoid it lingering
  try {
    if (STATE.overlayTabId) {
      try {
        await chrome.tabs.sendMessage(STATE.overlayTabId, { type: 'OVERLAY_REMOVE' });
      } catch (sendErr) {
        logger.warn('Overlay sendMessage failed (non-critical):', sendErr);
      }
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {
    logger.warn('Overlay removal in stopRecording failed:', e);
  }

  // Set a safety timeout (very long) just in case the offscreen/recorder crashes completely
  if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
  STATE.stopTimeoutId = setTimeout(async () => {
    logger.error(`Save timeout reached (${STOP_TIMEOUT_MS / 1000}s) - forcing reset`, {
      correlationId: STATE.correlationId,
    });
    await clearSessionSnapshot();
    await resetRecordingState();
  }, STOP_TIMEOUT_MS);

  // Send stop message to recorder/offscreen
  try {
    if (STATE.strategy === 'page') {
      await chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
    } else {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    }
  } catch (e) {
    logger.error('Failed to send stop message:', e);
    return { ok: false, error: 'Failed to send stop signal: ' + e.message };
  }
  return { ok: true };
}

async function resetRecordingState() {
  if (STATE.stopTimeoutId) {
    clearTimeout(STATE.stopTimeoutId);
    STATE.stopTimeoutId = null;
  }

  STATE.status = STATE_IDLE;
  STATE.lastActivityAt = Date.now();
  logger.log('State reset', { correlationId: STATE.correlationId });
  STATE.correlationId = null;
  await updateBadge();

  try {
    if (STATE.overlayTabId) {
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {
    logger.warn('Overlay removal in reset failed:', e);
  }
  try {
    if (STATE.recorderTabId) {
      await chrome.tabs.remove(STATE.recorderTabId);
    }
  } catch (e) {
    logger.warn('Recorder tab removal in reset failed:', e);
  }

  STATE.startedAt = null;
  STATE.lastActivityAt = null;
  stopCheckpointTimer(); // Stop periodic checkpoint
  STATE.options = {
    mode: null,
    includeMic: false,
    includeSystemAudio: false,
  };
  STATE.overlayTabId = null;
  STATE.recorderTabId = null;
  STATE.strategy = null;
  STATE.recordingId = null;
}

// Rate limiting state: Map<senderId, {count, windowStart}>
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 50;

/**
 * Simple sliding window rate limiter for message throttling
 * @param {string} senderId - Sender identifier
 * @returns {boolean} - True if under limit, false if throttled
 */
function checkRateLimit(senderId) {
  const now = Date.now();
  const entry = rateLimitMap.get(senderId);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Start new window
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

/**
 * Validate UUID format for security
 * @param {string} str - String to validate
 * @returns {boolean} - True if valid UUID
 */
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Handle messages from popup, overlay, offscreen, and preview
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate message sender for security
  if (sender.id !== chrome.runtime.id) {
    logger.warn('Ignoring message from unauthorized sender:', sender.id);
    sendResponse({ ok: false, error: 'Unauthorized sender' });
    return;
  }

  // Phase 6: Strict validation enabled
  const schema = schemas[message?.type];
  if (schema) {
    const { valid, errors } = validateMessageStrict(message, schema);
    if (!valid) {
      logger.warn('Message validation failed:', errors, message.type);
      sendResponse({ ok: false, error: `Validation failed: ${errors.join(', ')}` });
      return;
    }
  } else {
    // Unknown message types are rejected (logged and rejected)
    logger.warn('Unknown message type rejected:', message.type);
    sendResponse({ ok: false, error: 'Unknown message type' });
    return;
  }

  // Rate limiting check
  const senderId = sender.id || 'unknown';
  if (!checkRateLimit(senderId)) {
    sendResponse({ ok: false, error: 'Rate limited' });
    return;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'START': {
          const res = await startRecording(message.mode, message.mic, message.systemAudio);
          sendResponse(res);
          break;
        }
        case 'STOP': {
          const res = await stopRecording();
          sendResponse(res);
          break;
        }
        case 'OFFSCREEN_STARTED': {
          // Task 4.2: Transition to RECORDING only after confirmation
          if (STATE.status === STATE_STARTING) {
            STATE.status = STATE_RECORDING;
            STATE.lastActivityAt = Date.now();
            await persistSessionSnapshot();
            await updateBadge();
            logger.log('Recording confirmed (offscreen)', {
              recordingId: STATE.recordingId,
              correlationId: STATE.correlationId,
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'OFFSCREEN_DATA': {
          const { recordingId } = message;

          // Task 6.6: Validate recording ID
          if (!isValidUUID(recordingId)) {
            logger.warn('Invalid recording ID in OFFSCREEN_DATA:', recordingId);
            sendResponse({ ok: false, error: 'Invalid recording ID' });
            break;
          }

          logger.log('Received OFFSCREEN_DATA:', {
            recordingId,
            correlationId: STATE.correlationId,
          });

          // Task 4.6: Transition to SAVED, clear snapshot, open preview
          STATE.status = STATE_SAVED;
          STATE.lastActivityAt = Date.now();
          await persistSessionSnapshot();
          await clearSessionSnapshot();
          await updateBadge();

          const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
          await chrome.tabs.create({ url });
          await closeOffscreenDocumentIfIdle();
          sendResponse({ ok: true });
          break;
        }
        case 'RECORDER_DATA': {
          const { recordingId } = message;

          // Task 6.6: Validate recording ID
          if (!isValidUUID(recordingId)) {
            logger.warn('Invalid recording ID in RECORDER_DATA:', recordingId);
            sendResponse({ ok: false, error: 'Invalid recording ID' });
            break;
          }

          logger.log('Received RECORDER_DATA:', {
            recordingId,
            correlationId: STATE.correlationId,
          });

          // Task 4.6: Transition to SAVED, clear snapshot, open preview
          STATE.status = STATE_SAVED;
          STATE.lastActivityAt = Date.now();
          await persistSessionSnapshot();
          await clearSessionSnapshot();
          await updateBadge();

          const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
          await chrome.tabs.create({ url });
          sendResponse({ ok: true });
          break;
        }
        case 'RECORDER_STARTED': {
          // Task 4.2: Transition to RECORDING only after confirmation
          if (STATE.status === STATE_STARTING) {
            STATE.status = STATE_RECORDING;
            STATE.lastActivityAt = Date.now();
            await persistSessionSnapshot();
            await updateBadge();
            logger.log('Recording confirmed (recorder page)', {
              recordingId: STATE.recordingId,
              correlationId: STATE.correlationId,
            });
          }
          if (STATE.overlayTabId) {
            await focusTab(STATE.overlayTabId);
          }
          sendResponse({ ok: true });
          break;
        }
        case 'PREVIEW_READY': {
          sendResponse({ ok: true });
          break;
        }
        case 'OFFSCREEN_ERROR': {
          // Task 4.7: Transition to FAILED, log, clear snapshot
          logger.error('Received OFFSCREEN_ERROR:', message.error, {
            correlationId: STATE.correlationId,
          });
          STATE.status = STATE_FAILED;
          STATE.lastActivityAt = Date.now();
          await persistSessionSnapshot();
          await clearSessionSnapshot();
          await updateBadge();
          sendResponse({ ok: false, error: message.error });
          break;
        }
        case 'GET_STATE': {
          // Task 4.10: Return full state including timestamps and options
          const publicState = {
            status: STATE.status,
            recordingId: STATE.recordingId,
            correlationId: STATE.correlationId,
            startedAt: STATE.startedAt,
            lastActivityAt: STATE.lastActivityAt,
            options: { ...STATE.options },
            strategy: STATE.strategy,
            recording: STATE.status === STATE_RECORDING || STATE.status === STATE_SAVING,
          };
          sendResponse(publicState);
          break;
        }
        case 'OFFSCREEN_TEST': {
          logger.log('Received OFFSCREEN_TEST message');
          sendResponse({ ok: true, message: 'Test successful' });
          break;
        }
        case MSG_RECOVERY_RESUME: {
          // Resume is limited: can only save existing chunks, cannot continue recording
          // Original MediaStream is lost when tab was closed
          const { recordingId } = message;
          logger.log('User requested recovery resume', { recordingId });
          sendResponse({
            ok: true,
            message: 'Resume opens existing recording for save - cannot continue capture',
            recordingId,
          });
          break;
        }
        case MSG_RECOVERY_DISCARD: {
          const { recordingId } = message;
          // Validate we're in a valid state to reset
          if (
            STATE.status !== STATE_RECORDING &&
            STATE.status !== STATE_STOPPING &&
            STATE.status !== STATE_IDLE
          ) {
            logger.warn('RECOVERY_DISCARD called but not in recording state', {
              status: STATE.status,
            });
          }
          logger.log('User requested recovery discard', { recordingId });
          await clearSessionSnapshot();
          await resetRecordingState();
          sendResponse({ ok: true });
          break;
        }
        default: {
          logger.warn('Unknown message type:', message.type);
          sendResponse({ ok: false, error: 'Unknown message' });
        }
      }
    } catch (e) {
      logger.error('Error handling message', message.type, e, {
        correlationId: STATE.correlationId,
      });
      try {
        sendResponse({ ok: false, error: String(e) });
      } catch (sendErr) {
        logger.warn('Failed to send error response:', sendErr);
      }
    }
  })();
  return true; // Keep message channel open for async response
});

// Clean badge on install/update and run cleanup
chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge();
  try {
    await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
  } catch (e) {
    logger.error('Cleanup failed:', e);
  }
});

// Task 4.5: Also run reconciliation on startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    await reconcileUnfinishedSessions();
    await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
  } catch (e) {
    logger.error('Startup handler failed:', e);
  }
});
