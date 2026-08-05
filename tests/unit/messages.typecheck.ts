import {
  MSG_OFFSCREEN_START,
  MSG_STATE_UPDATE,
  MSG_STOP,
  buildMessage,
} from '../../src/messages.js';

buildMessage(MSG_STOP);
buildMessage(MSG_STOP, {});
buildMessage(MSG_STATE_UPDATE, { status: 'starting' });
buildMessage(MSG_OFFSCREEN_START, {
  mode: 'tab',
  recordingId: 'recording-id',
  includeAudio: true,
});
buildMessage(MSG_OFFSCREEN_START, {
  mode: 'tab',
  recordingId: 'recording-id',
  includeAudio: true,
  targetTabId: undefined,
});

// @ts-expect-error Fieldless messages reject extra fields.
buildMessage(MSG_STOP, { unexpected: true });

// @ts-expect-error Required fields reject explicit undefined.
buildMessage(MSG_STATE_UPDATE, { status: undefined });

// @ts-expect-error Unknown message types are not part of the contract.
buildMessage('UNKNOWN');

// @ts-expect-error STATE_UPDATE requires a status field.
buildMessage(MSG_STATE_UPDATE, {});

// @ts-expect-error Populated messages reject unexpected fields.
buildMessage(MSG_STATE_UPDATE, { status: 'starting', unexpected: true });
