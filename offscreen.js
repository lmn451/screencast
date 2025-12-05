import { saveChunk, finishRecording } from './db.js';

// Offscreen document script to handle getDisplayMedia + MediaRecorder

console.log('OFFSCREEN: Document loaded and script executing');

// Test if we can send a message back to background
(async () => {
  try {
    console.log('OFFSCREEN: Testing message communication...');
    const response = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_TEST' });
    console.log('OFFSCREEN: Test message response:', response);
  } catch (error) {
    console.error('OFFSCREEN: Test message failed:', error);
  }

  // Test DB access
  try {
    console.log('OFFSCREEN: Testing IndexedDB access...');
    const request = indexedDB.open('CaptureCastDB', 2); // Use correct DB name and version
    request.onerror = () => console.error('OFFSCREEN: IndexedDB open failed:', request.error);
    request.onsuccess = () => console.log('OFFSCREEN: IndexedDB open success');
  } catch (e) {
    console.error('OFFSCREEN: IndexedDB threw error:', e);
  }
})();

let mediaStream = null;
let mediaRecorder = null;
let currentId = null;
let recordingStartTime = null;
let chunkIndex = 0;
let totalSize = 0;

function getConstraintsFromMode(mode, includeAudio) {
  // For now, mode is informative only; actual selection (tab/window/screen)
  // is performed by the browser's picker. Constraints can diverge by mode later.
  return {
    video: true,
    audio: includeAudio ? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    } : false
  };
}

async function startCapture(mode, recordingId, includeAudio) {
  if (mediaRecorder) throw new Error('Already recording');
  currentId = recordingId;
  chunkIndex = 0;
  totalSize = 0;

  console.log('OFFSCREEN: Starting capture with mode:', mode, 'includeAudio:', includeAudio);

  try {
    console.log('OFFSCREEN: Requesting display media with audio:', includeAudio);
    const displayStream = await navigator.mediaDevices.getDisplayMedia(getConstraintsFromMode(mode, includeAudio));
    // Hint encoders: screen/text detail and system audio type
    try {
      const vtrack = displayStream.getVideoTracks?.()[0];
      if (vtrack && 'contentHint' in vtrack) vtrack.contentHint = 'detail';
      if (includeAudio) {
        for (const atrack of displayStream.getAudioTracks?.() || []) {
          if ('contentHint' in atrack) atrack.contentHint = 'music';
        }
      }
    } catch {}
    console.log('OFFSCREEN: Got display stream:', {
      id: displayStream.id,
      active: displayStream.active,
      videoTracks: displayStream.getVideoTracks().length,
      audioTracks: displayStream.getAudioTracks().length
    });

    mediaStream = displayStream;
  } catch (error) {
    console.error('OFFSCREEN: getDisplayMedia failed:', error);
    throw error;
  }

  // Auto-stop when the user stops sharing the screen (video track ends)
  mediaStream.getVideoTracks().forEach((t) => {
    t.addEventListener('ended', () => {
      console.log('Video track ended, auto-stopping recorder');
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.requestData();
        }
        mediaRecorder.stop();
      }
    });
  });

  let options = { mimeType: 'video/webm;codecs=av01,opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'video/webm;codecs=av1,opus';
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'video/webm;codecs=vp9,opus';
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'video/webm;codecs=vp8,opus';
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'video/webm';
  }

  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    throw new Error('No supported video codec found. Your browser may not support video recording.');
  }

  mediaRecorder = new MediaRecorder(mediaStream, options);

  mediaRecorder.onstart = () => {
    recordingStartTime = Date.now();
    console.log('MediaRecorder onstart event fired');
  };

  mediaRecorder.ondataavailable = async (e) => {
    const elapsed = Date.now() - recordingStartTime;
    // console.log(`MediaRecorder data available at ${elapsed}ms:`, e.data?.size, 'bytes');
    if (e.data && e.data.size > 0) {
      try {
        totalSize += e.data.size;
        await saveChunk(currentId, e.data, chunkIndex++);
      } catch (err) {
        console.error('OFFSCREEN: Failed to save chunk', err);
        // We could stop recording here, but let's try to continue
      }
    }
  };

  mediaRecorder.onerror = (e) => {
    console.error('MediaRecorder error:', e);
  };
  mediaRecorder.onstop = async () => {
    const elapsed = Date.now() - recordingStartTime;
    console.log(`MediaRecorder stopped after ${elapsed}ms. Total chunks:`, chunkIndex);
    try {
      // Request a final chunk before creating blob
      if (mediaRecorder.state === 'inactive' && chunkIndex === 0) {
        console.warn('No chunks recorded! This might indicate the recording was too short.');
      }

      const mimeType = mediaRecorder.mimeType || 'video/webm';
      const duration = Date.now() - recordingStartTime;

      // Finish recording in DB
      try {
        await finishRecording(currentId, mimeType, duration, totalSize);
        console.log('OFFSCREEN: Finished recording in DB');
      } catch (dbError) {
        console.error('OFFSCREEN: Failed to finish recording in DB:', dbError);
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_ERROR',
          error: 'Failed to save recording: ' + dbError.message
        });
        throw dbError;
      }

      // Send data to background script
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DATA',
          recordingId: currentId,
          mimeType: mimeType
        });
        console.log('OFFSCREEN_DATA response:', response);
      } catch (error) {
        console.error('Failed to send OFFSCREEN_DATA:', error);
      }
    } finally {
      cleanup();
    }
  };
  mediaRecorder.start(1000); // gather in 1s chunks (larger chunks are better for DB perf than 100ms)
  console.log('MediaRecorder started with state:', mediaRecorder.state, 'mimeType:', mediaRecorder.mimeType);
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED' });
}

function cleanup() {
  try {
    mediaRecorder?.stream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    mediaStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  mediaStream = null;
  mediaRecorder = null;
  currentId = null;
  chunkIndex = 0;
  totalSize = 0;
}

async function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    console.log('Stopping MediaRecorder, current state:', mediaRecorder.state);
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
        console.log('OFFSCREEN: Received START message:', message);
        await startCapture(message.mode, message.recordingId, message.includeAudio);
        console.log('OFFSCREEN: startCapture completed successfully');
        sendResponse({ ok: true });
      } catch (e) {
        console.error('OFFSCREEN: startCapture failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (message.type === 'OFFSCREEN_STOP') {
      console.log('OFFSCREEN: Received STOP message');
      await stopCapture();
      console.log('OFFSCREEN: stopCapture completed');
      sendResponse({ ok: true });
    }
  })();
  return true;
});
