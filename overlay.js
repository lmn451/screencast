// Injected overlay with a Stop button. Minimal footprint, avoids interfering with page.
// Note: Cannot import modules in content script, so inline logging is minimal

// Constants (duplicated from constants.js since content scripts can't import modules easily)
const ERROR_DISPLAY_DURATION_MS = 2000;

(function () {
  if (document.getElementById('cc-overlay')) return;
  const root = document.createElement('div');
  root.id = 'cc-overlay';
  Object.assign(root.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: 2147483647,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  });

  const btn = document.createElement('button');
  btn.textContent = 'Stop';
  Object.assign(btn.style, {
    background: '#d93025',
    color: '#fff',
    border: 'none',
    borderRadius: '20px',
    padding: '8px 14px',
    fontSize: '14px',
    boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
    cursor: 'pointer',
  });
  btn.addEventListener('click', async () => {
    // Prevent multiple clicks and provide visual feedback
    btn.disabled = true;
    btn.textContent = 'Saving...';
    btn.style.opacity = '0.7';
    btn.style.cursor = 'wait';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'STOP' });
      if (!response || !response.ok) {
         // Only log errors in overlay
         console.error('[CaptureCast Overlay] Stop failed:', response?.error);
         btn.textContent = 'Error!';
         setTimeout(() => {
           btn.disabled = false;
           btn.textContent = 'Stop';
           btn.style.cursor = 'pointer';
           btn.style.opacity = '1';
         }, ERROR_DISPLAY_DURATION_MS);
      }
      // On success, overlay will be removed anyway
    } catch (e) {
      console.error('[CaptureCast Overlay] Failed to send stop message:', e);
      btn.textContent = 'Error!';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Stop';
        btn.style.cursor = 'pointer';
        btn.style.opacity = '1';
      }, ERROR_DISPLAY_DURATION_MS);
    }
  });

  // Allow background to request removal explicitly (extra safety)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'OVERLAY_REMOVE') {
        try { root.remove(); } catch {}
      }
    });
  } catch {}

  root.appendChild(btn);
  document.documentElement.appendChild(root);
})();
