// Consent flow for CaptureCast
// Shown before recording starts to inform users of what's being captured

const MODE_LABELS = {
  tab: 'This tab',
  window: 'Window',
  screen: 'Screen',
};

// Valid capture modes for validation
const VALID_MODES = ['tab', 'screen', 'window'];

async function loadParams() {
  const params = new URLSearchParams(window.location.search);
  const rawMode = params.get('mode') || 'tab';
  // Safe validation with fallback to 'tab' - graceful degradation
  const mode = VALID_MODES.includes(rawMode) ? rawMode : 'tab';
  if (rawMode !== mode) {
    console.warn(`[Consent] Invalid mode '${rawMode}' rejected, defaulting to tab`);
  }
  return {
    mode,
    mic: params.get('mic') === 'true' || params.get('mic') === '1',
    systemAudio: params.get('sys') === 'true' || params.get('sys') === '1',
  };
}

function buildCaptureList(mode, mic, systemAudio) {
  const items = [];

  // Screen/window/tab capture
  items.push(`<strong>${MODE_LABELS[mode] || mode}</strong> will be captured`);

  // Audio options
  if (mic && systemAudio) {
    items.push('Microphone audio will be included');
    items.push('System/tab audio will be included');
  } else if (mic) {
    items.push('Microphone audio will be included');
  } else if (systemAudio) {
    items.push('System/tab audio will be included');
  }

  return items;
}

function buildNote(mode, mic, _systemAudio) {
  const parts = [];

  // Screen picker
  if (mode !== 'tab') {
    parts.push("You'll see a screen picker next");
  }

  // Permission info
  const needs = [];
  if (mode !== 'tab') needs.push('screen capture');
  if (mic) needs.push('microphone access');
  if (needs.length > 0) {
    parts.push(`You'll grant permission for ${needs.join(' and ')}`);
  }

  return parts.join('. ');
}

async function init() {
  const { mode, mic, systemAudio } = await loadParams();

  // Render capture list
  const listEl = document.getElementById('capture-list');
  const items = buildCaptureList(mode, mic, systemAudio);
  listEl.innerHTML = items.map((item) => `<li>${item}</li>`).join('');

  // Render note
  const noteEl = document.getElementById('note');
  noteEl.textContent = buildNote(mode, mic, systemAudio) || 'Everything stays on your device.';

  // Track consent displayed
  trackConsent('displayed', { mode, mic, systemAudio });

  // Continue button
  document.getElementById('btn-continue').addEventListener('click', () => {
    trackConsent('accepted', { mode, mic, systemAudio });

    // Store consent flag in sessionStorage
    sessionStorage.setItem('cc_consent_given', 'true');
    sessionStorage.setItem('cc_consent_ts', String(Date.now()));

    // Send START message to background
    chrome.runtime.sendMessage(
      {
        type: 'START',
        mode,
        mic,
        systemAudio,
      },
      (res) => {
        if (res?.ok) {
          window.close();
        } else {
          // Show error inline and keep consent screen open
          const errMsg = res?.error || 'Failed to start recording';
          noteEl.style.color = '#c5221f';
          noteEl.textContent = `Error: ${errMsg}`;
          noteEl.style.background = '#fce8e6';
          trackConsent('failed', { mode, mic, systemAudio, error: errMsg });
        }
      }
    );
  });

  // Cancel button
  document.getElementById('btn-cancel').addEventListener('click', () => {
    trackConsent('cancelled', { mode, mic, systemAudio });
    window.close();
  });
}

function trackConsent(action, params) {
  try {
    // Store in sessionStorage for diagnostics
    const entry = {
      action,
      params,
      ts: Date.now(),
    };
    const key = 'cc_consent_events';
    const existing = JSON.parse(sessionStorage.getItem(key) || '[]');
    existing.push(entry);
    // Keep last 10 events
    if (existing.length > 10) existing.shift();
    sessionStorage.setItem(key, JSON.stringify(existing)); // FIX: saves array
  } catch (e) {
    // Non-critical
  }
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', init);
