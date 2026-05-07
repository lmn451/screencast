// Log redaction utilities for CaptureCast
// Phase 6: Ensure sensitive data is NEVER logged

/**
 * Redact a URL, keeping only the domain
 * @param {string} url - URL to redact
 * @returns {string} - Redacted URL (domain only) or original if invalid
 */
export function redactUrl(url) {
  if (!url || typeof url !== 'string') return '[invalid-url]';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return '[redacted-url]';
  }
}

/**
 * Redact a device/track label, returning generic labels
 * @param {string} label - Device or track label to redact
 * @returns {string} - Generic label or 'Unknown Device'
 */
export function redactLabel(label) {
  if (!label || typeof label !== 'string') return 'Unknown Device';
  // Return generic labels based on content patterns
  if (label.toLowerCase().includes('mic') || label.toLowerCase().includes('microphone')) {
    return 'Microphone';
  }
  if (label.toLowerCase().includes('speaker') || label.toLowerCase().includes('audio output')) {
    return 'Speaker';
  }
  if (label.toLowerCase().includes('system') || label.toLowerCase().includes('browser')) {
    return 'System Audio';
  }
  // Generic device label
  return 'Audio Device';
}

/**
 * Generic message redaction that auto-detects sensitive patterns
 * @param {unknown} msg - Message to redact
 * @returns {unknown} - Redacted message
 */
export function redactMessage(msg) {
  if (msg === null || msg === undefined) return msg;
  if (typeof msg === 'string') {
    // Check for potential URLs
    if (msg.match(/^https?:\/\//i)) {
      return redactUrl(msg);
    }
    return msg;
  }

  if (typeof msg === 'object') {
    const redacted = Array.isArray(msg) ? [] : {};
    for (const [key, value] of Object.entries(msg)) {
      // Keys that may contain sensitive data
      const sensitiveKeys = [
        'url',
        'href',
        'src',
        'label',
        'deviceId',
        'groupId',
        'name',
        'title',
        'tabUrl',
      ];

      if (sensitiveKeys.includes(key.toLowerCase())) {
        if (typeof value === 'string' && value.match(/^https?:\/\//i)) {
          redacted[key] = redactUrl(value);
        } else if (key.toLowerCase().includes('label')) {
          redacted[key] = redactLabel(value);
        } else {
          redacted[key] = '[redacted]';
        }
      } else if (key.toLowerCase() === 'recordingid') {
        // Recording IDs are safe to log (they're UUIDs, not user data)
        redacted[key] = value;
      } else {
        redacted[key] = redactMessage(value);
      }
    }
    return redacted;
  }

  return msg;
}
