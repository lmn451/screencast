import { finishRecording, createRecordingStub, RECORDING_STATUS } from '../lib/recording.js';
import { createLogger } from '../logger.js';
import {
  createMediaRecorder,
  applyContentHints,
  setupAutoStop,
  getDisplayVideoConstraints,
  CHUNK_INTERVAL_MS,
  BEST_QUALITY_VIDEO_BITS_PER_SECOND,
} from '../lib/media-recorder-utils.js';
import { createError, CODES } from '../error-codes.js';
import { openDB } from '../lib/db-shared.js';
import {
  MSG_OFFSCREEN_TEST,
  MSG_OFFSCREEN_STARTED,
  MSG_OFFSCREEN_DATA,
  MSG_OFFSCREEN_ERROR,
  MSG_OFFSCREEN_START,
  MSG_OFFSCREEN_STOP,
  MSG_HEARTBEAT,
  buildMessage,
} from '../messages.js';

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
    const response = await chrome.runtime.sendMessage(buildMessage(MSG_OFFSCREEN_TEST));
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
let heartbeatTimer = null;

// Heartbeat cadence. MV3 terminates the background service worker after ~30s
// of inactivity, which wipes its in-memory recording state even though this
// offscreen document keeps capturing. Pinging every 20s keeps the SW awake for
// the whole recording and doubles as the post-restart session-recovery trigger.
const HEARTBEAT_INTERVAL_MS = 20_000;

function startHeartbeat(recordingId) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    chrome.runtime.sendMessage(buildMessage(MSG_HEARTBEAT, { recordingId })).catch((error) => {
      logger.warn('Heartbeat send failed (non-fatal):', error);
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

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

function getConstraintsFromMode(mode, includeAudio, bestQuality) {
  // For now, mode is informative only; actual selection (tab/window/screen)
  // is performed by the browser's picker. Constraints can diverge by mode later.
  return {
    video: getDisplayVideoConstraints(bestQuality),
    audio: includeAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false,
  };
}

async function startCapture(mode, recordingId, includeAudio, bestQuality = false) {
  if (mediaRecorder) throw new Error('Already recording');
  currentId = recordingId;

  logger.log('Starting capture with mode:', mode, { includeAudio, bestQuality });

  try {
    logger.log('Requesting display media with audio:', includeAudio);
    const displayStream = await navigator.mediaDevices.getDisplayMedia(
      getConstraintsFromMode(mode, includeAudio, bestQuality)
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
    const recorderCallbacks = {
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
            const response = await chrome.runtime.sendMessage(
              buildMessage(MSG_OFFSCREEN_DATA, {
                recordingId: currentId,
                mimeType: mimeType,
              })
            );
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
          chrome.runtime.sendMessage(
            buildMessage(MSG_OFFSCREEN_ERROR, {
              error: structuredError,
              code: CODES.SAVE_FAILED,
              recordingId: currentId,
            })
          );
          throw dbError;
        } finally {
          cleanup();
        }
      },
      onError: (e) => {
        logger.error('MediaRecorder error:', e);
      },
    };
    const recordingOptions = {
      videoBitsPerSecond: bestQuality ? BEST_QUALITY_VIDEO_BITS_PER_SECOND : undefined,
    };
    const { recorder } = createMediaRecorder(
      mediaStream,
      currentId,
      recorderCallbacks,
      recordingOptions
    );

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
    startHeartbeat(currentId);
    try {
      await chrome.runtime.sendMessage(
        buildMessage(MSG_OFFSCREEN_STARTED, { recordingId: currentId })
      );
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

    // Notify background about the failure so it can reset state and inform the
    // user. The error must be a structured createError payload: the schema for
    // OFFSCREEN_ERROR requires `error` to be an object, and the background's
    // strict validation silently rejected the previous bare-string form —
    // leaving the machine stuck in `starting` after a denied permission.
    const isPermissionDenied = error.name === 'NotAllowedError' || error.name === 'AbortError';
    const userMessage = isPermissionDenied
      ? 'Screen capture permission was denied. Please allow access and try again.'
      : 'Failed to start screen capture: ' + (error.message || error);
    try {
      await chrome.runtime.sendMessage(
        buildMessage(MSG_OFFSCREEN_ERROR, {
          error: createError(
            isPermissionDenied ? CODES.SCREEN_PERMISSION_DENIED : CODES.SCREEN_PERMISSION_CANCELLED,
            userMessage,
            error.message || String(error)
          ),
          code: isPermissionDenied ? 'PERMISSION_DENIED' : 'CAPTURE_FAILED',
          recordingId,
        })
      );
    } catch (sendErr) {
      logger.error('Failed to send OFFSCREEN_ERROR to background:', sendErr);
    }
    throw error;
  }
}

function cleanup() {
  stopHeartbeat();
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
  if (message.type !== MSG_OFFSCREEN_START && message.type !== MSG_OFFSCREEN_STOP) {
    return false;
  }

  (async () => {
    if (message.type === MSG_OFFSCREEN_START) {
      try {
        logger.log('Received START message:', message);
        await startCapture(
          message.mode,
          message.recordingId,
          message.includeAudio,
          message.bestQuality === true
        );
        logger.log('startCapture completed successfully');
        sendResponse({ ok: true });
      } catch (e) {
        logger.error('startCapture failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (message.type === MSG_OFFSCREEN_STOP) {
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
