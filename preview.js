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
  const fixDurationAndReset = () => {
    // If duration is Infinity, we need to fix it
    if (!isFinite(video.duration) || video.duration === Infinity) {
      // Pause the video first to prevent playback during the fix
      video.pause();
      
      // Store the original playback position (should be 0)
      const originalTime = video.currentTime;
      
      // Temporarily hide the video to avoid visual jumps
      const originalOpacity = video.style.opacity;
      video.style.opacity = '0';
      video.style.transition = 'opacity 0.2s';
      
      // Use a more controlled approach: seek to a large time to get the real duration
      // but do it in a way that's less jarring
      const seekToFix = () => {
        // Create a promise to handle the duration fix
        return new Promise((resolve) => {
          let fixed = false;
          
          const onSeeked = () => {
            if (!fixed && isFinite(video.duration)) {
              fixed = true;
              video.removeEventListener('seeked', onSeeked);
              video.removeEventListener('timeupdate', onTimeUpdate);
              
              // Now that we have the real duration, reset to start
              video.currentTime = 0;
              console.log('Preview: Duration fixed:', video.duration, 'seconds');
              resolve();
            }
          };
          
          const onTimeUpdate = () => {
            if (!fixed && isFinite(video.duration)) {
              fixed = true;
              video.removeEventListener('seeked', onSeeked);
              video.removeEventListener('timeupdate', onTimeUpdate);
              
              // Reset to original position
              video.currentTime = originalTime;
              console.log('Preview: Duration fixed via timeupdate:', video.duration, 'seconds');
              resolve();
            }
          };
          
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('timeupdate', onTimeUpdate);
          
          // Perform the seek to fix duration
          try {
            video.currentTime = Number.MAX_SAFE_INTEGER;
          } catch (e) {
            // If seeking fails, just resolve
            console.log('Preview: Seek failed, continuing anyway');
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('timeupdate', onTimeUpdate);
            resolve();
          }
        });
      };
      
      // Fix the duration asynchronously
      seekToFix().then(() => {
        // Ensure we're at the start
        try { video.currentTime = 0; } catch {}
        
        // Restore video visibility with a smooth transition
        setTimeout(() => {
          video.style.opacity = originalOpacity || '1';
          // Clean up transition after it completes
          setTimeout(() => {
            video.style.transition = '';
          }, 200);
        }, 50);
      });
    } else {
      // Duration is already finite, just ensure we're at the start
      try { video.pause(); } catch {}
      try { video.currentTime = 0; } catch {}
      console.log('Preview: Finite duration detected:', video.duration, 'seconds');
    }
  };
  
  video.onloadedmetadata = () => {
    console.log('Preview: Video metadata loaded:', { duration: video.duration, mimeType });
    fixDurationAndReset();
  };
  // Reset to start if browser fires ended immediately after load
  const onEndedReset = () => {
    try { video.currentTime = 0; } catch {}
    try { video.pause(); } catch {}
    console.log('Preview: Ended event caught, reset to start');
  };
  video.addEventListener('ended', onEndedReset);

  // Extra guard in case metadata was already loaded
  if (video.readyState >= 1) fixDurationAndReset();

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
