import { finishRecording, RECORDING_STATUS } from '../lib/recording.js';
import { createLogger } from '../logger.js';
import {
  createMediaRecorder,
  applyContentHints,
  combineStreams,
  setupAutoStop,
  CHUNK_INTERVAL_MS,
} from '../lib/media-recorder-utils.js';
import { createError, CODES } from '../error-codes.js';

const logger = createLogger('Recorder');

// Global error handlers
globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

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

async function notifyRecorderStartError(captureError, isPermissionDenied) {
  try {
    const payload = createError(
      isPermissionDenied ? CODES.SCREEN_PERMISSION_DENIED : CODES.SCREEN_PERMISSION_CANCELLED,
      isPermissionDenied
        ? 'Screen capture permission was denied. Please allow access and try again.'
        : 'Failed to start screen capture: ' + (captureError.message || captureError),
      captureError.message || String(captureError)
    );
    await chrome.runtime.sendMessage({
      type: 'RECORDER_ERROR',
      error: payload,
      recordingId,
    });
  } catch (sendErr) {
    logger.error('Failed to send RECORDER_ERROR to background:', sendErr);
  }
}

async function requestDisplayStream(wantSys, status, startBtn) {
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: wantSys, // only ask for system audio if requested
    });
  } catch (captureError) {
    const isPermissionDenied =
      captureError.name === 'NotAllowedError' || captureError.name === 'AbortError';
    if (isPermissionDenied) {
      alert(
        'CaptureCast: Screen capture permission was denied. Please allow access and try again.'
      );
      status.textContent = 'Screen capture permission denied.';
    } else {
      alert(
        'CaptureCast: Failed to start screen capture: ' + (captureError.message || captureError)
      );
      status.textContent = 'Failed to capture screen: ' + captureError.message;
    }
    await notifyRecorderStartError(captureError, isPermissionDenied);
    logger.error('getDisplayMedia failed:', captureError);
    startBtn.classList.remove('hidden');
    return null;
  }
}

/**
 * Attempt to save partial recording data before unload
 */
function attemptPartialSave() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    logger.log('Attempting partial save before unload');
    try {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.requestData();
      }
      mediaRecorder.stop();
    } catch (err) {
      logger.warn('Partial save failed:', err);
    }
  }
}

// Save partial data on unexpected document close
globalThis.addEventListener('beforeunload', attemptPartialSave);

async function start() {
  const _mode = getQueryParam('mode') || 'tab';
  void _mode;
  recordingId = getQueryParam('id');
  const wantMic = getQueryParam('mic') === '1';
  const wantSys = getQueryParam('sys') === '1';

  const status = document.getElementById('status');
  const preview = document.getElementById('preview');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');

  if (!status || !preview || !startBtn || !stopBtn) {
    logger.error('Required DOM elements not found');
    alert('CaptureCast: Recorder page failed to load properly. Please close and try again.');
    return;
  }

  try {
    // Validate recording ID
    if (!recordingId || !isValidUUID(recordingId)) {
      throw new Error('Invalid recording ID');
    }

    status.textContent = 'Requesting screen capture…';
    startBtn.classList.add('hidden');
    // 1. Request screen share (requires user gesture, if auto-start fails this needs a button click)
    const displayStream = await requestDisplayStream(wantSys, status, startBtn);
    if (!displayStream) return;

    // Apply content hints to screen stream
    applyContentHints(displayStream, { hasSystemAudio: wantSys });

    // 2. Request microphone separately if needed
    let micStream = null;
    if (wantMic) {
      status.textContent = 'Requesting microphone…';
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // Apply content hints for voice
        applyContentHints(micStream, { hasMicrophone: true });
        logger.log('Microphone stream obtained.');
      } catch (e) {
        logger.warn('Mic request failed, proceeding without mic:', e);
        const isMicDenied = e.name === 'NotAllowedError' || e.name === 'NotFoundError';
        const micMsg = isMicDenied
          ? 'Microphone permission denied. Recording without mic.'
          : 'Microphone request failed. Recording without mic.';
        alert('CaptureCast: ' + micMsg);
        status.textContent = micMsg;
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
      onStop: async (mimeType, duration, totalSize, extra) => {
        const failedChunks = extra?.failedChunks ?? 0;
        let status = RECORDING_STATUS.SAVED;

        try {
          // Determine recording status based on chunk save results
          if (failedChunks > 0) {
            status = failedChunks > 5 ? RECORDING_STATUS.FAILED : RECORDING_STATUS.PARTIAL;
            logger.warn(`Recording finished with ${failedChunks} failed chunks, status: ${status}`);
          }

          // Finish recording in DB
          await finishRecording(recordingId, mimeType, duration, totalSize, status);
          logger.log('Finished recording in DB');

          await chrome.runtime.sendMessage({
            type: 'RECORDER_DATA',
            recordingId,
            mimeType,
          });
        } catch (dbError) {
          logger.error('Failed to finish recording in DB:', dbError);
          const structuredError = createError(
            CODES.SAVE_FAILED,
            'Failed to save recording',
            dbError.message || String(dbError)
          );
          await chrome.runtime.sendMessage({
            type: 'RECORDER_ERROR',
            error: structuredError,
            recordingId,
          });
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
      },
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
    const details =
      e && typeof e === 'object' ? `${e.name || 'DOMException'}: ${e.message || e}` : String(e);
    status.textContent =
      'Failed to start: ' + details + '. Ensure this tab is focused and click Start again.';
    logger.error('start failed:', {
      name: e?.name,
      message: e?.message,
      toString: e?.toString?.(),
    });
    alert('CaptureCast: Recording failed to start — ' + details);
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

  // Auto-start recording (mic mode is triggered from popup → background)
  const startBtn = document.getElementById('start');
  startBtn.classList.add('hidden');
  start().catch((err) => {
    // If auto-start fails (e.g., user gesture required), show the button
    startBtn.classList.remove('hidden');
    document.getElementById('status').textContent = 'Auto-start failed. Click Start to begin.';
    logger.error('Auto-start failed:', err);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'RECORDER_STOP') {
    return false;
  }

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
