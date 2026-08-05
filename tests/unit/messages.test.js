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
  MSG_RECORDER_ERROR,
  MSG_TAB_CLOSING,
  MSG_PREVIEW_READY,
  MSG_OFFSCREEN_ERROR,
  MSG_OFFSCREEN_TEST,
  MSG_RECOVERY_DISCARD,
  MSG_STATE_UPDATE,
  MSG_OVERLAY_REMOVE,
  RECORDING_STATUSES,
  OUTBOUND_CONTROL_MESSAGES,
  schemas,
  validateMessage,
  buildMessage,
} from '../../src/messages.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

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

    it('should reject recovery discard without recordingId', () => {
      const result = validateMessage({ type: MSG_RECOVERY_DISCARD }, schemas[MSG_RECOVERY_DISCARD]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: recordingId');
    });

    it('should reject start acknowledgments without recordingId', () => {
      const offscreenResult = validateMessage(
        { type: MSG_OFFSCREEN_STARTED },
        schemas[MSG_OFFSCREEN_STARTED]
      );
      const recorderResult = validateMessage(
        { type: MSG_RECORDER_STARTED },
        schemas[MSG_RECORDER_STARTED]
      );

      expect(offscreenResult.valid).toBe(false);
      expect(recorderResult.valid).toBe(false);
      expect(offscreenResult.errors).toContain('Missing required field: recordingId');
      expect(recorderResult.errors).toContain('Missing required field: recordingId');
    });

    it('should validate the real OFFSCREEN_START payload', () => {
      const msg = {
        type: MSG_OFFSCREEN_START,
        mode: 'tab',
        recordingId: '550e8400-e29b-41d4-a716-446655440000',
        includeAudio: false,
        bestQuality: true,
        targetTabId: 42,
      };
      const schema = schemas[MSG_OFFSCREEN_START];
      const result = validateMessage(msg, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject RECORDER_ERROR without recordingId', () => {
      const msg = {
        type: MSG_RECORDER_ERROR,
        error: {
          ok: false,
          code: 'screen-permission-denied',
          userMessage: 'No permission',
        },
      };

      const result = validateMessage(msg, schemas[MSG_RECORDER_ERROR]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: recordingId');
    });

    it('should reject RECORDER_ERROR with non-object error payload', () => {
      const msg = {
        type: MSG_RECORDER_ERROR,
        error: 'failed',
        recordingId: VALID_UUID,
      };

      const result = validateMessage(msg, schemas[MSG_RECORDER_ERROR]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Field 'error' must be type 'object', got 'string'");
    });

    it('should reject OFFSCREEN_ERROR without recordingId', () => {
      const msg = {
        type: MSG_OFFSCREEN_ERROR,
        error: {
          ok: false,
          code: 'screen-permission-denied',
          userMessage: 'No permission',
        },
      };

      const result = validateMessage(msg, schemas[MSG_OFFSCREEN_ERROR]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: recordingId');
    });

    it('should reject OFFSCREEN_ERROR with non-object error payload', () => {
      const msg = {
        type: MSG_OFFSCREEN_ERROR,
        error: 'failed',
        recordingId: VALID_UUID,
      };

      const result = validateMessage(msg, schemas[MSG_OFFSCREEN_ERROR]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Field 'error' must be type 'object', got 'string'");
    });
  });

  describe('All message schemas', () => {
    it('should have START schema with required and optional fields', () => {
      expect(schemas[MSG_START]).toBeDefined();
      expect(schemas[MSG_START].required.map(([f]) => f)).toContain('type');
      expect(schemas[MSG_START].required.map(([f]) => f)).toContain('mode');
      expect(schemas[MSG_START].optional.map(([f]) => f)).toContain('bestQuality');
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

    it('should have OFFSCREEN_STARTED schema with required recordingId', () => {
      const requiredFields = schemas[MSG_OFFSCREEN_STARTED].required.map(([field]) => field);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('recordingId');
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

    it('should have RECORDER_STARTED schema with required recordingId', () => {
      const requiredFields = schemas[MSG_RECORDER_STARTED].required.map(([field]) => field);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('recordingId');
    });

    it('should have OFFSCREEN_START schema', () => {
      expect(schemas[MSG_OFFSCREEN_START]).toBeDefined();
      const requiredFields = schemas[MSG_OFFSCREEN_START].required.map(([f]) => f);
      expect(requiredFields).toEqual(['type', 'mode', 'recordingId', 'includeAudio']);
      expect(schemas[MSG_OFFSCREEN_START].optional.map(([f]) => f)).toContain('targetTabId');
      expect(schemas[MSG_OFFSCREEN_START].optional.map(([f]) => f)).toContain('bestQuality');
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
      expect(schemas[MSG_OFFSCREEN_ERROR].required.map(([f]) => f)).toContain('error');
      expect(schemas[MSG_OFFSCREEN_ERROR].required.map(([f]) => f)).toContain('recordingId');
    });

    it('should have RECORDER_ERROR schema', () => {
      expect(schemas[MSG_RECORDER_ERROR]).toBeDefined();
      const requiredFields = schemas[MSG_RECORDER_ERROR].required.map(([f]) => f);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('error');
      expect(requiredFields).toContain('recordingId');
    });

    it('should have OFFSCREEN_TEST schema', () => {
      expect(schemas[MSG_OFFSCREEN_TEST]).toBeDefined();
      expect(schemas[MSG_OFFSCREEN_TEST].required.map(([f]) => f)).toContain('type');
    });

    it('should have a recovery discard schema with required recordingId', () => {
      const requiredFields = schemas[MSG_RECOVERY_DISCARD].required.map(([field]) => field);
      expect(requiredFields).toContain('type');
      expect(requiredFields).toContain('recordingId');
    });

    it('should have STATE_UPDATE schema restricted to machine statuses', () => {
      expect(schemas[MSG_STATE_UPDATE]).toBeDefined();
      const [, , allowed] = schemas[MSG_STATE_UPDATE].required.find(([f]) => f === 'status');
      expect(allowed).toEqual(RECORDING_STATUSES);
      expect(RECORDING_STATUSES).toContain('starting');
      expect(RECORDING_STATUSES).toContain('recording');
      expect(RECORDING_STATUSES).toContain('stopping');
    });

    it('should have OVERLAY_REMOVE schema', () => {
      expect(schemas[MSG_OVERLAY_REMOVE]).toBeDefined();
      expect(schemas[MSG_OVERLAY_REMOVE].required.map(([f]) => f)).toContain('type');
    });
  });

  describe('constants ↔ schemas parity', () => {
    it('every MSG_ constant has a schema and every schema key has a constant', async () => {
      const mod = await import('../../src/messages.js');
      const constantValues = Object.entries(mod)
        .filter(([name]) => name.startsWith('MSG_'))
        .map(([, value]) => value);
      const schemaKeys = Object.keys(mod.schemas).filter((key) => key !== 'UNKNOWN');

      // Both directions: a constant without a schema means senders can build
      // messages every receiver rejects; a schema without a constant means
      // receivers accept messages nobody can send without a magic string.
      expect([...constantValues].sort()).toEqual([...schemaKeys].sort());
    });

    it('OUTBOUND_CONTROL_MESSAGES only contains registered message types', () => {
      for (const type of OUTBOUND_CONTROL_MESSAGES) {
        expect(schemas[type]).toBeDefined();
      }
    });
  });

  describe('buildMessage', () => {
    it('builds and validates a STATE_UPDATE message', () => {
      expect(buildMessage(MSG_STATE_UPDATE, { status: 'recording' })).toEqual({
        type: MSG_STATE_UPDATE,
        status: 'recording',
      });
    });

    it('builds field-less messages without a fields argument', () => {
      expect(buildMessage(MSG_OVERLAY_REMOVE)).toEqual({ type: MSG_OVERLAY_REMOVE });
    });

    it('throws on a status outside the machine contract', () => {
      expect(() => buildMessage(MSG_STATE_UPDATE, { status: 'exploding' })).toThrow(
        /buildMessage\(STATE_UPDATE\)/
      );
    });

    it('throws when required fields are missing', () => {
      expect(() => buildMessage(MSG_OFFSCREEN_DATA, { mimeType: 'video/webm' })).toThrow(
        /Missing required field: recordingId/
      );
    });

    it('throws on unregistered message types', () => {
      expect(() => buildMessage('NOT_A_REAL_TYPE')).toThrow(/Unknown message type/);
    });

    it('omits undefined optional fields instead of failing validation', () => {
      const msg = buildMessage(MSG_OFFSCREEN_START, {
        mode: 'tab',
        recordingId: VALID_UUID,
        includeAudio: false,
        bestQuality: false,
        targetTabId: undefined,
      });
      expect('targetTabId' in msg).toBe(false);
    });

    it('rejects fields outside the schema', () => {
      expect(() => buildMessage(MSG_STOP, { recordingId: VALID_UUID })).toThrow(
        /Unknown field: recordingId/
      );
    });
  });
});
