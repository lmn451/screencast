const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnState = document.getElementById('btnState');

function updateUI(state) {
  statusEl.className = 'status ' + (state.status || 'idle').toLowerCase();
  statusEl.textContent = 'Status: ' + (state.status || 'IDLE');
  outputEl.textContent = JSON.stringify(state, null, 2);

  const isRecording = state.status === 'RECORDING' || state.status === 'SAVING';
  btnStart.disabled = isRecording;
  btnStop.disabled = !isRecording;
}

async function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

async function start() {
  const result = await sendMessage({
    type: 'CONTROLLER_START',
    backend: 'tabCapture',
    mode: 'tab',
    targetTabId: null,
  });
  if (!result.ok) {
    outputEl.textContent = 'Start failed: ' + result.error;
  } else {
    await getState();
  }
}

async function stop() {
  const result = await sendMessage({ type: 'CONTROLLER_STOP' });
  if (!result.ok) {
    outputEl.textContent = 'Stop failed: ' + result.error;
  } else {
    await getState();
  }
}

async function getState() {
  const state = await sendMessage({ type: 'CONTROLLER_STATE' });
  updateUI(state);
}

btnStart.addEventListener('click', start);
btnStop.addEventListener('click', stop);
btnState.addEventListener('click', getState);

getState();
