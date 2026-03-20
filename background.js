import { cleanupOldRecordings } from './db.js';
import { createLogger } from './logger.js';
import { STOP_TIMEOUT_MS, AUTO_DELETE_AGE_MS } from './constants.js';
import { checkStorageQuota } from './storage-utils.js';

const logger = createLogger('Background');

globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

const STATE = {
  status: 'IDLE',
  backend: null,
  mode: null,
  recordingId: null,
  overlayTabId: null,
  includeMic: false,
  includeSystemAudio: false,
  recorderTabId: null,
  strategy: null,
  stopTimeoutId: null,
  isAutomation: false,
  cdpTabId: null,
  cdpPort: null,
};

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
  } catch (e) {
    /* no-op */
  }
}

function canUseOffscreen() {
  return !!(chrome.offscreen && chrome.offscreen.createDocument);
}

async function hasOffscreenDocument() {
  return await chrome.offscreen.hasDocument?.();
}

async function ensureOffscreenDocument() {
  if (!canUseOffscreen()) {
    throw new Error('Offscreen API is not available');
  }
  const existing = await hasOffscreenDocument();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.',
  });
}

async function closeOffscreenDocumentIfIdle() {
  try {
    if (!canUseOffscreen()) return;
    const existing = await hasOffscreenDocument();
    if (existing && STATE.status === 'IDLE') {
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
    /* no-op */
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
        /* no-op */
      }
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    /* no-op */
  }
}

async function startCDPScreencast(tabId, mode, includeMic, includeSystemAudio, options = {}) {
  if (STATE.status !== 'IDLE') {
    return { ok: false, error: 'Already recording or saving' };
  }

  const storageCheck = await checkStorageQuota();
  if (!storageCheck.ok) {
    return { ok: false, error: storageCheck.error };
  }

  STATE.backend = 'cdpScreencast';
  STATE.mode = mode || 'tab';
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = options.targetTabId || tabId || (await getActiveTabId());
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;
  STATE.isAutomation = !!options.automation;
  STATE.cdpTabId = STATE.overlayTabId;

  await ensureOffscreenDocument();

  const cdpPort = chrome.runtime.connect(undefined, { name: 'cdpScreencast' });
  STATE.cdpPort = cdpPort;

  cdpPort.onMessage.addListener((msg) => {
    if (msg.type === 'CDP_ERROR') {
      logger.error('CDP backend error:', msg.error);
    }
  });

  cdpPort.onDisconnect.addListener(() => {
    logger.log('CDP port disconnected');
    STATE.cdpPort = null;
    if (STATE.status === 'RECORDING') {
      stopRecording();
    }
  });

  cdpPort.postMessage({
    type: 'CDP_START',
    tabId: STATE.cdpTabId,
    recordingId: STATE.recordingId,
    mode: STATE.mode,
    includeAudio: STATE.includeSystemAudio || STATE.includeMic,
  });

  let overlayInjected = false;
  if (STATE.overlayTabId) {
    overlayInjected = await injectOverlay(STATE.overlayTabId);
  }

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected, backend: 'cdpScreencast' };
}

async function startTabCapture(tabId, mode, includeMic, includeSystemAudio, options = {}) {
  if (STATE.status !== 'IDLE') {
    return { ok: false, error: 'Already recording or saving' };
  }

  const storageCheck = await checkStorageQuota();
  if (!storageCheck.ok) {
    return { ok: false, error: storageCheck.error };
  }

  STATE.backend = 'tabCapture';
  STATE.mode = mode || 'tab';
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = options.targetTabId || tabId || (await getActiveTabId());
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;
  STATE.isAutomation = !!options.automation;

  const useOffscreen = !STATE.includeMic && canUseOffscreen();

  if (useOffscreen) {
    await ensureOffscreenDocument();

    let streamId = options.streamId || null;
    if (!streamId && STATE.overlayTabId) {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: STATE.overlayTabId,
        });
        logger.log('Got streamId for tabCapture');
      } catch (e) {
        logger.warn('Failed to get streamId:', e.message);
      }
    }

    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode: STATE.mode,
      includeAudio: STATE.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId,
      streamId: streamId,
    });
    STATE.strategy = 'offscreen';
  } else {
    let streamId = options.streamId || null;
    if (!streamId && STATE.overlayTabId) {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: STATE.overlayTabId,
        });
      } catch (e) {
        logger.warn('Failed to get streamId:', e.message);
      }
    }

    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
        STATE.mode
      )}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}${
        streamId ? '&streamId=' + encodeURIComponent(streamId) : ''
      }`
    );
    const tab = await chrome.tabs.create({ url, active: true });
    STATE.recorderTabId = tab.id ?? null;
    STATE.strategy = 'page';
  }

  let overlayInjected = false;
  if (STATE.overlayTabId) {
    overlayInjected = await injectOverlay(STATE.overlayTabId);
  }

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected, backend: 'tabCapture' };
}

async function startDisplayMedia(tabId, mode, includeMic, includeSystemAudio, options = {}) {
  if (STATE.status !== 'IDLE') {
    return { ok: false, error: 'Already recording or saving' };
  }

  const storageCheck = await checkStorageQuota();
  if (!storageCheck.ok) {
    return { ok: false, error: storageCheck.error };
  }

  STATE.backend = 'displayMedia';
  STATE.mode = mode || 'screen';
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = options.targetTabId || tabId || (await getActiveTabId());
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;
  STATE.isAutomation = !!options.automation;

  const useOffscreen = !STATE.includeMic && canUseOffscreen();

  if (useOffscreen) {
    await ensureOffscreenDocument();

    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode: STATE.mode,
      includeAudio: STATE.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId,
      streamId: null,
    });
    STATE.strategy = 'offscreen';
  } else {
    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
        STATE.mode
      )}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}`
    );
    const tab = await chrome.tabs.create({ url, active: true });
    STATE.recorderTabId = tab.id ?? null;
    STATE.strategy = 'page';
  }

  let overlayInjected = false;
  if (STATE.overlayTabId) {
    overlayInjected = await injectOverlay(STATE.overlayTabId);
  }

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected, backend: 'displayMedia' };
}

async function startRecording(mode, includeMic, includeSystemAudio, options = {}) {
  const backend = options.backend || 'tabCapture';

  if (backend === 'cdpScreencast') {
    return startCDPScreencast(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  } else if (backend === 'displayMedia') {
    return startDisplayMedia(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  } else {
    return startTabCapture(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  }
}

async function stopRecording() {
  if (STATE.status !== 'RECORDING') return { ok: false, error: 'Not recording' };

  STATE.status = 'SAVING';
  await updateBadge();

  try {
    if (STATE.overlayTabId) {
      try {
        await chrome.tabs.sendMessage(STATE.overlayTabId, { type: 'OVERLAY_REMOVE' });
      } catch (e) {
        /* no-op */
      }
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {
    /* no-op */
  }

  if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
  STATE.stopTimeoutId = setTimeout(async () => {
    logger.error(`Save timeout reached (${STOP_TIMEOUT_MS / 1000}s) - forcing reset`);
    await resetRecordingState();
  }, STOP_TIMEOUT_MS);

  try {
    if (STATE.backend === 'cdpScreencast' && STATE.cdpPort) {
      STATE.cdpPort.postMessage({ type: 'CDP_STOP' });
      STATE.cdpPort.disconnect();
      STATE.cdpPort = null;
    } else if (STATE.strategy === 'page') {
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

  STATE.status = 'IDLE';
  await updateBadge();

  try {
    if (STATE.overlayTabId) {
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {
    /* no-op */
  }

  try {
    if (STATE.recorderTabId) {
      await chrome.tabs.remove(STATE.recorderTabId);
    }
  } catch (e) {
    /* no-op */
  }

  if (STATE.cdpPort) {
    try {
      STATE.cdpPort.disconnect();
    } catch (e) {
      /* no-op */
    }
    STATE.cdpPort = null;
  }

  STATE.backend = null;
  STATE.mode = null;
  STATE.overlayTabId = null;
  STATE.includeMic = false;
  STATE.includeSystemAudio = false;
  STATE.recorderTabId = null;
  STATE.strategy = null;
  STATE.isAutomation = false;
  STATE.cdpTabId = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    logger.warn('Ignoring message from unauthorized sender:', sender.id);
    sendResponse({ ok: false, error: 'Unauthorized sender' });
    return;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'START': {
          const res = await startRecording(message.mode, message.mic, message.systemAudio, {
            streamId: message.streamId || null,
            targetTabId: message.targetTabId || null,
            backend: message.backend || 'tabCapture',
          });
          sendResponse(res);
          break;
        }
        case 'STOP': {
          const res = await stopRecording();
          sendResponse(res);
          break;
        }
        case 'CONTROLLER_START': {
          const res = await startRecording(message.mode, false, false, {
            targetTabId: message.targetTabId || null,
            backend: message.backend || 'tabCapture',
            automation: true,
          });
          sendResponse(res);
          break;
        }
        case 'CONTROLLER_STOP': {
          const res = await stopRecording();
          sendResponse(res);
          break;
        }
        case 'CONTROLLER_STATE': {
          sendResponse({
            ...STATE,
            recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING',
            mic: STATE.includeMic,
            systemAudio: STATE.includeSystemAudio,
          });
          break;
        }
        case 'OFFSCREEN_STARTED': {
          sendResponse({ ok: true });
          break;
        }
        case 'OFFSCREEN_DATA': {
          const { recordingId } = message;
          logger.log('Received OFFSCREEN_DATA:', { recordingId, isAutomation: STATE.isAutomation });
          await resetRecordingState();
          if (!STATE.isAutomation) {
            const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
            await chrome.tabs.create({ url });
          }
          await closeOffscreenDocumentIfIdle();
          sendResponse({ ok: true });
          break;
        }
        case 'RECORDER_DATA': {
          const { recordingId } = message;
          logger.log('Received RECORDER_DATA:', { recordingId, isAutomation: STATE.isAutomation });
          await resetRecordingState();
          if (!STATE.isAutomation) {
            const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
            await chrome.tabs.create({ url });
          }
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
          sendResponse({ ok: true });
          break;
        }
        case 'OFFSCREEN_ERROR': {
          logger.error('Received OFFSCREEN_ERROR:', message.error);
          await resetRecordingState();
          sendResponse({ ok: false, error: message.error });
          break;
        }
        case 'GET_STATE': {
          sendResponse({
            ...STATE,
            recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING',
            mic: STATE.includeMic,
            systemAudio: STATE.includeSystemAudio,
          });
          break;
        }
        case 'OFFSCREEN_TEST': {
          sendResponse({ ok: true, message: 'Test successful' });
          break;
        }
        case 'GET_LAST_RECORDING_ID': {
          sendResponse({ ok: true, recordingId: STATE.recordingId });
          break;
        }
        case 'CDP_FINISHED': {
          const { recordingId } = message;
          logger.log('CDP recording finished:', recordingId);
          await resetRecordingState();
          if (!STATE.isAutomation) {
            const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
            await chrome.tabs.create({ url });
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e) {
      logger.error('Error handling message', message.type, e);
      try {
        sendResponse({ ok: false, error: String(e) });
      } catch (e2) {
        /* no-op */
      }
    }
  })();
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  logger.log('External message received:', message.type, 'from:', sender.id);

  const allowedIds = [];
  if (allowedIds.length > 0 && !allowedIds.includes(sender.id)) {
    logger.warn('Ignoring external message from unauthorized sender:', sender.id);
    return;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'START': {
          const res = await startRecording(message.mode, message.mic, message.systemAudio, {
            backend: message.backend || 'tabCapture',
            automation: true,
          });
          sendResponse(res);
          break;
        }
        case 'STOP': {
          const res = await stopRecording();
          sendResponse(res);
          break;
        }
        case 'GET_LAST_RECORDING_ID': {
          sendResponse({ ok: true, recordingId: STATE.recordingId });
          break;
        }
        case 'GET_STATE': {
          sendResponse({
            ...STATE,
            recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING',
            mic: STATE.includeMic,
            systemAudio: STATE.includeSystemAudio,
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      logger.error('Error handling external message', message.type, e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await updateBadge();
  try {
    await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
  } catch (e) {
    logger.error('Cleanup failed:', e);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
  } catch (e) {
    logger.error('Cleanup failed:', e);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  logger.log('Extension icon clicked on tab:', tab.id);

  if (STATE.status === 'RECORDING') {
    await stopRecording();
  } else if (STATE.status === 'IDLE') {
    STATE.backend = 'tabCapture';
    STATE.mode = 'tab';
    STATE.recordingId = crypto.randomUUID();
    STATE.overlayTabId = tab.id;
    STATE.includeMic = false;
    STATE.includeSystemAudio = false;
    STATE.isAutomation = false;

    const useOffscreen = canUseOffscreen();

    if (useOffscreen) {
      await ensureOffscreenDocument();

      let streamId = null;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: tab.id,
        });
        logger.log('Got streamId via action.onClicked');
      } catch (e) {
        logger.warn('Failed to get streamId:', e.message);
      }

      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_START',
        mode: 'tab',
        includeAudio: false,
        recordingId: STATE.recordingId,
        targetTabId: tab.id,
        streamId: streamId,
      });
      STATE.strategy = 'offscreen';
    }

    STATE.status = 'RECORDING';
    await updateBadge();
    logger.log('Recording started via action click');
  }
});
