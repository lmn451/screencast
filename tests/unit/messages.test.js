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
  STATE_IDLE,
  STATE_STARTING,
  STATE_PROMPTING,
  STATE_RECORDING,
  STATE_STOPPING,
  STATE_SAVING,
  STATE_SAVED,
  STATE_FAILED,
  STATE_RECOVERABLE,
  schemas,
  VALID_TRANSITIONS,
  validateMessage,
  validateStateTransition,
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
  });

  describe('validateStateTransition', () => {
    it('should allow IDLE → STARTING', () => {
      const result = validateStateTransition(STATE_IDLE, STATE_STARTING);
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should allow STARTING → PROMPTING', () => {
      const result = validateStateTransition(STATE_STARTING, STATE_PROMPTING);
      expect(result.valid).toBe(true);
    });

    it('should allow STARTING → RECORDING', () => {
      const result = validateStateTransition(STATE_STARTING, STATE_RECORDING);
      expect(result.valid).toBe(true);
    });

    it('should allow STARTING → IDLE (cancel)', () => {
      const result = validateStateTransition(STATE_STARTING, STATE_IDLE);
      expect(result.valid).toBe(true);
    });

    it('should allow PROMPTING → RECORDING', () => {
      const result = validateStateTransition(STATE_PROMPTING, STATE_RECORDING);
      expect(result.valid).toBe(true);
    });

    it('should allow PROMPTING → IDLE (cancel)', () => {
      const result = validateStateTransition(STATE_PROMPTING, STATE_IDLE);
      expect(result.valid).toBe(true);
    });

    it('should allow RECORDING → STOPPING', () => {
      const result = validateStateTransition(STATE_RECORDING, STATE_STOPPING);
      expect(result.valid).toBe(true);
    });

    it('should allow STOPPING → SAVING', () => {
      const result = validateStateTransition(STATE_STOPPING, STATE_SAVING);
      expect(result.valid).toBe(true);
    });

    it('should allow STOPPING → IDLE (emergency stop)', () => {
      const result = validateStateTransition(STATE_STOPPING, STATE_IDLE);
      expect(result.valid).toBe(true);
    });

    it('should allow SAVING → SAVED', () => {
      const result = validateStateTransition(STATE_SAVING, STATE_SAVED);
      expect(result.valid).toBe(true);
    });

    it('should allow SAVING → FAILED', () => {
      const result = validateStateTransition(STATE_SAVING, STATE_FAILED);
      expect(result.valid).toBe(true);
    });

    it('should allow SAVING → RECOVERABLE', () => {
      const result = validateStateTransition(STATE_SAVING, STATE_RECOVERABLE);
      expect(result.valid).toBe(true);
    });

    it('should allow SAVED → IDLE', () => {
      const result = validateStateTransition(STATE_SAVED, STATE_IDLE);
      expect(result.valid).toBe(true);
    });

    it('should allow FAILED → IDLE', () => {
      const result = validateStateTransition(STATE_FAILED, STATE_IDLE);
      expect(result.valid).toBe(true);
    });

    it('should allow FAILED → RECOVERABLE', () => {
      const result = validateStateTransition(STATE_FAILED, STATE_RECOVERABLE);
      expect(result.valid).toBe(true);
    });

    it('should allow RECOVERABLE → IDLE', () => {
      const result = validateStateTransition(STATE_RECOVERABLE, STATE_IDLE);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid transition IDLE → RECORDING', () => {
      const result = validateStateTransition(STATE_IDLE, STATE_RECORDING);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid transition');
    });

    it('should reject invalid transition RECORDING → IDLE', () => {
      const result = validateStateTransition(STATE_RECORDING, STATE_IDLE);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid transition RECORDING → SAVING', () => {
      const result = validateStateTransition(STATE_RECORDING, STATE_SAVING);
      expect(result.valid).toBe(false);
    });

    it('should reject unknown current state', () => {
      const result = validateStateTransition('UNKNOWN_STATE', STATE_IDLE);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown current state');
    });
  });

  describe('All 14 message schemas', () => {
    it('should have START schema with required and optional fields', () => {
      expect(schemas[MSG_START]).toBeDefined();
      expect(schemas[MSG_START].required.map(([f]) => f)).toContain('type');
      expect(schemas[MSG_START].optional.map(([f]) => f)).toContain('mode');
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
    });

    it('should have RECORDER_DATA schema with required recordingId', () => {
      expect(schemas[MSG_RECORDER_DATA]).toBeDefined();
      const requiredFields = schemas[MSG_RECORDER_DATA].required.map(([f]) => f);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('recordingId');
    });

    it('should have RECORDER_STARTED schema', () => {
      expect(schemas[MSG_RECORDER_STARTED]).toBeDefined();
      expect(schemas[MSG_RECORDER_STARTED].required.map(([f]) => f)).toContain('type');
    });

    it('should have OFFSCREEN_START schema', () => {
      expect(schemas[MSG_OFFSCREEN_START]).toBeDefined();
      expect(schemas[MSG_OFFSCREEN_START].required.map(([f]) => f)).toContain('type');
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
  });

  describe('State constants', () => {
    it('should define all 9 state constants', () => {
      expect(STATE_IDLE).toBe('IDLE');
      expect(STATE_STARTING).toBe('STARTING');
      expect(STATE_PROMPTING).toBe('PROMPTING');
      expect(STATE_RECORDING).toBe('RECORDING');
      expect(STATE_STOPPING).toBe('STOPPING');
      expect(STATE_SAVING).toBe('SAVING');
      expect(STATE_SAVED).toBe('SAVED');
      expect(STATE_FAILED).toBe('FAILED');
      expect(STATE_RECOVERABLE).toBe('RECOVERABLE');
    });
  });

  describe('VALID_TRANSITIONS coverage', () => {
    it('should have transitions defined for all states', () => {
      const states = [
        STATE_IDLE,
        STATE_STARTING,
        STATE_PROMPTING,
        STATE_RECORDING,
        STATE_STOPPING,
        STATE_SAVING,
        STATE_SAVED,
        STATE_FAILED,
        STATE_RECOVERABLE,
      ];
      for (const state of states) {
        expect(VALID_TRANSITIONS[state]).toBeDefined();
        expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true);
      }
    });
  });
});
