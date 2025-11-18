// CaptureCast background service worker (MV3)
// Manages offscreen document, recording state, overlay injection, and preview handoff

const STATE = {
  recording: false,
  mode: null, // 'tab' | 'screen' | 'window'
  recordingId: null,
  overlayTabId: null,
  includeMic: false,
  includeSystemAudio: false,
  recorderTabId: null,
  strategy: null, // 'offscreen' | 'page'
  stopTimeoutId: null,
};

// Temporary in-memory store removed in favor of IndexedDB


async function setBadgeRecording(isRecording) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: isRecording ? '#d93025' : '#00000000' });
  } catch (e) {}
  try {
    await chrome.action.setBadgeText({ text: isRecording ? 'REC' : '' });
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
  // Optional: Could close when not recording to save resources
  try {
    if (!canUseOffscreen()) return;
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing && !STATE.recording) {
      await chrome.offscreen.closeDocument?.();
    }
  } catch (e) {}
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js']
    });
  } catch (e) {
    console.warn('Overlay injection failed', e);
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
  if (STATE.recording) return { ok: false, error: 'Already recording' };
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
  if (STATE.overlayTabId) {
    await injectOverlay(STATE.overlayTabId);
  }

  STATE.recording = true;
  await setBadgeRecording(true);
  return { ok: true };
}

async function stopRecording() {
  if (!STATE.recording) return { ok: false, error: 'Not recording' };

  // Best-effort immediate overlay removal to avoid it lingering if final data is delayed
  try {
    if (STATE.overlayTabId) {
      // Ask the overlay to remove itself (works if the script is still alive)
      try { await chrome.tabs.sendMessage(STATE.overlayTabId, { type: 'OVERLAY_REMOVE' }); } catch (e) {}
      // Also attempt DOM removal via scripting (in case listener isn't present)
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {}

  if (STATE.stopTimeoutId) {
    clearTimeout(STATE.stopTimeoutId);
    STATE.stopTimeoutId = null;
  }

  STATE.stopTimeoutId = setTimeout(async () => {
    try {
      await setBadgeRecording(false);
    } catch (e) {}
    try {
      if (STATE.overlayTabId) {
        await removeOverlay(STATE.overlayTabId);
      }
    } catch (e) {}
    STATE.recording = false;
    STATE.mode = null;
    STATE.overlayTabId = null;
    STATE.includeMic = false;
    STATE.includeSystemAudio = false;
    STATE.recorderTabId = null;
    STATE.strategy = null;
    STATE.recordingId = null;
    STATE.stopTimeoutId = null;
  }, 10_000);

  if (STATE.strategy === 'page') {
    await chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
  } else {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  }
  return { ok: true };
}

// Handle messages from popup, overlay, offscreen, and preview
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

        if (STATE.stopTimeoutId) {
          clearTimeout(STATE.stopTimeoutId);
          STATE.stopTimeoutId = null;
        }

        // Reset state
        await setBadgeRecording(false);
        const tabId = STATE.overlayTabId;
        if (tabId) await removeOverlay(tabId);
        STATE.recording = false;
        STATE.mode = null;
        STATE.overlayTabId = null;
        STATE.includeMic = false;
        STATE.includeSystemAudio = false;
        STATE.strategy = null;
        STATE.recorderTabId = null;
        STATE.recordingId = null;

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

        if (STATE.stopTimeoutId) {
          clearTimeout(STATE.stopTimeoutId);
          STATE.stopTimeoutId = null;
        }

        await setBadgeRecording(false);
        const tabId = STATE.overlayTabId;
        if (tabId) await removeOverlay(tabId);
        if (STATE.recorderTabId) {
          try { await chrome.tabs.remove(STATE.recorderTabId); } catch (e) {}
        }
        STATE.recording = false;
        STATE.mode = null;
        STATE.overlayTabId = null;
        STATE.includeMic = false;
        STATE.includeSystemAudio = false;
        STATE.recorderTabId = null;
        STATE.strategy = null;
        STATE.recordingId = null;

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
        // We can't easily alert from background, but we can ensure we don't hang
        STATE.recording = false;
        await setBadgeRecording(false);
        break;
      }
      case 'GET_STATE': {
        sendResponse({ ...STATE });
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

// Clean badge on install/update
chrome.runtime.onInstalled.addListener(async () => {
  await setBadgeRecording(false);
});