// Unit tests for error-codes.js

import { CODES, createError, mapDOMExceptionToError } from '../../src/error-codes.js';

describe('error-codes.js', () => {
  describe('createError', () => {
    it('should return correct shape with required fields', () => {
      const error = createError(CODES.ALREADY_RECORDING, 'Already recording', 'Debug info');
      expect(error).toHaveProperty('ok', false);
      expect(error).toHaveProperty('code', 'already-recording');
      expect(error).toHaveProperty('userMessage', 'Already recording');
      expect(error).toHaveProperty('technicalMessage', 'Debug info');
      expect(error).toHaveProperty('retryable');
      expect(error).toHaveProperty('correlationId');
    });

    it('should use default retryable from CODES', () => {
      const nonRetryable = createError(CODES.SCREEN_PERMISSION_DENIED, 'Denied');
      expect(nonRetryable.retryable).toBe(false);

      const retryable = createError(CODES.OFFSCREEN_CRASHED, 'Crashed');
      expect(retryable.retryable).toBe(true);
    });

    it('should allow override of retryable flag', () => {
      const error = createError(CODES.SCREEN_PERMISSION_DENIED, 'Denied', '', {
        retryable: true,
      });
      expect(error.retryable).toBe(true);
    });

    it('should include correlationId when provided', () => {
      const error = createError(CODES.SAVE_FAILED, 'Save failed', '', {
        correlationId: 'test-correlation-123',
      });
      expect(error.correlationId).toBe('test-correlation-123');
    });

    it('should default correlationId to null', () => {
      const error = createError(CODES.SAVE_FAILED, 'Save failed');
      expect(error.correlationId).toBeNull();
    });

    it('should default technicalMessage to empty string', () => {
      const error = createError(CODES.ALREADY_RECORDING, 'Already recording');
      expect(error.technicalMessage).toBe('');
    });

    it('should use fallback retryable for unknown codes', () => {
      const error = createError('unknown-code', 'Unknown error', '', { retryable: false });
      expect(error.code).toBe('unknown-code');
      expect(error.ok).toBe(false);
    });
  });

  describe('mapDOMExceptionToError', () => {
    it('should map NotAllowedError to SCREEN_PERMISSION_DENIED', () => {
      const domError = new DOMException('Permission denied', 'NotAllowedError');
      const result = mapDOMExceptionToError(domError, 'Screen permission denied');
      expect(result.code).toBe(CODES.SCREEN_PERMISSION_DENIED);
      expect(result.userMessage).toBe('Screen permission denied');
      expect(result.technicalMessage).toBe('Permission denied');
    });

    it('should map NotFoundError to MICROPHONE_NOT_AVAILABLE', () => {
      const domError = new DOMException('Device not found', 'NotFoundError');
      const result = mapDOMExceptionToError(domError, 'Microphone not found');
      expect(result.code).toBe(CODES.MICROPHONE_NOT_AVAILABLE);
      expect(result.userMessage).toBe('Microphone not found');
    });

    it('should map InvalidStateError to INVALID_STATE_TRANSITION', () => {
      const domError = new DOMException('Invalid state', 'InvalidStateError');
      const result = mapDOMExceptionToError(domError, 'Invalid state');
      expect(result.code).toBe(CODES.INVALID_STATE_TRANSITION);
    });

    it('should map AbortError to RECORDER_TAB_CLOSED', () => {
      const domError = new DOMException('Aborted', 'AbortError');
      const result = mapDOMExceptionToError(domError, 'Recording stopped');
      expect(result.code).toBe(CODES.RECORDER_TAB_CLOSED);
    });

    it('should map SecurityError to SCREEN_PERMISSION_DENIED', () => {
      const domError = new DOMException('Security blocked', 'SecurityError');
      const result = mapDOMExceptionToError(domError, 'Security blocked');
      expect(result.code).toBe(CODES.SCREEN_PERMISSION_DENIED);
    });

    it('should map code 18 to SCREEN_PERMISSION_DENIED', () => {
      const domError = { name: 'Error', code: 18 };
      const result = mapDOMExceptionToError(domError, 'Constraint not satisfied');
      expect(result.code).toBe(CODES.SCREEN_PERMISSION_DENIED);
    });

    it('should map ConstraintNotSatisfiedError to SCREEN_PERMISSION_DENIED', () => {
      const domError = new DOMException('Constraint not satisfied', 'ConstraintNotSatisfiedError');
      const result = mapDOMExceptionToError(domError, 'Constraint error');
      expect(result.code).toBe(CODES.SCREEN_PERMISSION_DENIED);
    });

    it('should map unknown errors to SAVE_FAILED', () => {
      const domError = new Error('Unknown error');
      const result = mapDOMExceptionToError(domError, 'Unknown error');
      expect(result.code).toBe(CODES.SAVE_FAILED);
    });

    it('should handle null/undefined error gracefully', () => {
      const result = mapDOMExceptionToError(null, 'Null error');
      expect(result.code).toBe(CODES.SAVE_FAILED);
      expect(result.userMessage).toBe('Null error');
    });

    it('should handle error with no message property', () => {
      const domError = { name: 'NotAllowedError' };
      const result = mapDOMExceptionToError(domError, 'No message');
      expect(result.code).toBe(CODES.SCREEN_PERMISSION_DENIED);
    });
  });

  describe('CODES object', () => {
    it('should have ALREADY_RECORDING code', () => {
      expect(CODES.ALREADY_RECORDING).toBe('already-recording');
    });

    it('should have NOT_RECORDING code', () => {
      expect(CODES.NOT_RECORDING).toBe('not-recording');
    });

    it('should have STORAGE_QUOTA_EXCEEDED code', () => {
      expect(CODES.STORAGE_QUOTA_EXCEEDED).toBe('storage-quota-exceeded');
    });

    it('should have STORAGE_QUOTA_UNAVAILABLE code', () => {
      expect(CODES.STORAGE_QUOTA_UNAVAILABLE).toBe('storage-quota-unavailable');
    });

    it('should have SCREEN_PERMISSION_DENIED code', () => {
      expect(CODES.SCREEN_PERMISSION_DENIED).toBe('screen-permission-denied');
    });

    it('should have SCREEN_PERMISSION_CANCELLED code', () => {
      expect(CODES.SCREEN_PERMISSION_CANCELLED).toBe('screen-permission-cancelled');
    });

    it('should have MICROPHONE_NOT_AVAILABLE code', () => {
      expect(CODES.MICROPHONE_NOT_AVAILABLE).toBe('microphone-not-available');
    });

    it('should have OFFSCREEN_NOT_AVAILABLE code', () => {
      expect(CODES.OFFSCREEN_NOT_AVAILABLE).toBe('offscreen-not-available');
    });

    it('should have OFFSCREEN_CRASHED code', () => {
      expect(CODES.OFFSCREEN_CRASHED).toBe('offscreen-crashed');
    });

    it('should have RECORDER_TAB_CLOSED code', () => {
      expect(CODES.RECORDER_TAB_CLOSED).toBe('recorder-tab-closed');
    });

    it('should have SAVE_FAILED code', () => {
      expect(CODES.SAVE_FAILED).toBe('save-failed');
    });

    it('should have CHUNK_SAVE_FAILED code', () => {
      expect(CODES.CHUNK_SAVE_FAILED).toBe('chunk-save-failed');
    });

    it('should have INVALID_STATE_TRANSITION code', () => {
      expect(CODES.INVALID_STATE_TRANSITION).toBe('invalid-state-transition');
    });

    it('should have CORRELATION_ID_MISSING code', () => {
      expect(CODES.CORRELATION_ID_MISSING).toBe('correlation-id-missing');
    });

    it('should have MESSAGE_VALIDATION_FAILED code', () => {
      expect(CODES.MESSAGE_VALIDATION_FAILED).toBe('message-validation-failed');
    });

    it('should have all expected codes (15 total)', () => {
      const expectedCodes = [
        'already-recording',
        'not-recording',
        'storage-quota-exceeded',
        'storage-quota-unavailable',
        'screen-permission-denied',
        'screen-permission-cancelled',
        'microphone-not-available',
        'offscreen-not-available',
        'offscreen-crashed',
        'recorder-tab-closed',
        'save-failed',
        'chunk-save-failed',
        'invalid-state-transition',
        'correlation-id-missing',
        'message-validation-failed',
      ];
      const actualCodes = Object.values(CODES);
      expect(actualCodes).toHaveLength(expectedCodes.length);
      for (const code of expectedCodes) {
        expect(actualCodes).toContain(code);
      }
    });
  });
});
