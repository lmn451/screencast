import { getRecording } from './db.js';

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

// Exported function to normalize duration and avoid jumpy preview
export function fixDurationAndReset(video, opts = {}) {
  const { timeoutMs = 2000 } = opts;
  if (!video) return;

  // If metadata not loaded yet, wait and retry
  if (video.readyState < 1) {
    const onLM = () => {
      video.removeEventListener('loadedmetadata', onLM);
      fixDurationAndReset(video, opts);
    };
    video.addEventListener('loadedmetadata', onLM, { once: true });
    return;
  }

  // Idempotency: if already stable or already normalizing, do nothing
  if (video.dataset?.stable === 'true' || video.__previewNormalizerActive) {
    return;
  }

  video.__previewNormalizerActive = true;

  const startNow = (typeof performance !== 'undefined' && performance.now) ? performance.now.bind(performance) : Date.now;
  const t0 = startNow();
  const safeCT = () => { try { return video.currentTime || 0; } catch { return 0; } };

  // Metrics hook for tests/diagnostics
  const metrics = (window.__PREVIEW_METRICS__ = {
    normalizedAtMs: undefined,
    maxCTBeforeReset: 0,
    timedOut: false,
    events: []
  });
  const record = (ev) => metrics.events.push({ ev, t: startNow() - t0, ct: safeCT(), dur: video.duration });

  // If already finite, mark stable and return
  if (Number.isFinite(video.duration) && video.duration > 0) {
    video.dataset.stable = 'true';
    video.__previewNormalizerStable = true;
    video.__previewNormalizerActive = false;
    record('already-finite');
    return;
  }

  // Begin normalization
  if (video.dataset) video.dataset.stable = 'false';
  try { video.pause?.(); } catch {}

  let fixed = false;
  let timer;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    video.removeEventListener('durationchange', onDurationChange);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.__previewNormalizerActive = false;
  };

  const stabilize = (reason) => {
    if (fixed) return;
    fixed = true;
    record('stabilize:' + reason);
    metrics.maxCTBeforeReset = Math.max(metrics.maxCTBeforeReset, safeCT());
    try { video.currentTime = 0; } catch {}
    if (video.dataset) video.dataset.stable = 'true';
    metrics.normalizedAtMs = startNow() - t0;
    cleanup();
    video.__previewNormalizerStable = true;
  };

  const onDurationChange = () => {
    record('durationchange');
    if (Number.isFinite(video.duration) && video.duration > 0) stabilize('durationchange');
  };
  const onSeeked = () => {
    record('seeked');
    if (Number.isFinite(video.duration) && video.duration > 0) stabilize('seeked');
  };
  const onTimeUpdate = () => {
    const ct = safeCT();
    if (ct > metrics.maxCTBeforeReset) metrics.maxCTBeforeReset = ct;
    if (Number.isFinite(video.duration) && video.duration > 0) stabilize('timeupdate');
  };

  video.addEventListener('durationchange', onDurationChange);
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('timeupdate', onTimeUpdate);

  // Timeout path
  timer = setTimeout(() => {
    metrics.timedOut = true;
    stabilize('timeout');
  }, timeoutMs);

  // Large seek with fallback to seekable end
  const BIG = Number.MAX_SAFE_INTEGER / 2;
  let sought = false;
  try {
    record('seek-large');
    video.currentTime = BIG;
    sought = true;
  } catch (e) {
    record('seek-large-failed');
  }
  if (!sought) {
    try {
      if (video.seekable && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1);
        record('seek-fallback:' + end);
        video.currentTime = end;
      }
    } catch (e) {
      record('seek-fallback-failed');
    }
  }
}

// Test-only exposure when ?test is present
if (typeof window !== 'undefined' && window.location.search.includes('test')) {
  window.__TEST__ = window.__TEST__ || {};
  window.__TEST__.fixDurationAndReset = fixDurationAndReset;
  // Expose DB helpers for tests
  import('./db.js').then(db => {
    window.__TEST__.saveRecording = db.saveRecording;
    window.__TEST__.getRecording = db.getRecording;
  });
}

(async () => {
  const id = getQueryParam('id');
  let blob;
  let mimeType;

  if (window.__TEST_BLOB__) {
    console.log('Preview: Using injected __TEST_BLOB__ for video source');
    blob = window.__TEST_BLOB__;
    mimeType = blob.type || 'video/webm';
  } else {
    if (!id) {
      document.body.textContent = 'Missing recording id';
      return;
    }

    // Load from DB
    try {
      const record = await getRecording(id);
      if (!record || !record.blob) {
        throw new Error('Recording not found in DB');
      }
      blob = record.blob;
      mimeType = record.mimeType;
      console.log('Preview: Loaded from DB:', blob.size, 'bytes');
    } catch (e) {
      console.error('Preview: Failed to load from DB:', e);
      document.body.textContent = 'Failed to load recording: ' + e.message;
      return;
    }
  }

  const url = URL.createObjectURL(blob);
  const video = document.getElementById('video');
  video.src = url;
  // Start hidden until normalized to avoid visible jump
  if (video.dataset) video.dataset.stable = 'false';

  // Important: Do NOT revoke the URL immediately; the video element may request ranges during playback.
  // Revoke on page unload to avoid net::ERR_FILE_NOT_FOUND and truncated playback.

  const startNormalization = () => {
    fixDurationAndReset(video, { timeoutMs: 2000 });
  };

  video.onloadedmetadata = () => {
    console.log('Preview: Video metadata loaded:', { duration: video.duration, mimeType });
    startNormalization();
  };
  // Reset to start if browser fires ended immediately after load
  const onEndedReset = () => {
    try { video.currentTime = 0; } catch {}
    try { video.pause(); } catch {}
    console.log('Preview: Ended event caught, reset to start');
  };
  video.addEventListener('ended', onEndedReset);

  // Extra guard in case metadata was already loaded
  if (video.readyState >= 1) startNormalization();

  window.addEventListener('beforeunload', () => URL.revokeObjectURL(url));
  video.onerror = (e) => {
    console.error('Preview: Video failed to load:', e);
  };

  const downloadBtn = document.getElementById('btn-download');
  downloadBtn.addEventListener('click', () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const mt = mimeType || 'video/webm';
    let ext = 'webm';
    if (mt.includes('mp4')) ext = 'mp4';
    else if (mt.includes('webm')) ext = 'webm';
    const filename = `CaptureCast-${ts}.${ext}`;
    console.log('Preview: Downloading file:', filename, 'Size:', blob.size, 'bytes');
    saveFile(blob, filename);
  });

  // Add cleanup button
  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete Recording';
  deleteBtn.style.background = '#d93025';
  deleteBtn.style.color = '#fff';
  deleteBtn.style.border = 'none';
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this recording? This cannot be undone.')) return;
    try {
      const { deleteRecording } = await import('./db.js');
      await deleteRecording(id);
      document.body.innerHTML = '<h1>Recording Deleted</h1><p>You can close this tab.</p>';
    } catch (e) {
      alert('Failed to delete recording: ' + e.message);
    }
  });
  document.querySelector('.actions').appendChild(deleteBtn);
})();
