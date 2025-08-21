// CaptureCast background service worker (MV3)
// Manages offscreen document, recording state, overlay injection, and preview handoff

const STATE = {
  recording: false,
  mode: null, // 'tab' | 'screen' | 'window'
  recordingId: null,
  overlayTabId: null,
};

// Temporary in-memory store for large blobs keyed by recordingId
const recordingStore = new Map();

async function setBadgeRecording(isRecording) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: isRecording ? '#d93025' : '#00000000' });
  } catch (e) {}
  try {
    await chrome.action.setBadgeText({ text: isRecording ? 'REC' : '' });
  } catch (e) {}
}

async function ensureOffscreenDocument() {
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
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing && !STATE.recording) {
      await chrome.offscreen.closeDocument();
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

async function startRecording(mode) {
  if (STATE.recording) return { ok: false, error: 'Already recording' };
  STATE.mode = mode;
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = await getActiveTabId();

  await ensureOffscreenDocument();

  // Ask offscreen to start capture and recording
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', mode, recordingId: STATE.recordingId, targetTabId: STATE.overlayTabId });

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
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  return { ok: true };
}

// Handle messages from popup, overlay, offscreen, and preview
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START': {
        const res = await startRecording(message.mode);
        sendResponse(res);
        break;
      }
      case 'STOP': {
        const res = await stopRecording();
        sendResponse(res);
        break;
      }
      case 'OFFSCREEN_STARTED': {
        // no-op; kept for debugging
        break;
      }
      case 'OFFSCREEN_DATA': {
        // Receive recorded data from offscreen
        const { recordingId, dataArray, mimeType } = message;
        console.log('Background received OFFSCREEN_DATA:', {
          recordingId,
          dataArraySize: dataArray?.length || 0,
          mimeType
        });
        
        // Convert dataArray back to ArrayBuffer
        const arrayBuffer = new Uint8Array(dataArray).buffer;
        console.log('Background: Converted to ArrayBuffer, size:', arrayBuffer.byteLength);
        
        recordingStore.set(recordingId, { arrayBuffer, mimeType });
        // Reset state
        await setBadgeRecording(false);
        const tabId = STATE.overlayTabId;
        if (tabId) await removeOverlay(tabId);
        STATE.recording = false;
        STATE.mode = null;
        STATE.overlayTabId = null;

        // Open preview page and pass the id in URL
        const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
        await chrome.tabs.create({ url });
        await closeOffscreenDocumentIfIdle();
        sendResponse({ ok: true });
        break;
      }
      case 'PREVIEW_READY': {
        const { recordingId } = message;
        const data = recordingStore.get(recordingId);
        if (data) {
          // Transfer the ArrayBuffer for efficiency
          try {
            sendResponse({ ok: true, recordingId, mimeType: data.mimeType, arrayBuffer: data.arrayBuffer }, [data.arrayBuffer]);
          } catch (e) {
            // Fallback if transferable fails
            sendResponse({ ok: true, recordingId, mimeType: data.mimeType, arrayBuffer: data.arrayBuffer });
          }
          recordingStore.delete(recordingId);
        } else {
          sendResponse({ ok: false, error: 'Recording not found or already consumed.' });
        }
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
  })();
  return true; // Keep message channel open for async response
});

// Clean badge on install/update
chrome.runtime.onInstalled.addListener(async () => {
  await setBadgeRecording(false);
});
