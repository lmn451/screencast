function getQueryParam(name) {
  const url = new URL(location.href);
  return url.searchParams.get(name);
}

function saveFile(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

(async () => {
  const id = getQueryParam('id');
  if (!id) {
    document.body.textContent = 'Missing recording id';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'PREVIEW_READY', recordingId: id });
  console.log('Preview: PREVIEW_READY response:', {
    ok: res?.ok,
    error: res?.error,
    dataArraySize: res?.dataArray?.length || 0,
    mimeType: res?.mimeType
  });
  
  if (!res?.ok) {
    document.body.textContent = res?.error || 'Failed to load recording';
    return;
  }
  
  // Validate and convert dataArray back to ArrayBuffer
  const { dataArray, mimeType } = res;
  if (!Array.isArray(dataArray) || dataArray.length === 0) {
    console.error('Preview: Missing or empty dataArray in response');
    document.body.textContent = 'Recording data missing or empty.';
    return;
  }
  const uint8Array = new Uint8Array(dataArray);
  const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength);
  console.log('Preview: Converted dataArray to ArrayBuffer, size:', arrayBuffer.byteLength);
  console.log('Preview: Creating blob from arrayBuffer:', arrayBuffer.byteLength, 'bytes');
  const blob = new Blob([arrayBuffer], { type: mimeType || 'video/webm' });
  console.log('Preview: Created blob:', blob.size, 'bytes, type:', blob.type);
  
  const url = URL.createObjectURL(blob);
  const video = document.getElementById('video');
  video.src = url;
  // Important: Do NOT revoke the URL immediately; the video element may request ranges during playback.
  // Revoke on page unload to avoid net::ERR_FILE_NOT_FOUND and truncated playback.
  video.onloadedmetadata = () => {
    console.log('Preview: Video metadata loaded:', { duration: video.duration, mimeType });
  };
  window.addEventListener('beforeunload', () => URL.revokeObjectURL(url));
  video.onerror = (e) => {
    console.error('Preview: Video failed to load:', e);
  };

  document.getElementById('btn-download').addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = (mimeType || 'video/webm').includes('webm') ? 'webm' : 'webm';
    const filename = `CaptureCast-${ts}.${ext}`;
    console.log('Preview: Downloading file:', filename, 'Size:', blob.size, 'bytes');
    saveFile(blob, filename);
  });
})();
