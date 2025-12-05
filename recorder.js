import { finishRecording } from './db.js';
import { createLogger } from './logger.js';
import {
  createMediaRecorder,
  applyContentHints,
  combineStreams,
  setupAutoStop,
  CHUNK_INTERVAL_MS
} from './media-recorder-utils.js';

const logger = createLogger('Recorder');

function getQueryParam(name) {
  const url = new URL(location.href);
  return url.searchParams.get(name);
}

// Validate UUID format for security
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

let mediaStream = null;
let mediaRecorder = null;
let recordingId = null;

async function start() {
  const mode = getQueryParam('mode') || 'tab';
  recordingId = getQueryParam('id');
  const wantMic = getQueryParam('mic') === '1';
  const wantSys = getQueryParam('sys') === '1';

  const status = document.getElementById('status');
  const preview = document.getElementById('preview');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');

  try {
    // Validate recording ID
    if (!recordingId || !isValidUUID(recordingId)) {
      throw new Error('Invalid recording ID');
    }

    status.textContent = 'Requesting screen capture…';
    startBtn.classList.add('hidden');
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: wantSys ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });

    // Apply content hints for encoder optimization
    applyContentHints(displayStream, { hasSystemAudio: wantSys });

    let micStream = null;
    if (wantMic) {
      try {
        status.textContent = 'Requesting microphone…';
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        // Apply content hints for encoder optimization
        applyContentHints(micStream, { hasMicrophone: true });
      } catch (e) {
        logger.warn('Mic request failed, proceeding without mic:', e);
      }
    }

    mediaStream = combineStreams({ displayStream, micStream });
    preview.srcObject = mediaStream;
    preview.classList.remove('hidden');
    stopBtn.classList.remove('hidden');

    // Create recorder with standard handlers
    const { recorder } = createMediaRecorder(mediaStream, recordingId, {
      onStart: () => {
        logger.log('Recording started');
      },
      onStop: async (mimeType, duration, totalSize) => {
        try {
          // Finish recording in DB
          await finishRecording(recordingId, mimeType, duration, totalSize);
          logger.log('Finished recording in DB');

          await chrome.runtime.sendMessage({
            type: 'RECORDER_DATA',
            recordingId,
            mimeType,
          });
        } catch (dbError) {
          logger.error('Failed to finish recording in DB:', dbError);
          alert('Failed to save recording: ' + dbError.message);
          return;
        } finally {
          try {
            mediaStream?.getTracks().forEach((t) => t.stop());
          } catch (e) {
            logger.log('Error stopping tracks (non-fatal):', e);
          }
          window.close();
        }
      },
      onError: (e) => {
        logger.error('MediaRecorder error:', e);
      }
    });

    mediaRecorder = recorder;

    // Auto-stop when screen sharing ends
    setupAutoStop(mediaStream, mediaRecorder);

    mediaRecorder.start(CHUNK_INTERVAL_MS);
    try {
      await chrome.runtime.sendMessage({ type: 'RECORDER_STARTED' });
    } catch (e) {
      logger.warn('Failed to send RECORDER_STARTED message, continuing anyway:', e);
    }
    status.textContent = 'Recording…';
    stopBtn.focus();
  } catch (e) {
    const details = e && typeof e === 'object' ? `${e.name || 'DOMException'}: ${e.message || e}` : String(e);
    status.textContent = 'Failed to start: ' + details + '. Ensure this tab is focused and click Start again.';
    logger.error('start failed:', { name: e?.name, message: e?.message, toString: e?.toString?.() });
    startBtn.classList.remove('hidden');
  }
}

async function stop() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    if (mediaRecorder.state === 'recording') mediaRecorder.requestData();
    mediaRecorder.stop();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('start').addEventListener('click', start, { once: false });
  document.getElementById('stop').addEventListener('click', stop);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'RECORDER_STOP') {
      try {
        await stop();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    }
  })();
  return true;
});

