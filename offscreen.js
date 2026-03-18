import { finishRecording } from './db.js';
import { createLogger } from './logger.js';
import {
  createMediaRecorder,
  applyContentHints,
  setupAutoStop,
  CHUNK_INTERVAL_MS,
} from './media-recorder-utils.js';

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
    const request = indexedDB.open('CaptureCastDB', 2); // Use correct DB name and version
    request.onerror = () => logger.error('IndexedDB open failed:', request.error);
    request.onsuccess = () => logger.log('IndexedDB open success');
  } catch (e) {
    logger.error('IndexedDB threw error:', e);
  }
})();

let mediaStream = null;
let mediaRecorder = null;
let currentId = null;

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

async function startCapture(mode, recordingId, includeAudio, silent = false) {
  if (mediaRecorder) throw new Error('Already recording');
  currentId = recordingId;

  logger.log('Starting capture with mode:', mode, 'includeAudio:', includeAudio, 'silent:', silent);

  let stream;
  try {
    if (silent) {
      logger.log('Using tabCapture for silent recording');
      try {
        const [videoTrack, audioTrack] = await new Promise((resolve, reject) => {
          chrome.tabCapture.capture({ video: true, audio: includeAudio || false }, (stream) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(
                stream ? [stream.getVideoTracks()[0], stream.getAudioTracks()[0]] : [null, null]
              );
            }
          });
        });

        if (!videoTrack) {
          throw new Error('Tab capture failed: no video track available');
        }

        const tracks = [videoTrack];
        if (audioTrack) tracks.push(audioTrack);
        stream = new MediaStream(tracks);

        logger.log('Tab capture succeeded:', {
          videoTrack: !!videoTrack,
          audioTrack: !!audioTrack,
        });
      } catch (tabCaptureError) {
        logger.warn(
          'Tab capture failed, falling back to getDisplayMedia:',
          tabCaptureError.message
        );
        stream = await navigator.mediaDevices.getDisplayMedia(
          getConstraintsFromMode(mode, includeAudio)
        );
      }
    } else {
      logger.log('Requesting display media with audio:', includeAudio);
      stream = await navigator.mediaDevices.getDisplayMedia(
        getConstraintsFromMode(mode, includeAudio)
      );
    }

    // Apply content hints for encoder optimization
    applyContentHints(stream, { hasSystemAudio: includeAudio, hasMicrophone: false });

    logger.log('Got capture stream:', {
      active: stream.active,
      videoTracks: stream.getVideoTracks().length,
      audioTracks: stream.getAudioTracks().length,
    });

    mediaStream = stream;
  } catch (error) {
    logger.error('Capture failed:', error);
    throw error;
  }

  // Create recorder with standard handlers
  const { recorder } = createMediaRecorder(mediaStream, currentId, {
    onStart: () => {
      logger.log('Recording started');
    },
    onStop: async (mimeType, duration, totalSize) => {
      try {
        // Finish recording in DB
        await finishRecording(currentId, mimeType, duration, totalSize);
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
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_ERROR',
          error: 'Failed to save recording: ' + dbError.message,
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

  // Auto-stop when screen sharing ends
  setupAutoStop(mediaStream, mediaRecorder);

  mediaRecorder.start(CHUNK_INTERVAL_MS);
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED' });
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
  (async () => {
    if (message.type === 'OFFSCREEN_START') {
      try {
        logger.log('Received START message:', message);
        await startCapture(message.mode, message.recordingId, message.includeAudio, message.silent);
        logger.log('startCapture completed successfully');
        sendResponse({ ok: true });
      } catch (e) {
        logger.error('startCapture failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (message.type === 'OFFSCREEN_STOP') {
      logger.log('Received STOP message');
      await stopCapture();
      logger.log('stopCapture completed');
      sendResponse({ ok: true });
    }
  })();
  return true;
});
