import { saveRecording } from './db.js';

function getQueryParam(name) {
  const url = new URL(location.href);
  return url.searchParams.get(name);
}

let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let recordingId = null;

function combineStreams({ displayStream, micStream }) {
  const tracks = [
    ...displayStream.getVideoTracks(),
    ...displayStream.getAudioTracks(),
    ...(micStream ? micStream.getAudioTracks() : []),
  ];
  return new MediaStream(tracks);
}

async function start() {
  const modeParam = getQueryParam('mode');
  const mode = ['tab', 'window', 'screen'].includes(modeParam) ? modeParam : 'tab';
  recordingId = getQueryParam('id');
  const wantMic = getQueryParam('mic') === '1';
  const wantSys = getQueryParam('sys') === '1';

  const status = document.getElementById('status');
  const preview = document.getElementById('preview');
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');

  try {
    status.textContent = 'Requesting screen capture…';
    startBtn.classList.add('hidden');
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: wantSys ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });

    // Hint encoders: screen/text detail and system audio type
    try {
      const vtrack = displayStream.getVideoTracks?.()[0];
      if (vtrack && 'contentHint' in vtrack) vtrack.contentHint = 'detail';
      if (wantSys) {
        for (const atrack of displayStream.getAudioTracks?.() || []) {
          if ('contentHint' in atrack) atrack.contentHint = 'music';
        }
      }
    } catch {}

    let micStream = null;
    if (wantMic) {
      try {
        status.textContent = 'Requesting microphone…';
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        // Hint encoder: speech for microphone
        try {
          const micTrack = micStream?.getAudioTracks?.()[0];
          if (micTrack && 'contentHint' in micTrack) micTrack.contentHint = 'speech';
        } catch {}
      } catch (e) {
        console.warn('RECORDER: Mic request failed, proceeding without mic', e);
      }
    }

    mediaStream = combineStreams({ displayStream, micStream });
    preview.srcObject = mediaStream;
    preview.classList.remove('hidden');
    stopBtn.classList.remove('hidden');

    // Setup MediaRecorder
    let options = { mimeType: 'video/webm;codecs=av01,opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = 'video/webm;codecs=av1,opus';
    if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = 'video/webm';
    
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      throw new Error('No supported video codec found. Your browser may not support video recording.');
    }

    mediaRecorder = new MediaRecorder(mediaStream, options);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });

        // Save to IndexedDB
        try {
          await saveRecording(recordingId, blob, blob.type);
          console.log('RECORDER: Saved recording to DB');
        } catch (dbError) {
          console.error('RECORDER: Failed to save to DB:', dbError);
          alert('Failed to save recording: ' + dbError.message);
          return;
        }

        await chrome.runtime.sendMessage({
          type: 'RECORDER_DATA',
          recordingId,
          mimeType: blob.type,
        });
      } finally {
        try {
          mediaStream?.getTracks().forEach((t) => t.stop());
        } catch (e) {}
        window.close();
      }
    };

    mediaRecorder.start(100);
    try {
      await chrome.runtime.sendMessage({ type: 'RECORDER_STARTED' });
    } catch (e) {
      console.warn('RECORDER: Failed to send RECORDER_STARTED message, continuing anyway', e);
    }
    status.textContent = 'Recording…';
    stopBtn.focus();

    // Auto-stop when screen sharing ends
    mediaStream.getVideoTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          if (mediaRecorder.state === 'recording') mediaRecorder.requestData();
          mediaRecorder.stop();
        }
      });
    });
  } catch (e) {
    const details = e && typeof e === 'object' ? `${e.name || 'DOMException'}: ${e.message || e}` : String(e);
    status.textContent = 'Failed to start: ' + details + '. Ensure this tab is focused and click Start again.';
    console.error('RECORDER: start failed', { name: e?.name, message: e?.message, toString: e?.toString?.() });
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

