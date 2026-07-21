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
export const MSG_RECORDER_ERROR = 'RECORDER_ERROR';
export const MSG_OFFSCREEN_TEST = 'OFFSCREEN_TEST';
export const MSG_RECOVERY_RESUME = 'RECOVERY_RESUME';
export const MSG_RECOVERY_DISCARD = 'RECOVERY_DISCARD';

const RECORDING_MODES = ['tab', 'window', 'screen'];

// Message schemas: required + optional fields per type (typed for strict validation)
export const schemas = {
  [MSG_START]: {
    required: [
      ['type', 'string'],
      ['mode', 'string', RECORDING_MODES],
    ],
    optional: [
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
      ['mimeType', 'string'],
    ],
    optional: [],
  },
  [MSG_RECORDER_DATA]: {
    required: [
      ['type', 'string'],
      ['recordingId', 'string'],
      ['mimeType', 'string'],
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
    required: [
      ['type', 'string'],
      ['mode', 'string', RECORDING_MODES],
      ['recordingId', 'string'],
      ['includeAudio', 'boolean'],
    ],
    optional: [['targetTabId', 'number']],
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
    required: [
      ['type', 'string'],
      ['tabId', 'number'],
    ],
    optional: [],
  },
  [MSG_PREVIEW_READY]: {
    required: [['type', 'string']],
    optional: [['recordingId', 'string']],
  },
  [MSG_OFFSCREEN_ERROR]: {
    required: [
      ['type', 'string'],
      ['error', 'object'],
      ['recordingId', 'string'],
    ],
    optional: [['code', 'string']],
  },
  [MSG_RECORDER_ERROR]: {
    required: [
      ['type', 'string'],
      ['error', 'object'],
      ['recordingId', 'string'],
    ],
    optional: [['code', 'string']],
  },
  [MSG_OFFSCREEN_TEST]: {
    required: [['type', 'string']],
    optional: [],
  },
  [MSG_RECOVERY_RESUME]: {
    required: [
      ['type', 'string'],
      ['recordingId', 'string'],
    ],
    optional: [],
  },
  [MSG_RECOVERY_DISCARD]: {
    required: [
      ['type', 'string'],
      ['recordingId', 'string'],
    ],
    optional: [],
  },
  // Catch-all entry for unknown types with '*' field wildcard
  UNKNOWN: {
    required: [],
    optional: [['*', undefined]], // '*' = catch-all for unknown fields
  },
};

function validateFieldValue(message, field, expectedType, allowedValues, label) {
  const errors = [];
  if (expectedType !== undefined && typeof message[field] !== expectedType) {
    errors.push(
      `${label} '${field}' must be type '${expectedType}', got '${typeof message[field]}'`
    );
  } else if (allowedValues && !allowedValues.includes(message[field])) {
    errors.push(`${label} '${field}' must be one of: ${allowedValues.join(', ')}`);
  }
  return errors;
}

function validateRequiredFields(message, requiredFields) {
  const errors = [];
  for (const [field, expectedType, allowedValues] of requiredFields) {
    if (!(field in message) || message[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }
    errors.push(...validateFieldValue(message, field, expectedType, allowedValues, 'Field'));
  }
  return errors;
}

function validateUnknownFields(message, schema) {
  const hasCatchAll = schema.optional?.some(([key]) => key === '*');
  if (hasCatchAll) return [];

  const allowedFields = new Set([
    ...schema.required.map(([field]) => field),
    ...(schema.optional?.map(([field]) => field).filter((field) => field !== '*') || []),
  ]);

  return Object.keys(message)
    .filter((key) => !allowedFields.has(key))
    .map((key) => `Unknown field: ${key}`);
}

function validateOptionalFields(message, optionalFields = []) {
  const errors = [];
  for (const [field, expectedType, allowedValues] of optionalFields) {
    if (field === '*' || !(field in message) || message[field] === undefined) continue;
    errors.push(
      ...validateFieldValue(message, field, expectedType, allowedValues, 'Optional field')
    );
  }
  return errors;
}

/**
 * Validate a message against its schema (strict mode - Phase 6).
 * Returns {valid: boolean, errors: string[]}
 * Fails on: missing required fields, extra unknown fields, wrong field types.
 * Types: 'string', 'boolean', 'number', 'object', 'array', 'undefined'
 */
export function validateMessageStrict(message, schema) {
  if (!message || typeof message !== 'object') {
    return { valid: false, errors: ['Message is not an object'] };
  }

  if (!message.type) {
    return { valid: false, errors: ['Message missing type field'] };
  }

  if (!schema) {
    return { valid: false, errors: [`Unknown message type: ${message.type}`] };
  }

  const errors = [
    ...validateRequiredFields(message, schema.required),
    ...validateUnknownFields(message, schema),
    ...validateOptionalFields(message, schema.optional),
  ];

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
