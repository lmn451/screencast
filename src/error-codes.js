// Error codes and structured error responses for CaptureCast

/**
 * Canonical error codes used throughout the extension.
 * All codes are kebab-case strings for consistency.
 */
export const CODES = {
  // Recording state errors
  ALREADY_RECORDING: 'already-recording',
  NOT_RECORDING: 'not-recording',

  // Storage errors
  STORAGE_QUOTA_EXCEEDED: 'storage-quota-exceeded',
  STORAGE_QUOTA_UNAVAILABLE: 'storage-quota-unavailable',

  // Screen/audio permission errors
  SCREEN_PERMISSION_DENIED: 'screen-permission-denied',
  SCREEN_PERMISSION_CANCELLED: 'screen-permission-cancelled',
  MICROPHONE_NOT_AVAILABLE: 'microphone-not-available',

  // Offscreen document errors
  OFFSCREEN_NOT_AVAILABLE: 'offscreen-not-available',
  OFFSCREEN_CRASHED: 'offscreen-crashed',

  // Recorder errors
  RECORDER_TAB_CLOSED: 'recorder-tab-closed',

  // Save errors
  SAVE_FAILED: 'save-failed',
  CHUNK_SAVE_FAILED: 'chunk-save-failed',

  // State/validation errors
  INVALID_STATE_TRANSITION: 'invalid-state-transition',
  CORRELATION_ID_MISSING: 'correlation-id-missing',
  MESSAGE_VALIDATION_FAILED: 'message-validation-failed',
};

/** @type {Record<string, boolean>} Maps codes to default retryable flag */
const RETRYABLE_BY_DEFAULT = {
  [CODES.STORAGE_QUOTA_EXCEEDED]: false,
  [CODES.STORAGE_QUOTA_UNAVAILABLE]: true,
  [CODES.SCREEN_PERMISSION_DENIED]: false,
  [CODES.SCREEN_PERMISSION_CANCELLED]: true,
  [CODES.OFFSCREEN_NOT_AVAILABLE]: true,
  [CODES.OFFSCREEN_CRASHED]: true,
  [CODES.RECORDER_TAB_CLOSED]: true,
  [CODES.SAVE_FAILED]: true,
  [CODES.CHUNK_SAVE_FAILED]: true,
  [CODES.INVALID_STATE_TRANSITION]: false,
  [CODES.MESSAGE_VALIDATION_FAILED]: false,
};

/**
 * Creates a structured error response.
 * @param {string} code - Error code from CODES
 * @param {string} userMessage - Message safe to show to user
 * @param {string} [technicalMessage=''] - Developer detail, not shown to user
 * @param {object} [opts={}] - Additional options
 * @param {boolean} [opts.retryable] - Override default retryable flag
 * @param {string} [opts.correlationId] - Correlation ID for tracking
 * @returns {object} Structured error object
 */
export function createError(code, userMessage, technicalMessage = '', opts = {}) {
  const retryable =
    opts.retryable !== undefined ? opts.retryable : RETRYABLE_BY_DEFAULT[code] ?? true;

  return {
    ok: false,
    code,
    userMessage,
    technicalMessage,
    retryable,
    correlationId: opts.correlationId ?? null,
  };
}

/**
 * Maps common DOM exceptions to canonical error codes.
 * @param {DOMException|Error} domError - The DOM exception or error
 * @param {string} fallbackUserMessage - User message if mapping not found
 * @returns {object} Structured error from createError
 */
export function mapDOMExceptionToError(domError, fallbackUserMessage) {
  const name = domError?.name ?? '';
  const code = domError?.code ?? '';

  switch (name) {
    case 'NotAllowedError':
      return createError(
        CODES.SCREEN_PERMISSION_DENIED,
        fallbackUserMessage,
        domError.message || 'Permission denied'
      );

    case 'NotFoundError':
      return createError(
        CODES.MICROPHONE_NOT_AVAILABLE,
        fallbackUserMessage,
        domError.message || 'Requested device not found'
      );

    case 'InvalidStateError':
      return createError(
        CODES.INVALID_STATE_TRANSITION,
        fallbackUserMessage,
        domError.message || 'Invalid state for operation'
      );

    case 'AbortError':
      return createError(
        CODES.RECORDER_TAB_CLOSED,
        fallbackUserMessage,
        domError.message || 'Operation aborted'
      );

    case 'SecurityError':
      return createError(
        CODES.SCREEN_PERMISSION_DENIED,
        fallbackUserMessage,
        domError.message || 'Security policy blocked'
      );

    default:
      // Handle chromium-specific error codes
      if (code === 18 || name === 'ConstraintNotSatisfiedError') {
        return createError(
          CODES.SCREEN_PERMISSION_DENIED,
          fallbackUserMessage,
          domError.message || 'Constraints could not be satisfied'
        );
      }
      return createError(
        CODES.SAVE_FAILED,
        fallbackUserMessage,
        domError?.message || String(domError)
      );
  }
}
