// Message schemas and validation for CaptureCast
// Phase 0.5: must be defined before any message consumer

// Message type constants
export const MSG_START = 'START';
export const MSG_STOP = 'STOP';
export const MSG_GET_STATE = 'GET_STATE';
export const MSG_OFFSCREEN_STARTED = 'OFFSCREEN_STARTED';
export const MSG_OFFSCREEN_DATA = 'OFFSCREEN_DATA';
export const MSG_RECORDER_DATA = 'RECORDER_DATA';
export const MSG_RECORDER_STARTED = 'RECORDER_STARTED';
export const MSG_OFFSCREEN_START = 'OFFSCREEN_START';
export const MSG_OFFSCREEN_STOP = 'OFFSCREEN_STOP';
export const MSG_RECORDER_STOP = 'RECORDER_STOP';
export const MSG_TAB_CLOSING = 'TAB_CLOSING';
export const MSG_PREVIEW_READY = 'PREVIEW_READY';
export const MSG_OFFSCREEN_ERROR = 'OFFSCREEN_ERROR';
export const MSG_OFFSCREEN_TEST = 'OFFSCREEN_TEST';
export const MSG_RECOVERY_RESUME = 'RECOVERY_RESUME';
export const MSG_RECOVERY_DISCARD = 'RECOVERY_DISCARD';

// Message schemas: required + optional fields per type (typed for strict validation)
export const schemas = {
  [MSG_START]: {
    required: [['type', 'string']],
    optional: [
      ['mode', 'string'],
      ['mic', 'boolean'],
      ['systemAudio', 'boolean'],
    ],
  },
  [MSG_STOP]: {
    required: [['type', 'string']],
    optional: [],
  },
  [MSG_GET_STATE]: {
    required: [['type', 'string']],
    optional: [],
  },
  [MSG_OFFSCREEN_STARTED]: {
    required: [['type', 'string']],
    optional: [
      ['recordingId', 'string'],
      ['strategy', 'string'],
    ],
  },
  [MSG_OFFSCREEN_DATA]: {
    required: [
      ['type', 'string'],
      ['recordingId', 'string'],
    ],
    optional: [],
  },
  [MSG_RECORDER_DATA]: {
    required: [
      ['type', 'string'],
      ['recordingId', 'string'],
    ],
    optional: [],
  },
  [MSG_RECORDER_STARTED]: {
    required: [['type', 'string']],
    optional: [
      ['recordingId', 'string'],
      ['strategy', 'string'],
    ],
  },
  [MSG_OFFSCREEN_START]: {
    required: [['type', 'string']],
    optional: [
      ['mode', 'string'],
      ['recordingId', 'string'],
      ['mic', 'boolean'],
      ['systemAudio', 'boolean'],
    ],
  },
  [MSG_OFFSCREEN_STOP]: {
    required: [['type', 'string']],
    optional: [],
  },
  [MSG_RECORDER_STOP]: {
    required: [['type', 'string']],
    optional: [],
  },
  [MSG_TAB_CLOSING]: {
    required: [['type', 'string']],
    optional: [['tabId', 'number']],
  },
  [MSG_PREVIEW_READY]: {
    required: [['type', 'string']],
    optional: [['recordingId', 'string']],
  },
  [MSG_OFFSCREEN_ERROR]: {
    required: [['type', 'string']],
    optional: [
      ['error', 'string'],
      ['recordingId', 'string'],
    ],
  },
  [MSG_OFFSCREEN_TEST]: {
    required: [['type', 'string']],
    optional: [],
  },
  [MSG_RECOVERY_RESUME]: {
    required: [['type', 'string']],
    optional: [['recordingId', 'string']],
  },
  [MSG_RECOVERY_DISCARD]: {
    required: [['type', 'string']],
    optional: [['recordingId', 'string']],
  },
  // Catch-all entry for unknown types with '*' field wildcard
  UNKNOWN: {
    required: [],
    optional: [['*', undefined]], // '*' = catch-all for unknown fields
  },
};

// State constants
export const STATE_IDLE = 'IDLE';
export const STATE_STARTING = 'STARTING';
export const STATE_PROMPTING = 'PROMPTING';
export const STATE_RECORDING = 'RECORDING';
export const STATE_STOPPING = 'STOPPING';
export const STATE_SAVING = 'SAVING';
export const STATE_SAVED = 'SAVED';
export const STATE_FAILED = 'FAILED';
export const STATE_RECOVERABLE = 'RECOVERABLE';

// Valid state transitions
export const VALID_TRANSITIONS = {
  [STATE_IDLE]: [STATE_STARTING],
  [STATE_STARTING]: [STATE_PROMPTING, STATE_RECORDING, STATE_IDLE],
  [STATE_PROMPTING]: [STATE_RECORDING, STATE_IDLE],
  [STATE_RECORDING]: [STATE_STOPPING],
  [STATE_STOPPING]: [STATE_SAVING, STATE_IDLE],
  [STATE_SAVING]: [STATE_SAVED, STATE_FAILED, STATE_RECOVERABLE, STATE_IDLE],
  [STATE_SAVED]: [STATE_IDLE],
  [STATE_FAILED]: [STATE_IDLE, STATE_RECOVERABLE],
  [STATE_RECOVERABLE]: [STATE_IDLE],
};

/**
 * Validate a message against its schema (strict mode - Phase 6).
 * Returns {valid: boolean, errors: string[]}
 * Fails on: missing required fields, extra unknown fields, wrong field types.
 * Types: 'string', 'boolean', 'number', 'object', 'array', 'undefined'
 */
export function validateMessageStrict(message, schema) {
  const errors = [];

  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message is not an object'] };
  }

  if (!message.type) {
    return { valid: false, errors: ['Message missing type field'] };
  }

  if (!schema) {
    return { valid: false, errors: [`Unknown message type: ${message.type}`] };
  }

  const hasCatchAll = schema.optional?.some(([key]) => key === '*');

  // Check required fields with type validation
  for (const [field, expectedType] of schema.required) {
    if (!(field in message) || message[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    } else if (expectedType !== undefined && typeof message[field] !== expectedType) {
      errors.push(
        `Field '${field}' must be type '${expectedType}', got '${typeof message[field]}'`
      );
    }
  }

  // Check for unknown fields (strict mode - reject extras unless catch-all exists)
  if (!hasCatchAll) {
    const allowedFields = new Set([
      ...schema.required.map(([f]) => f),
      ...(schema.optional?.map(([f]) => f).filter((f) => f !== '*') || []),
    ]);

    for (const key of Object.keys(message)) {
      if (!allowedFields.has(key)) {
        errors.push(`Unknown field: ${key}`);
      }
    }
  }

  // Validate optional field types
  for (const [field, expectedType] of schema.optional || []) {
    if (field === '*') continue; // Skip catch-all
    if (field in message && message[field] !== undefined && expectedType !== undefined) {
      if (typeof message[field] !== expectedType) {
        errors.push(
          `Optional field '${field}' must be type '${expectedType}', got '${typeof message[field]}'`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Alias for loose validation (Phase 1+)
// Loose mode: validates known types, warns for unknown types but returns valid
// This allows unknown message types (like OFFSCREEN_START) to pass through during testing
// while still validating schema for known types
export function validateMessage(message, schema) {
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message is not an object'] };
  }

  if (!message.type) {
    return { valid: false, errors: ['Message missing type field'] };
  }

  // No schema = unknown type (loose mode: pass through with warning)
  if (!schema) {
    return { valid: true, errors: [`Unknown message type: ${message.type}`] };
  }

  return validateMessageStrict(message, schema);
}

/**
 * Validate a state transition.
 * Returns {valid: boolean, error: string}
 */
export function validateStateTransition(current, next) {
  if (!VALID_TRANSITIONS[current]) {
    return { valid: false, error: `Unknown current state: ${current}` };
  }

  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    return {
      valid: false,
      error: `Invalid transition: ${current} → ${next}. Allowed: ${allowed.join(', ') || 'none'}`,
    };
  }

  return { valid: true, error: null };
}
