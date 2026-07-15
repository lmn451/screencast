import { finishRecording, createRecordingStub, RECORDING_STATUS } from '../lib/recording.js';
import { createLogger } from '../logger.js';
import {
  createMediaRecorder,
  applyContentHints,
  setupAutoStop,
  CHUNK_INTERVAL_MS,
} from '../lib/media-recorder-utils.js';
import { createError, CODES } from '../error-codes.js';
import { openDB } from '../lib/db-shared.js';

// Offscreen document script to handle getDisplayMedia + MediaRecorder

const logger = createLogger('Offscreen');

// Global error handlers
globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

logger.log('Document loaded and script executing');

// Test if we can send a message back to background
(async () => {
  try {
    logger.log('Testing message communication...');
    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_TEST',
    });
    logger.log('Test message response:', response);
  } catch (error) {
    logger.error('Test message failed:', error);
  }

  // Test DB access
  try {
    logger.log('Testing IndexedDB access...');
    const db = await openDB();
    logger.log('IndexedDB open success');
    db.close();
  } catch (e) {
    logger.error('IndexedDB open failed:', e);
  }
})();

let mediaStream = null;
let mediaRecorder = null;
let currentId = null;

/**
 * Attempt to save partial recording data before unload.
 * Best-effort only: `beforeunload` is not guaranteed to run/complete before the
 * document is torn down. Real durability comes from the 1s periodic chunk saves
 * and the start-time metadata stub, not from this handler.
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

function getConstraintsFromMode(mode, includeAudio) {
  // For now, mode is informative only; actual selection (tab/window/screen)
  // is performed by the browser's picker. Constraints can diverge by mode later.
  return {
    video: true,
    audio: includeAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false,
  };
}

async function startCapture(mode, recordingId, includeAudio) {
  if (mediaRecorder) throw new Error('Already recording');
  currentId = recordingId;

  logger.log('Starting capture with mode:', mode, 'includeAudio:', includeAudio);

  try {
    logger.log('Requesting display media with audio:', includeAudio);
    const displayStream = await navigator.mediaDevices.getDisplayMedia(
      getConstraintsFromMode(mode, includeAudio)
    );

    // Apply content hints for encoder optimization
    applyContentHints(displayStream, { hasSystemAudio: includeAudio });

    logger.log('Got display stream:', {
      id: displayStream.id,
      active: displayStream.active,
      videoTracks: displayStream.getVideoTracks().length,
      audioTracks: displayStream.getAudioTracks().length,
    });

    mediaStream = displayStream;

    // Create recorder with standard handlers
    const { recorder } = createMediaRecorder(mediaStream, currentId, {
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
          await finishRecording(currentId, mimeType, duration, totalSize, status);
          logger.log('Finished recording in DB');

          // Send data to background script
          try {
            const response = await chrome.runtime.sendMessage({
              type: 'OFFSCREEN_DATA',
              recordingId: currentId,
              mimeType: mimeType,
            });
            logger.log('OFFSCREEN_DATA response:', response);
          } catch (error) {
            logger.error('Failed to send OFFSCREEN_DATA:', error);
          }
        } catch (dbError) {
          logger.error('Failed to finish recording in DB:', dbError);
          const structuredError = createError(
            CODES.SAVE_FAILED,
            'Failed to save recording',
            dbError.message || String(dbError)
          );
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_ERROR',
            error: structuredError,
            code: CODES.SAVE_FAILED,
            recordingId: currentId,
          });
          throw dbError;
        } finally {
          cleanup();
        }
      },
      onError: (e) => {
        logger.error('MediaRecorder error:', e);
      },
    });

    mediaRecorder = recorder;

    // Write the start-time metadata stub now that the mimeType/codec is known,
    // so a mid-recording crash still leaves a recoverable row. Non-fatal on failure.
    try {
      await createRecordingStub(currentId, recorder.mimeType);
    } catch (stubErr) {
      logger.warn('Failed to write recording stub (non-fatal):', stubErr);
    }

    // Auto-stop when screen sharing ends
    setupAutoStop(mediaStream, mediaRecorder);

    mediaRecorder.start(CHUNK_INTERVAL_MS);
    try {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED' });
    } catch (e) {
      logger.warn('Failed to send OFFSCREEN_STARTED message (non-critical):', e);
    }
  } catch (error) {
    logger.error('startCapture failed:', error);
    // Stop any acquired capture tracks and reset state before reporting the error,
    // so a failure in recorder creation/start doesn't leak the screen-share indicator.
    try {
      mediaStream?.getTracks().forEach((t) => t.stop());
    } catch (stopErr) {
      logger.log('Error stopping media stream tracks after failed start (non-fatal):', stopErr);
    }
    cleanup();

    // Notify background about the failure so it can reset state and inform the user
    const isPermissionDenied = error.name === 'NotAllowedError' || error.name === 'AbortError';
    const userMessage = isPermissionDenied
      ? 'Screen capture permission was denied. Please allow access and try again.'
      : 'Failed to start screen capture: ' + (error.message || error);
    try {
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        error: userMessage,
        code: isPermissionDenied ? 'PERMISSION_DENIED' : 'CAPTURE_FAILED',
        recordingId,
      });
    } catch (sendErr) {
      logger.error('Failed to send OFFSCREEN_ERROR to background:', sendErr);
    }
    throw error;
  }
}

function cleanup() {
  try {
    mediaRecorder?.stream?.getTracks().forEach((t) => t.stop());
  } catch (e) {
    logger.log('Error stopping recorder stream tracks (non-fatal):', e);
  }
  try {
    mediaStream?.getTracks().forEach((t) => t.stop());
  } catch (e) {
    logger.log('Error stopping media stream tracks (non-fatal):', e);
  }
  mediaStream = null;
  mediaRecorder = null;
  currentId = null;
}

async function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    logger.log('Stopping MediaRecorder, current state:', mediaRecorder.state);
    // Request any remaining data before stopping
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.requestData();
    }
    mediaRecorder.stop();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type !== 'OFFSCREEN_START' && message.type !== 'OFFSCREEN_STOP') {
    return false;
  }

  (async () => {
    if (message.type === 'OFFSCREEN_START') {
      try {
        logger.log('Received START message:', message);
        await startCapture(message.mode, message.recordingId, message.includeAudio);
        logger.log('startCapture completed successfully');
        sendResponse({ ok: true });
      } catch (e) {
        logger.error('startCapture failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (message.type === 'OFFSCREEN_STOP') {
      try {
        logger.log('Received STOP message');
        await stopCapture();
        logger.log('stopCapture completed');
        sendResponse({ ok: true });
      } catch (e) {
        logger.error('stopCapture failed:', e);
        sendResponse({ ok: false, error: 'Failed to stop capture: ' + (e.message || e) });
      }
    }
  })();
  return true;
});
