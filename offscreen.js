import { finishRecording } from './db.js';
import { createLogger } from './logger.js';

// Force VP8 codec for testing (avoids AV1 green screen issues)
globalThis.__FORCE_VP8__ = true;

import { createMediaRecorder, setupAutoStop, CHUNK_INTERVAL_MS } from './media-recorder-utils.js';

const logger = createLogger('Offscreen');

globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});

logger.log('Offscreen document loaded');

// Long-lived connection to keep offscreen document alive and initialized
let activePort = null;
let pendingResolve = null;

chrome.runtime.onConnect.addListener((port) => {
  logger.log('Offscreen received connection:', port.name);
  activePort = port;

  // Send acknowledgment
  port.postMessage({ status: 'awake', name: port.name });

  // Handle incoming messages
  port.onMessage.addListener((msg) => {
    logger.log('Offscreen received port message:', msg);

    if (msg.command === 'ping') {
      port.postMessage({ status: 'pong' });
    } else if (msg.command === 'wakeup-complete' && pendingResolve) {
      pendingResolve(port);
      pendingResolve = null;
    }
  });

  port.onDisconnect.addListener(() => {
    logger.log('Offscreen port disconnected');
    activePort = null;
  });
});

// Initialize database
(async () => {
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('CaptureCastDB', 3);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    logger.log('IndexedDB initialized successfully');

    // Signal that we're ready
    if (activePort) {
      activePort.postMessage({ status: 'initialized' });
    }
  } catch (e) {
    logger.error('IndexedDB initialization failed:', e);
  }
})();

let mediaStream = null;
let mediaRecorder = null;
let currentId = null;
let canvas = null;
let ctx = null;
let cdpRecordingId = null;

async function startCapture(mode, recordingId, includeAudio, silent = false, streamId = null) {
  if (mediaRecorder) throw new Error('Already recording');
  currentId = recordingId;

  logger.log(
    'Starting capture with mode:',
    mode,
    'includeAudio:',
    includeAudio,
    'silent:',
    silent,
    'streamId:',
    streamId ? 'provided' : 'none'
  );

  let stream;
  try {
    if (silent && streamId) {
      logger.log('Using tabCapture streamId for capture');
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        audio: includeAudio
          ? {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
              },
            }
          : false,
      });
      logger.log('Tab capture via streamId succeeded:', {
        videoTracks: stream.getVideoTracks().length,
        audioTracks: stream.getAudioTracks().length,
      });
    } else {
      logger.log('Using getDisplayMedia (auto-select mode)');
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: includeAudio,
      });
      logger.log('getDisplayMedia succeeded:', {
        videoTracks: stream.getVideoTracks().length,
        audioTracks: stream.getAudioTracks().length,
      });
    }

    mediaStream = stream;
  } catch (error) {
    logger.error('Capture failed:', error);
    throw error;
  }

  const { recorder } = createMediaRecorder(mediaStream, currentId, {
    onStart: () => {
      logger.log('Recording started');
    },
    onStop: async (mimeType, duration, totalSize, stats) => {
      try {
        await finishRecording(currentId, mimeType, duration, totalSize);
        logger.log('Finished recording in DB');

        // If chunks failed to persist, the reassembled file would be
        // corrupt/truncated. Report an error instead of opening a preview
        // that silently shows a broken recording.
        if (stats && stats.saveErrorCount > 0) {
          logger.error(
            `${stats.saveErrorCount} chunks failed to save; reporting corrupt recording.`
          );
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_ERROR',
            error: `Recording may be corrupt: ${stats.saveErrorCount} of ${stats.chunkCount} chunks failed to save.`,
          });
          return;
        }

        try {
          await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_DATA',
            recordingId: currentId,
            mimeType: mimeType,
          });
          logger.log('OFFSCREEN_DATA response sent');
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
  setupAutoStop(mediaStream, mediaRecorder);
  mediaRecorder.start(CHUNK_INTERVAL_MS);
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED' });
}

async function startCDPCapture(recordingId, width, height) {
  if (mediaRecorder) throw new Error('Already recording');
  if (canvas) throw new Error('Already has canvas');

  cdpRecordingId = recordingId;
  currentId = recordingId;

  logger.log('Starting CDP capture:', { recordingId, width, height });

  canvas = document.createElement('canvas');
  canvas.width = width || 1280;
  canvas.height = height || 720;
  ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(30);
  mediaStream = stream;

  const mimeType = 'video/webm;codecs=vp9';
  const recorder = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : undefined,
  });

  let chunkIndex = 0;
  let totalSize = 0;
  let recordingStartTime = 0;

  recorder.onstart = () => {
    recordingStartTime = Date.now();
    logger.log('CDP MediaRecorder started, mimeType:', recorder.mimeType);
  };

  recorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) {
      try {
        totalSize += e.data.size;
        const { saveChunk } = await import('./db.js');
        await saveChunk(recordingId, e.data, chunkIndex++);
      } catch (err) {
        logger.error('Failed to save chunk:', err);
      }
    }
  };

  recorder.onerror = (e) => {
    logger.error('CDP MediaRecorder error:', e);
  };

  recorder.onstop = async () => {
    const duration = Date.now() - recordingStartTime;
    logger.log(`CDP MediaRecorder stopped after ${duration}ms`);
    try {
      const { finishRecording: fin } = await import('./db.js');
      await fin(cdpRecordingId, recorder.mimeType || 'video/webm', duration, totalSize);
      await chrome.runtime.sendMessage({
        type: 'CDP_FINISHED',
        recordingId: cdpRecordingId,
      });
    } catch (e) {
      logger.error('Failed to finish CDP recording:', e);
    } finally {
      cleanup();
    }
  };

  mediaRecorder = recorder;
  recorder.start(CHUNK_INTERVAL_MS);
  logger.log('CDP capture started');
}

function paintCDPFrame(data, metadata) {
  if (!ctx || !canvas) {
    logger.warn('No canvas context to paint frame');
    return;
  }

  try {
    // Resize the canvas to match the source dimensions BEFORE drawing so the
    // first frame isn't stretched to the default 1280x720 size.
    if (metadata?.deviceHeight) {
      canvas.height = metadata.deviceHeight;
      canvas.width = metadata.deviceWidth;
    }

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = 'data:image/jpeg;base64,' + data;
  } catch (e) {
    logger.error('Failed to paint CDP frame:', e);
  }
}

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stream?.getTracks().forEach((t) => t.stop());
    } catch (e) {
      logger.log('Error stopping recorder stream tracks:', e);
    }
  }
  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      logger.log('Error stopping media stream tracks:', e);
    }
  }
  mediaStream = null;
  mediaRecorder = null;
  currentId = null;
  cdpRecordingId = null;
  canvas = null;
  ctx = null;
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    logger.log('Stopping MediaRecorder, current state:', mediaRecorder.state);
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.requestData();
    }
    mediaRecorder.stop();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'cdpScreencast') return;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'CDP_START') {
      startCDPCapture(msg.recordingId, msg.width, msg.height).catch((e) => {
        logger.error('CDP start failed:', e);
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_ERROR',
          error: String(e),
        });
      });
    } else if (msg.type === 'CDP_FRAME') {
      paintCDPFrame(msg.data, msg.metadata);
      port.postMessage({ type: 'CDP_ACK', ackId: msg.ackId });
    } else if (msg.type === 'CDP_STOP') {
      stopCapture();
    }
  });

  port.onDisconnect.addListener(() => {
    logger.log('CDP port disconnected');
    stopCapture();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'OFFSCREEN_START') {
      try {
        logger.log('Received OFFSCREEN_START message:', message);
        await startCapture(
          message.mode,
          message.recordingId,
          message.includeAudio,
          message.silent,
          message.streamId
        );
        sendResponse({ ok: true });
      } catch (e) {
        logger.error('startCapture failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (message.type === 'OFFSCREEN_STOP') {
      logger.log('Received OFFSCREEN_STOP message');
      stopCapture();
      sendResponse({ ok: true });
    }
  })();
  return true;
});
