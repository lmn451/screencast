import { cleanupOldRecordings } from './db.js';

// CaptureCast background service worker (MV3)
// Manages offscreen document, recording state, overlay injection, and preview handoff

const STATE = {
  status: 'IDLE', // 'IDLE' | 'RECORDING' | 'SAVING'
  mode: null, // 'tab' | 'screen' | 'window'
  recordingId: null,
  overlayTabId: null,
  includeMic: false,
  includeSystemAudio: false,
  recorderTabId: null,
  strategy: null, // 'offscreen' | 'page'
  stopTimeoutId: null,
};

// Helper to update badge based on status
async function updateBadge() {
  try {
    let color = '#00000000';
    let text = '';

    if (STATE.status === 'RECORDING') {
      color = '#d93025';
      text = 'REC';
    } else if (STATE.status === 'SAVING') {
      color = '#f9ab00';
      text = 'SAVE';
    }

    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {}
}

function canUseOffscreen() {
  return !!(chrome.offscreen && chrome.offscreen.createDocument);
}

async function ensureOffscreenDocument() {
  if (!canUseOffscreen()) {
    throw new Error('Offscreen API is not available; cannot create offscreen document.');
  }
  const existing = await chrome.offscreen.hasDocument?.();
  console.log('Background: Checking offscreen document, existing:', existing);
  if (existing) return;

  console.log('Background: Creating offscreen document');
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.'
  });
  console.log('Background: Offscreen document created');
}

async function closeOffscreenDocumentIfIdle() {
  try {
    if (!canUseOffscreen()) return;
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing && STATE.status === 'IDLE') {
      console.log('BACKGROUND: Closing idle offscreen document to free resources');
      await chrome.offscreen.closeDocument?.();
    }
  } catch (e) {
    console.warn('BACKGROUND: Failed to close offscreen document:', e);
  }
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js']
    });
    return true;
  } catch (e) {
    console.warn('Overlay injection failed (may be restricted page like chrome:// or extension pages)', e);
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
  } catch (e) {}
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {}
}

async function startRecording(mode, includeMic, includeSystemAudio) {
  if (STATE.status !== 'IDLE') return { ok: false, error: 'Already recording or saving' };

  STATE.mode = mode;
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = await getActiveTabId();
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;

  const useOffscreen = !STATE.includeMic && canUseOffscreen();

  if (useOffscreen) {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode,
      includeAudio: STATE.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId
    });
    STATE.strategy = 'offscreen';
  } else {
    // Use a dedicated recorder page (extension tab) where mic is allowed or as a fallback when offscreen is unavailable
    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(mode)}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}`
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

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected };
}

async function stopRecording() {
  if (STATE.status !== 'RECORDING') return { ok: false, error: 'Not recording' };

  // Transition to SAVING state immediately
  STATE.status = 'SAVING';
  await updateBadge();

  // Best-effort immediate overlay removal to avoid it lingering
  try {
    if (STATE.overlayTabId) {
      // Ask the overlay to remove itself (works if the script is still alive)
      try { await chrome.tabs.sendMessage(STATE.overlayTabId, { type: 'OVERLAY_REMOVE' }); } catch (e) {}
      // Also attempt DOM removal via scripting (in case listener isn't present)
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {}

  // Set a safety timeout (very long) just in case the offscreen/recorder crashes completely
  if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
  STATE.stopTimeoutId = setTimeout(async () => {
    console.error('BACKGROUND: Save timeout reached (300s) - forcing reset');
    await resetRecordingState();
  }, 300_000); // 5 minutes safety net

  // Send stop message to recorder/offscreen
  try {
    if (STATE.strategy === 'page') {
      await chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
    } else {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    }
  } catch (e) {
    console.error('BACKGROUND: Failed to send stop message:', e);
    // If we can't send stop message, we might be stuck.
    // But we stay in SAVING state until the timeout or user manual intervention (if we added that).
    // For now, let the timeout handle the worst case.
    return { ok: false, error: 'Failed to send stop signal: ' + e.message };
  }
  return { ok: true };
}

async function resetRecordingState() {
  if (STATE.stopTimeoutId) {
    clearTimeout(STATE.stopTimeoutId);
    STATE.stopTimeoutId = null;
  }

  STATE.status = 'IDLE';
  await updateBadge();

  try {
    if (STATE.overlayTabId) {
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {}
  try {
    if (STATE.recorderTabId) {
      await chrome.tabs.remove(STATE.recorderTabId);
    }
  } catch (e) {}

  STATE.mode = null;
  STATE.overlayTabId = null;
  STATE.includeMic = false;
  STATE.includeSystemAudio = false;
  STATE.recorderTabId = null;
  STATE.strategy = null;
  STATE.recordingId = null;
}

// Handle messages from popup, overlay, offscreen, and preview
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate message sender for security
  if (sender.id !== chrome.runtime.id) {
    console.warn('BACKGROUND: Ignoring message from unauthorized sender:', sender.id);
    sendResponse({ ok: false, error: 'Unauthorized sender' });
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
        // Acknowledge start to avoid async-channel warnings
        sendResponse({ ok: true });
        break;
      }
      case 'OFFSCREEN_DATA': {
        // Receive notification that data is saved in DB
        const { recordingId } = message;
        console.log('Background received OFFSCREEN_DATA:', { recordingId });

        // Reset state
        await resetRecordingState();

        // Open preview page and pass the id in URL
        const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
        await chrome.tabs.create({ url });
        await closeOffscreenDocumentIfIdle();
        sendResponse({ ok: true });
        break;
      }
      case 'RECORDER_DATA': {
        // Receive notification that data is saved in DB
        const { recordingId } = message;
        console.log('Background received RECORDER_DATA:', { recordingId });

        await resetRecordingState();

        const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
        await chrome.tabs.create({ url });
        sendResponse({ ok: true });
        break;
      }
      case 'RECORDER_STARTED': {
        if (STATE.overlayTabId) {
          await focusTab(STATE.overlayTabId);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'PREVIEW_READY': {
        // No-op or simple ack, as preview now loads from DB directly
        sendResponse({ ok: true });
        break;
      }
      case 'OFFSCREEN_ERROR': {
        console.error('Background received OFFSCREEN_ERROR:', message.error);
        await resetRecordingState();
        sendResponse({ ok: false, error: message.error });
        break;
      }
      case 'GET_STATE': {
        // Map internal status to boolean for backward compatibility with popup
        const publicState = {
          ...STATE,
          recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING'
        };
        sendResponse(publicState);
        break;
      }
      case 'OFFSCREEN_TEST': {
        console.log('Background: Received OFFSCREEN_TEST message');
        sendResponse({ ok: true, message: 'Test successful' });
        break;
      }
      default: {
        // Unknown message
        console.log('Background: Unknown message type:', message.type);
        sendResponse({ ok: false, error: 'Unknown message' });
      }
    }
    } catch (e) {
      console.error('Background: Error handling message', message.type, e);
      try {
        sendResponse({ ok: false, error: String(e) });
      } catch (e2) {}
    }
  })();
  return true; // Keep message channel open for async response
});

// Clean badge on install/update and run cleanup
chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge();
  // Cleanup recordings older than 24 hours
  try {
    await cleanupOldRecordings(24 * 60 * 60 * 1000);
  } catch (e) {
    console.error('BACKGROUND: Cleanup failed:', e);
  }
});

// Also run cleanup on startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    await cleanupOldRecordings(24 * 60 * 60 * 1000);
  } catch (e) {
    console.error('BACKGROUND: Cleanup failed:', e);
  }
});