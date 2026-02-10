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
  const res = await chrome.runtime.sendMessage({
    type: 'START',
    mode,
    mic,
    systemAudio,
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
