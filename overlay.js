// Injected overlay with a Stop button. Minimal footprint, avoids interfering with page.
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
  btn.addEventListener('click', () => {
    // Prevent multiple clicks and provide visual feedback
    btn.disabled = true;
    btn.textContent = 'Saving...';
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
    
    chrome.runtime.sendMessage({ type: 'STOP' }, (response) => {
      if (!response?.ok) {
        // Re-enable on error
        btn.disabled = false;
        btn.textContent = 'Stop (Retry)';
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
      }
      // On success, overlay will be removed anyway
    });
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
