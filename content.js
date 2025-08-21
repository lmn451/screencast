let mediaRecorder;
let recordedChunks = [];

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'startRecording') {
    startRecording(message.source);
  }
});

async function startRecording(source) {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { mediaSource: source === 'screen' ? 'screen' : 'window' }
    });

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') + '?video=' + encodeURIComponent(url) });
      stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start();

    // Add overlay for controls
    addRecordingOverlay();

    // Change extension icon
    chrome.action.setIcon({ path: 'icons/recording.svg' });
  } catch (error) {
    console.error('Recording failed:', error);
  }
}

function addRecordingOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'recording-overlay';
  overlay.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 9999;
    background: red; color: white; padding: 5px 10px; border-radius: 5px;
    cursor: pointer; font-size: 12px;
  `;
  overlay.textContent = 'Stop Recording';
  overlay.onclick = stopRecording;
  document.body.appendChild(overlay);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    chrome.action.setIcon({ path: 'icons/icon16.svg' });
    const overlay = document.getElementById('recording-overlay');
    if (overlay) overlay.remove();
  }
}