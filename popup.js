import { createLogger } from './src/logger.js';

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
  // Redirect to consent page with params
  const params = new URLSearchParams({ mode, mic: 'false', sys: 'false' });
  window.location.href = `consent.html?${params.toString()}`;
}

async function stop() {
  const res = await chrome.runtime.sendMessage({ type: 'STOP' });
  if (!res?.ok) {
    logger.error('Failed to stop recording:', res?.error);
  }
  window.close();
}

(async () => {
  const state = await getState();
  setUi(state.recording);
  document.getElementById('btn-record').addEventListener('click', () => start('tab'));
  document.getElementById('btn-stop').addEventListener('click', stop);
  document.getElementById('btn-view-recordings').addEventListener('click', () => {
    chrome.tabs.create({ url: 'recordings.html' });
  });
})();
