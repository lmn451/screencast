import { finishRecording } from './db.js';
import { createLogger } from './logger.js';
import {
  createMediaRecorder,
  applyContentHints,
  combineStreams,
  setupAutoStop,
  CHUNK_INTERVAL_MS,
} from './media-recorder-utils.js';

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

async function start() {
  // Mode is determined by silent parameter, not URL mode param
  // const _mode = getQueryParam('mode') || 'tab'; // Reserved for future use
  recordingId = getQueryParam('id');
  const wantMic = getQueryParam('mic') === '1';
  const wantSys = getQueryParam('sys') === '1';
  const silent = getQueryParam('silent') === '1';
  const streamId = getQueryParam('streamId') || null;

  const status = document.getElementById('status');
  const preview = document.getElementById('preview');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');

  try {
    // Validate recording ID
    if (!recordingId || !isValidUUID(recordingId)) {
      throw new Error('Invalid recording ID');
    }

    status.textContent = silent ? 'Starting silent capture…' : 'Requesting screen capture…';
    startBtn.classList.add('hidden');

    let captureStream;
    if (silent) {
      logger.log('Using tabCapture for silent recording');
      try {
        if (streamId) {
          logger.log('Using streamId from URL params for tab capture');
          captureStream = await navigator.mediaDevices.getUserMedia({
            video: {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
              },
            },
            audio:
              wantSys || wantMic
                ? {
                    mandatory: {
                      chromeMediaSource: 'tab',
                      chromeMediaSourceId: streamId,
                    },
                  }
                : false,
          });
          logger.log('Tab capture via streamId succeeded in recorder');
        } else {
          logger.log('No streamId available, using chrome.tabCapture.capture()');
          const tracks = [];
          const videoTrack = await new Promise((resolve, reject) => {
            chrome.tabCapture.capture({ video: true, audio: wantSys || wantMic }, (stream) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(stream?.getVideoTracks()[0] ?? null);
              }
            });
          });

          if (!videoTrack) {
            throw new Error('Tab capture failed: no video track available');
          }
          tracks.push(videoTrack);

          const audioTrack = tracks[0].clone();
          const audioStream = new MediaStream([audioTrack]);
          captureStream = audioStream;
          if (captureStream.getAudioTracks().length > 0) {
            captureStream = new MediaStream([videoTrack, ...captureStream.getAudioTracks()]);
          } else {
            captureStream = new MediaStream([videoTrack]);
          }

          logger.log('Tab capture succeeded in recorder');
        }
      } catch (tabCaptureError) {
        logger.warn(
          'Tab capture failed, falling back to getDisplayMedia:',
          tabCaptureError.message
        );
        captureStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: wantSys
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              }
            : false,
        });
      }
    } else {
      captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: wantSys
          ? {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            }
          : false,
      });
    }

    // Apply content hints for encoder optimization
    applyContentHints(captureStream, { hasSystemAudio: wantSys, hasMicrophone: false });

    let micStream = null;
    if (wantMic) {
      try {
        status.textContent = 'Requesting microphone…';
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        // Apply content hints for encoder optimization
        applyContentHints(micStream, { hasSystemAudio: wantSys, hasMicrophone: true });
      } catch (e) {
        logger.warn('Mic request failed, proceeding without mic:', e);
      }
    }

    mediaStream = combineStreams({ displayStream: captureStream, micStream });
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
