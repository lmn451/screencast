import { createLogger } from './logger.js';

const logger = createLogger('Popup');

// Global error handlers
globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

async function getState() {
  return await chrome.runtime.sendMessage({ type: 'GET_STATE' });
}

function setUi(recording) {
  document.getElementById('idle-ui').style.display = recording ? 'none' : 'flex';
  document.getElementById('rec-ui').style.display = recording ? 'flex' : 'none';
}

async function start(mode) {
  const mic = document.getElementById('mic-toggle')?.checked ?? false;
  const systemAudio = document.getElementById('sys-toggle')?.checked ?? false;
  
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTabId = tab?.id;
  
  // Get streamId directly (preserves user gesture context)
  let streamId = null;
  if (mode === 'tab' && targetTabId) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: targetTabId
      });
      logger.log('Got streamId from popup:', streamId ? 'yes' : 'no');
    } catch (e) {
      logger.warn('Failed to get streamId:', e.message);
    }
  }
  
  const res = await chrome.runtime.sendMessage({
    type: 'START',
    mode,
    mic,
    systemAudio,
    streamId: streamId, // Pass streamId to background
    targetTabId: targetTabId,
  });
  
  if (!res?.ok) {
    alert(res?.error || 'Failed to start recording');
  } else {
    setUi(true);
    window.close();
  }
}

async function stop() {
  const res = await chrome.runtime.sendMessage({ type: 'STOP' });
  if (!res?.ok) alert(res?.error || 'Failed to stop recording');
  else window.close();
}

(async () => {
  const state = await getState();
  setUi(state.recording);
  document.getElementById('btn-tab').addEventListener('click', () => start('tab'));
  document.getElementById('btn-stop').addEventListener('click', stop);
  document.getElementById('btn-view-recordings').addEventListener('click', () => {
    chrome.tabs.create({ url: 'recordings.html' });
  });
})();
