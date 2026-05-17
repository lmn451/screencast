// Unit tests for messages.js

import {
  MSG_START,
  MSG_STOP,
  MSG_GET_STATE,
  MSG_OFFSCREEN_STARTED,
  MSG_OFFSCREEN_DATA,
  MSG_RECORDER_DATA,
  MSG_RECORDER_STARTED,
  MSG_OFFSCREEN_START,
  MSG_OFFSCREEN_STOP,
  MSG_RECORDER_STOP,
  MSG_TAB_CLOSING,
  MSG_PREVIEW_READY,
  MSG_OFFSCREEN_ERROR,
  MSG_OFFSCREEN_TEST,
  MSG_RECOVERY_RESUME,
  MSG_RECOVERY_DISCARD,
  schemas,
  validateMessage,
} from '../../src/messages.js';

describe('messages.js', () => {
  describe('validateMessage', () => {
    it('should return valid for messages with all required fields', () => {
      const msg = { type: MSG_START, mode: 'tab' };
      const schema = schemas[MSG_START];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return valid for messages with only required fields', () => {
      const msg = { type: MSG_STOP };
      const schema = schemas[MSG_STOP];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid for non-object messages', () => {
      const result = validateMessage(null, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Message is not an object');
    });

    it('should return invalid for messages missing type field', () => {
      const msg = { mode: 'tab' };
      const schema = schemas[MSG_START];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Message missing type field');
    });

    it('should return invalid for messages missing required fields', () => {
      const msg = { type: MSG_OFFSCREEN_DATA }; // missing recordingId
      const schema = schemas[MSG_OFFSCREEN_DATA];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: recordingId');
    });

    it('should return invalid for messages with undefined required field', () => {
      const msg = { type: MSG_OFFSCREEN_DATA, recordingId: undefined };
      const schema = schemas[MSG_OFFSCREEN_DATA];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(false);
    });

    it('should warn but not block for unknown message types', () => {
      const msg = { type: 'UNKNOWN_TYPE' };
      const result = validateMessage(msg, null);
      expect(result.valid).toBe(true);
      expect(result.errors).toContain('Unknown message type: UNKNOWN_TYPE');
    });

    it('should validate START message with optional fields', () => {
      const msg = { type: MSG_START, mode: 'screen', mic: true, systemAudio: false };
      const schema = schemas[MSG_START];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(true);
    });

    it('should reject START messages with unknown recording modes', () => {
      const msg = { type: MSG_START, mode: 'browser', mic: false, systemAudio: false };
      const schema = schemas[MSG_START];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Field 'mode' must be one of: tab, window, screen");
    });

    it('should reject recovery messages without recordingId', () => {
      const result = validateMessage({ type: MSG_RECOVERY_RESUME }, schemas[MSG_RECOVERY_RESUME]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: recordingId');
    });

    it('should validate the real OFFSCREEN_START payload', () => {
      const msg = {
        type: MSG_OFFSCREEN_START,
        mode: 'tab',
        recordingId: '550e8400-e29b-41d4-a716-446655440000',
        includeAudio: false,
        targetTabId: 42,
      };
      const schema = schemas[MSG_OFFSCREEN_START];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('All message schemas', () => {
    it('should have START schema with required and optional fields', () => {
      expect(schemas[MSG_START]).toBeDefined();
      expect(schemas[MSG_START].required.map(([f]) => f)).toContain('type');
      expect(schemas[MSG_START].required.map(([f]) => f)).toContain('mode');
    });

    it('should have STOP schema with only required fields', () => {
      expect(schemas[MSG_STOP]).toBeDefined();
      expect(schemas[MSG_STOP].required.map(([f]) => f)).toContain('type');
      expect(schemas[MSG_STOP].optional.map(([f]) => f)).toHaveLength(0);
    });

    it('should have GET_STATE schema', () => {
      expect(schemas[MSG_GET_STATE]).toBeDefined();
      expect(schemas[MSG_GET_STATE].required.map(([f]) => f)).toContain('type');
    });

    it('should have OFFSCREEN_STARTED schema', () => {
      expect(schemas[MSG_OFFSCREEN_STARTED]).toBeDefined();
      expect(schemas[MSG_OFFSCREEN_STARTED].required.map(([f]) => f)).toContain('type');
    });

    it('should have OFFSCREEN_DATA schema with required recordingId', () => {
      expect(schemas[MSG_OFFSCREEN_DATA]).toBeDefined();
      const requiredFields = schemas[MSG_OFFSCREEN_DATA].required.map(([f]) => f);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('recordingId');
      expect(requiredFields).toContain('mimeType');
    });

    it('should have RECORDER_DATA schema with required recordingId', () => {
      expect(schemas[MSG_RECORDER_DATA]).toBeDefined();
      const requiredFields = schemas[MSG_RECORDER_DATA].required.map(([f]) => f);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('recordingId');
      expect(requiredFields).toContain('mimeType');
    });

    it('should have RECORDER_STARTED schema', () => {
      expect(schemas[MSG_RECORDER_STARTED]).toBeDefined();
      expect(schemas[MSG_RECORDER_STARTED].required.map(([f]) => f)).toContain('type');
    });

    it('should have OFFSCREEN_START schema', () => {
      expect(schemas[MSG_OFFSCREEN_START]).toBeDefined();
      const requiredFields = schemas[MSG_OFFSCREEN_START].required.map(([f]) => f);
      expect(requiredFields).toEqual(['type', 'mode', 'recordingId', 'includeAudio']);
      expect(schemas[MSG_OFFSCREEN_START].optional.map(([f]) => f)).toContain('targetTabId');
    });

    it('should have OFFSCREEN_STOP schema', () => {
      expect(schemas[MSG_OFFSCREEN_STOP]).toBeDefined();
      expect(schemas[MSG_OFFSCREEN_STOP].required.map(([f]) => f)).toContain('type');
    });

    it('should have RECORDER_STOP schema', () => {
      expect(schemas[MSG_RECORDER_STOP]).toBeDefined();
      expect(schemas[MSG_RECORDER_STOP].required.map(([f]) => f)).toContain('type');
    });

    it('should have TAB_CLOSING schema', () => {
      expect(schemas[MSG_TAB_CLOSING]).toBeDefined();
      expect(schemas[MSG_TAB_CLOSING].required.map(([f]) => f)).toContain('type');
    });

    it('should have PREVIEW_READY schema', () => {
      expect(schemas[MSG_PREVIEW_READY]).toBeDefined();
      expect(schemas[MSG_PREVIEW_READY].required.map(([f]) => f)).toContain('type');
    });

    it('should have OFFSCREEN_ERROR schema', () => {
      expect(schemas[MSG_OFFSCREEN_ERROR]).toBeDefined();
      expect(schemas[MSG_OFFSCREEN_ERROR].required.map(([f]) => f)).toContain('type');
    });

    it('should have OFFSCREEN_TEST schema', () => {
      expect(schemas[MSG_OFFSCREEN_TEST]).toBeDefined();
      expect(schemas[MSG_OFFSCREEN_TEST].required.map(([f]) => f)).toContain('type');
    });

    it('should have recovery schemas with required recordingId', () => {
      for (const type of [MSG_RECOVERY_RESUME, MSG_RECOVERY_DISCARD]) {
        const requiredFields = schemas[type].required.map(([f]) => f);
        expect(requiredFields).toContain('type');
        expect(requiredFields).toContain('recordingId');
      }
    });
  });
});
