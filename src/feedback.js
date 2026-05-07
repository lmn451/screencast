// Non-intrusive user feedback utilities for CaptureCast

/**
 * Shows a toast notification.
 * @param {Element} containerEl - Container element for the toast
 * @param {string} message - Message to display
 * @param {string} [type='info'] - Type: 'success'|'error'|'warning'|'info'
 * @param {number} [durationMs=3000] - Auto-dismiss duration
 */
export function showToast(containerEl, message, type = 'info', durationMs = 3000) {
  if (!containerEl) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute('role', 'alert');

  // Styles
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '10px 16px',
    borderRadius: '6px',
    fontSize: '13px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    zIndex: 99999,
    opacity: '0',
    transition: 'opacity 0.2s ease',
    maxWidth: '300px',
    textAlign: 'center',
  });

  const colors = {
    success: { bg: '#e6f4ea', color: '#1e7e34' },
    error: { bg: '#fce8e6', color: '#c5221f' },
    warning: { bg: '#fef7e0', color: '#b06000' },
    info: { bg: '#e8f0fe', color: '#1a73e8' },
  };
  const c = colors[type] || colors.info;
  toast.style.background = c.bg;
  toast.style.color = c.color;

  containerEl.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
  });

  // Auto-dismiss
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, durationMs);
}

/**
 * Shows a full-width banner.
 * @param {string} message - Message to display
 * @param {string} [type='info'] - Type: 'success'|'error'|'warning'|'info'
 * @returns {Element} Banner element
 */
export function showBanner(message, type = 'info') {
  const existing = document.querySelector('.diags-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.className = 'diags-banner';
  banner.textContent = message;
  banner.setAttribute('role', 'alert');

  Object.assign(banner.style, {
    width: '100%',
    padding: '12px 16px',
    textAlign: 'center',
    fontSize: '14px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: 99999,
  });

  const colors = {
    success: { bg: '#e6f4ea', color: '#1e7e34' },
    error: { bg: '#fce8e6', color: '#c5221f' },
    warning: { bg: '#fef7e0', color: '#b06000' },
    info: { bg: '#e8f0fe', color: '#1a73e8' },
  };
  const c = colors[type] || colors.info;
  banner.style.background = c.bg;
  banner.style.color = c.color;

  document.body.prepend(banner);

  setTimeout(() => {
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 300);
  }, 4000);

  return banner;
}

/**
 * Updates text element with color based on type.
 * @param {Element} el - Text element
 * @param {string} message - Message text
 * @param {string} [type] - Optional type: 'success'|'error'|'warning'|'info'
 */
export function updateStatusText(el, message, type) {
  if (!el) return;
  el.textContent = message;

  const colors = {
    success: '#1e7e34',
    error: '#c5221f',
    warning: '#b06000',
    info: '#333',
  };

  if (type && colors[type]) {
    el.style.color = colors[type];
  }
}
