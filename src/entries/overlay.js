// Injected overlay with a Stop button. Minimal footprint, avoids interfering with page.
// Task 4.9: State-aware overlay — shows different states based on background status

// Constants (duplicated from constants.js since content scripts can't import modules easily)
const ERROR_DISPLAY_DURATION_MS = 2000;

(function () {
  // Protected URLs that block script injection. Some of these technically can
  // be injected with permissions, but the overlay is non-functional on these
  // hosts (e.g. Chrome Web Store strips DOM nodes; view-source: pages are
  // rendered as text). Keep this in sync with chrome's restricted-URL rules.
  const currentUrl = window.location.href;
  const isProtected =
    currentUrl.startsWith('chrome:') ||
    currentUrl.startsWith('about:') ||
    currentUrl.startsWith('devtools:') ||
    currentUrl.startsWith('chrome-extension:') ||
    currentUrl.startsWith('view-source:') ||
    currentUrl.startsWith('file:') ||
    currentUrl.startsWith('https://chrome.google.com/webstore') ||
    currentUrl.startsWith('https://chromewebstore.google.com') ||
    /\.pdf(\?|#|$)/i.test(currentUrl);

  if (isProtected) {
    console.debug('[CaptureCast Overlay] Skipping on protected page');
    return;
  }

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

  /**
   * Update button state based on recording state.
   * Status values come from the XState machine in src/machines/recordingMachine.ts
   * and are always lowercase ('idle', 'starting', 'recording', 'stopping', 'saved', 'failed', 'recoverable').
   * @param {string} status - Current status from GET_STATE
   */
  function updateButtonState(status) {
    if (status === 'stopping') {
      btn.disabled = true;
      btn.textContent = 'Saving…';
      btn.style.opacity = '0.7';
      btn.style.cursor = 'wait';
    } else if (status === 'starting') {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      btn.style.opacity = '0.7';
      btn.style.cursor = 'wait';
    } else {
      btn.disabled = false;
      btn.textContent = 'Stop';
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
  }

  // Query initial state from background
  chrome.runtime
    .sendMessage({ type: 'GET_STATE' })
    .then((state) => {
      if (state && state.status) {
        updateButtonState(state.status);
      }
    })
    .catch(() => {
      // Ignore errors, overlay will use default Stop button
    });

  btn.addEventListener('click', async () => {
    // Prevent multiple clicks and provide visual feedback
    btn.disabled = true;
    btn.textContent = 'Saving…';
    btn.style.opacity = '0.7';
    btn.style.cursor = 'wait';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'STOP' });
      if (!response || !response.ok) {
        console.error('[CaptureCast Overlay] Stop failed:', response?.error);
        btn.textContent = 'Error!';
        setTimeout(() => {
          updateButtonState('recording');
        }, ERROR_DISPLAY_DURATION_MS);
      }
      // On success, overlay will be removed anyway
    } catch (e) {
      console.error('[CaptureCast Overlay] Failed to send stop message:', e);
      btn.textContent = 'Error!';
      setTimeout(() => {
        updateButtonState('recording');
      }, ERROR_DISPLAY_DURATION_MS);
    }
  });

  // Allow background to request removal explicitly (extra safety)
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'OVERLAY_REMOVE') {
        try {
          root.remove();
        } catch (e) {
          console.warn('[CaptureCast Overlay] Failed to remove overlay root', e);
        }
      }
      // Handle state updates from background
      if (msg && msg.type === 'STATE_UPDATE') {
        updateButtonState(msg.status);
      }
    });
  } catch (e) {
    console.warn('[CaptureCast Overlay] Failed to set up message listener', e);
  }

  root.appendChild(btn);
  document.documentElement.appendChild(root);
})();
