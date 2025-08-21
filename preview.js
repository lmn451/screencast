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
    arrayBufferSize: res?.arrayBuffer?.byteLength || 0,
    mimeType: res?.mimeType
  });
  
  if (!res?.ok) {
    document.body.textContent = res?.error || 'Failed to load recording';
    return;
  }
  const { arrayBuffer, mimeType } = res;
  console.log('Preview: Creating blob from arrayBuffer:', arrayBuffer.byteLength, 'bytes');
  const blob = new Blob([arrayBuffer], { type: mimeType || 'video/webm' });
  console.log('Preview: Created blob:', blob.size, 'bytes, type:', blob.type);
  
  const url = URL.createObjectURL(blob);
  const video = document.getElementById('video');
  video.src = url;
  video.onloadeddata = () => {
    console.log('Preview: Video loaded successfully');
    URL.revokeObjectURL(url);
  };
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
