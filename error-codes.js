// Error codes and structured error handling for CaptureCast

/**
 * @typedef {Object} ErrorCode
 * @property {string} code - Short error code string
 * @property {string} message - Human-readable message
 */

/**
 * Error code definitions
 * @readonly
 */
export const CODES = {
  // Recording errors
  CHUNK_SAVE_FAILED: { code: 'CHUNK_SAVE_FAILED', message: 'Failed to save recording chunk' },
  RECORDING_SAVE_FAILED: {
    code: 'RECORDING_SAVE_FAILED',
    message: 'Failed to save recording metadata',
  },
  STORAGE_QUOTA_EXCEEDED: { code: 'STORAGE_QUOTA_EXCEEDED', message: 'Storage quota exceeded' },
  NO_CHUNKS_RECORDED: { code: 'NO_CHUNKS_RECORDED', message: 'No chunks were recorded' },
  PARTIAL_RECORDING: {
    code: 'PARTIAL_RECORDING',
    message: 'Recording incomplete, some chunks lost',
  },

  // Media errors
  MEDIA_PERMISSION_DENIED: { code: 'MEDIA_PERMISSION_DENIED', message: 'Media permission denied' },
  MEDIA_TRACK_ENDED: { code: 'MEDIA_TRACK_ENDED', message: 'Media track ended unexpectedly' },
  NO_SUPPORTED_CODEC: { code: 'NO_SUPPORTED_CODEC', message: 'No supported video codec found' },

  // Storage errors
  DB_OPEN_FAILED: { code: 'DB_OPEN_FAILED', message: 'Failed to open IndexedDB' },
  DB_WRITE_FAILED: { code: 'DB_WRITE_FAILED', message: 'Failed to write to IndexedDB' },

  // Generic
  UNKNOWN_ERROR: { code: 'UNKNOWN_ERROR', message: 'An unknown error occurred' },
};

/**
 * Create a structured error object
 * @param {string|ErrorCode} codeOrErrorCode - Error code string or ErrorCode object
 * @param {string} [customMessage] - Optional custom message to override error code message
 * @param {Object} [metadata] - Additional metadata to attach
 * @returns {Object} Structured error object
 */
export function createError(codeOrErrorCode, customMessage, metadata = {}) {
  const errorCode =
    typeof codeOrErrorCode === 'string'
      ? CODES[codeOrErrorCode] || CODES.UNKNOWN_ERROR
      : codeOrErrorCode;
  return {
    code: errorCode.code,
    message: customMessage || errorCode.message,
    timestamp: Date.now(),
    ...metadata,
  };
}

/**
 * Map a DOMException to an error code
 * @param {DOMException} exception - The DOM exception to map
 * @returns {Object} Structured error object
 */
export function mapDOMExceptionToError(exception) {
  if (!exception) return createError(CODES.UNKNOWN_ERROR);

  const name = exception.name || '';
  const message = exception.message || String(exception);

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return createError(CODES.MEDIA_PERMISSION_DENIED, message);
    case 'NotFoundError':
      return createError(CODES.MEDIA_PERMISSION_DENIED, 'Requested media not found');
    case 'AbortError':
      return createError(CODES.MEDIA_TRACK_ENDED, message);
    default:
      return createError(CODES.UNKNOWN_ERROR, message);
  }
}

/**
 * Check if an object is a structured error
 * @param {any} obj - Object to check
 * @returns {boolean} True if object is a structured error
 */
export function isStructuredError(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.code === 'string' &&
    typeof obj.message === 'string'
  );
}
