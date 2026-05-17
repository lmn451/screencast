import { createLogger } from '../logger.js';

const logger = createLogger('Popup');

// Global error handlers
globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

async function getState() {
  try {
    return await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  } catch (e) {
    logger.error('Failed to get state from background:', e);
    alert('CaptureCast: Unable to communicate with the extension. Try reloading.');
    return null;
  }
}

function setUi(recording) {
  const idleUi = document.getElementById('idle-ui');
  const recUi = document.getElementById('rec-ui');
  if (!idleUi || !recUi) {
    logger.error('Popup UI elements not found');
    return;
  }
  idleUi.style.display = recording ? 'none' : 'flex';
  recUi.style.display = recording ? 'flex' : 'none';
}

async function start(mode) {
  try {
    const micEl = document.getElementById('opt-mic');
    const sysEl = document.getElementById('opt-sys');
    const mic = micEl instanceof HTMLInputElement && micEl.checked;
    const sys = sysEl instanceof HTMLInputElement && sysEl.checked;
    const params = new URLSearchParams({
      mode,
      mic: mic ? 'true' : 'false',
      sys: sys ? 'true' : 'false',
    });
    window.location.href = `consent.html?${params.toString()}`;
  } catch (e) {
    logger.error('Failed to navigate to consent page:', e);
    alert('CaptureCast: Failed to open recording consent page.');
  }
}

async function stop() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'STOP' });
    if (!res?.ok) {
      logger.error('Failed to stop recording:', res?.error);
      alert('CaptureCast: Failed to stop recording: ' + (res?.error || 'Unknown error'));
    }
  } catch (e) {
    logger.error('Failed to send stop message:', e);
    alert('CaptureCast: Could not stop recording. The extension may need to be reloaded.');
  }
  window.close();
}

(async () => {
  try {
    const state = await getState();
    if (!state) {
      // getState already alerted the user
      setUi(false);
      return;
    }
    setUi(state.recording);

    const btnRecord = document.getElementById('btn-record');
    const btnStop = document.getElementById('btn-stop');
    const btnViewRecordings = document.getElementById('btn-view-recordings');

    if (btnRecord) {
      btnRecord.addEventListener('click', () => start('tab'));
    }
    if (btnStop) {
      btnStop.addEventListener('click', stop);
    }
    if (btnViewRecordings) {
      btnViewRecordings.addEventListener('click', () => {
        try {
          chrome.tabs.create({ url: 'recordings.html' });
        } catch (e) {
          logger.error('Failed to open recordings page:', e);
          alert('CaptureCast: Failed to open recordings page.');
        }
      });
    }
  } catch (e) {
    logger.error('Popup initialization failed:', e);
    alert('CaptureCast: Popup failed to initialize. Please try again.');
  }
})();
