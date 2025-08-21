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
})();

let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let currentId = null;
let recordingStartTime = null;

function getConstraintsFromMode(mode) {
  // getDisplayMedia ignores constraints like preferCurrentTab; selection is via browser prompt
  return { video: true, audio: false }; // Phase 1: screen-only
}

async function startCapture(mode, recordingId) {
  if (mediaRecorder) throw new Error('Already recording');
  currentId = recordingId;
  chunks = [];
  
  console.log('OFFSCREEN: Starting capture with mode:', mode);
  
  try {
    console.log('OFFSCREEN: Requesting display media...');
    mediaStream = await navigator.mediaDevices.getDisplayMedia(getConstraintsFromMode(mode));
    console.log('OFFSCREEN: Got media stream:', {
      id: mediaStream.id,
      active: mediaStream.active,
      videoTracks: mediaStream.getVideoTracks().length,
      audioTracks: mediaStream.getAudioTracks().length
    });
  } catch (error) {
    console.error('OFFSCREEN: getDisplayMedia failed:', error);
    throw error;
  }

  // Auto-stop when user stops sharing
  mediaStream.getVideoTracks().forEach((t) => {
    t.addEventListener('ended', () => {
      console.log('Video track ended, auto-stopping recorder');
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Auto-stop: MediaRecorder state:', mediaRecorder.state);
        // Request any remaining data before auto-stopping
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.requestData();
        }
        mediaRecorder.stop();
      }
    });
  });

  const options = { mimeType: 'video/webm;codecs=vp9,opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'video/webm;codecs=vp8,opus';
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = 'video/webm';
  }

  mediaRecorder = new MediaRecorder(mediaStream, options);
  
  mediaRecorder.onstart = () => {
    recordingStartTime = Date.now();
    console.log('MediaRecorder onstart event fired');
  };
  
  mediaRecorder.ondataavailable = (e) => {
    const elapsed = Date.now() - recordingStartTime;
    console.log(`MediaRecorder data available at ${elapsed}ms:`, e.data?.size, 'bytes');
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
      console.log(`Added chunk ${chunks.length}, total chunks: ${chunks.length}`);
    }
  };
  
  mediaRecorder.onerror = (e) => {
    console.error('MediaRecorder error:', e);
  };
  mediaRecorder.onstop = async () => {
    const elapsed = Date.now() - recordingStartTime;
    console.log(`MediaRecorder stopped after ${elapsed}ms. Total chunks:`, chunks.length, 'Total size:', chunks.reduce((sum, chunk) => sum + chunk.size, 0), 'bytes');
    try {
      // Request a final chunk before creating blob
      if (mediaRecorder.state === 'inactive' && chunks.length === 0) {
        console.warn('No chunks recorded! This might indicate the recording was too short.');
      }
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });
      console.log('Created blob:', blob.size, 'bytes, type:', blob.type);
      const arrayBuffer = await blob.arrayBuffer();
      
      // Send data to background script
      try {
        // Convert ArrayBuffer to Array for transfer (Chrome extensions can't transfer ArrayBuffers directly)
        const uint8Array = new Uint8Array(arrayBuffer);
        const dataArray = Array.from(uint8Array);
        
        console.log('OFFSCREEN: Converting ArrayBuffer to Array for transfer, size:', dataArray.length);
        
        const response = await chrome.runtime.sendMessage({ 
          type: 'OFFSCREEN_DATA', 
          recordingId: currentId, 
          dataArray, 
          mimeType: blob.type 
        });
        console.log('OFFSCREEN_DATA response:', response);
      } catch (error) {
        console.error('Failed to send OFFSCREEN_DATA:', error);
      }
    } finally {
      cleanup();
    }
  };
  mediaRecorder.start(100); // gather in smaller chunks more frequently
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
  chunks = [];
  currentId = null;
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
        await startCapture(message.mode, message.recordingId);
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
