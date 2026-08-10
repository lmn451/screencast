/**
 * Typed contract for src/messages.js.
 *
 * Every runtime message exchanged between extension contexts (popup, consent,
 * background, offscreen document, recorder tab, overlay content script) is a
 * member of `ExtensionMessage`. TypeScript consumers (background.ts,
 * recordingService.ts) resolve `import ... from '../messages.js'` to this
 * file, so send sites are checked against the same schemas the receivers
 * validate with.
 *
 * Keep in sync with the schema registry in messages.js — the parity unit test
 * in tests/unit/messages.test.js fails if a constant, schema, or union member
 * is added without the others.
 */

export type RecordingMode = 'tab' | 'window' | 'screen';

/** Status values of the recording machine (src/machines/recordingMachine.ts). */
export type RecordingStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'saved'
  | 'failed'
  | 'recoverable';

/** Structured error payload produced by src/error-codes.js createError(). */
export interface StructuredError {
  ok: false;
  code: string;
  userMessage: string;
  technicalMessage: string;
  retryable: boolean;
  correlationId: string | null;
}

// ── UI → background ──────────────────────────────────────────────────────────
export interface StartMessage {
  type: 'START';
  mode: RecordingMode;
  mic?: boolean;
  systemAudio?: boolean;
  bestQuality?: boolean;
}
export interface StopMessage {
  type: 'STOP';
}
export interface GetStateMessage {
  type: 'GET_STATE';
}
export interface TabClosingMessage {
  type: 'TAB_CLOSING';
  tabId: number;
}
export interface PreviewReadyMessage {
  type: 'PREVIEW_READY';
  recordingId?: string;
}
export interface RecoveryDiscardMessage {
  type: 'RECOVERY_DISCARD';
  recordingId: string;
}

// ── recorder contexts → background ───────────────────────────────────────────
export interface OffscreenStartedMessage {
  type: 'OFFSCREEN_STARTED';
  recordingId: string;
  strategy?: string;
}
export interface RecorderStartedMessage {
  type: 'RECORDER_STARTED';
  recordingId: string;
  strategy?: string;
}
export interface OffscreenDataMessage {
  type: 'OFFSCREEN_DATA';
  recordingId: string;
  mimeType: string;
}
export interface RecorderDataMessage {
  type: 'RECORDER_DATA';
  recordingId: string;
  mimeType: string;
}
export interface OffscreenErrorMessage {
  type: 'OFFSCREEN_ERROR';
  error: StructuredError;
  recordingId: string;
  code?: string;
}
export interface RecorderErrorMessage {
  type: 'RECORDER_ERROR';
  error: StructuredError;
  recordingId: string;
  code?: string;
}
export interface OffscreenTestMessage {
  type: 'OFFSCREEN_TEST';
}
export interface HeartbeatMessage {
  type: 'HEARTBEAT';
  recordingId: string;
}

// ── background → recorder contexts (chrome.runtime.sendMessage broadcast) ────
export interface OffscreenStartMessage {
  type: 'OFFSCREEN_START';
  mode: RecordingMode;
  recordingId: string;
  includeAudio: boolean;
  targetTabId?: number;
  bestQuality?: boolean;
}
export interface OffscreenStopMessage {
  type: 'OFFSCREEN_STOP';
}
export interface RecorderStopMessage {
  type: 'RECORDER_STOP';
}

// ── background → overlay content script (chrome.tabs.sendMessage) ────────────
export interface StateUpdateMessage {
  type: 'STATE_UPDATE';
  status: RecordingStatus;
}
export interface OverlayRemoveMessage {
  type: 'OVERLAY_REMOVE';
}

export type ExtensionMessage =
  | StartMessage
  | StopMessage
  | GetStateMessage
  | TabClosingMessage
  | PreviewReadyMessage
  | RecoveryDiscardMessage
  | OffscreenStartedMessage
  | RecorderStartedMessage
  | OffscreenDataMessage
  | RecorderDataMessage
  | OffscreenErrorMessage
  | RecorderErrorMessage
  | OffscreenTestMessage
  | HeartbeatMessage
  | OffscreenStartMessage
  | OffscreenStopMessage
  | RecorderStopMessage
  | StateUpdateMessage
  | OverlayRemoveMessage;

export type MessageType = ExtensionMessage['type'];
export type MessageOfType<T extends MessageType> = Extract<ExtensionMessage, { type: T }>;
type MessageFields<T extends MessageType> = Omit<MessageOfType<T>, 'type'>;
type MessageFieldArgument<T extends MessageType> = keyof MessageFields<T> extends never
  ? Record<string, never>
  : MessageFields<T>;

// ── constants ─────────────────────────────────────────────────────────────────
export declare const MSG_START: 'START';
export declare const MSG_STOP: 'STOP';
export declare const MSG_GET_STATE: 'GET_STATE';
export declare const MSG_OFFSCREEN_STARTED: 'OFFSCREEN_STARTED';
export declare const MSG_OFFSCREEN_DATA: 'OFFSCREEN_DATA';
export declare const MSG_RECORDER_DATA: 'RECORDER_DATA';
export declare const MSG_RECORDER_STARTED: 'RECORDER_STARTED';
export declare const MSG_OFFSCREEN_START: 'OFFSCREEN_START';
export declare const MSG_OFFSCREEN_STOP: 'OFFSCREEN_STOP';
export declare const MSG_RECORDER_STOP: 'RECORDER_STOP';
export declare const MSG_TAB_CLOSING: 'TAB_CLOSING';
export declare const MSG_PREVIEW_READY: 'PREVIEW_READY';
export declare const MSG_OFFSCREEN_ERROR: 'OFFSCREEN_ERROR';
export declare const MSG_RECORDER_ERROR: 'RECORDER_ERROR';
export declare const MSG_OFFSCREEN_TEST: 'OFFSCREEN_TEST';
export declare const MSG_HEARTBEAT: 'HEARTBEAT';
export declare const MSG_RECOVERY_DISCARD: 'RECOVERY_DISCARD';
export declare const MSG_STATE_UPDATE: 'STATE_UPDATE';
export declare const MSG_OVERLAY_REMOVE: 'OVERLAY_REMOVE';

export declare const RECORDING_STATUSES: readonly RecordingStatus[];
export declare const OUTBOUND_CONTROL_MESSAGES: Set<string>;

// ── schemas & validation ─────────────────────────────────────────────────────
export interface MessageSchema {
  required: Array<[string, string?, readonly string[]?]>;
  optional: Array<[string, string?, readonly string[]?]>;
}
export declare const schemas: Record<MessageType | 'UNKNOWN', MessageSchema>;

export declare function validateMessageStrict(
  message: unknown,
  schema: MessageSchema | undefined
): { valid: boolean; errors: string[] };

export declare function validateMessage(
  message: unknown,
  schema: MessageSchema | undefined | null
): { valid: boolean; errors: string[] };

/**
 * Build an outbound message, validated against its schema at the send site.
 * Throws on contract violations. `undefined` field values are omitted.
 * The second argument is required whenever the message type has required fields.
 */
export declare function buildMessage<T extends MessageType>(
  ...args: Record<string, never> extends MessageFields<T>
    ? [type: T, fields?: MessageFieldArgument<T>]
    : [type: T, fields: MessageFieldArgument<T>]
): MessageOfType<T>;
