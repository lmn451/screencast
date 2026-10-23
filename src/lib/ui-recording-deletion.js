import { MSG_GET_STATE, MSG_RECOVERY_DISCARD } from '../messages.js';
import { readSessionOwner } from './session-metadata.ts';
import { deleteRecording } from './cleanup.js';

const LIVE_STATUSES = new Set(['starting', 'recording', 'stopping']);
const TERMINAL_RECOVERY_STATUSES = new Set(['failed', 'recoverable']);
const RECORDING_STATUSES = new Set([
  'idle',
  'starting',
  'recording',
  'stopping',
  'saving',
  'saved',
  'failed',
  'recoverable',
]);

function isCanonicalState(state) {
  if (
    !state ||
    typeof state !== 'object' ||
    state.ok !== true ||
    !RECORDING_STATUSES.has(state.status) ||
    typeof state.recording !== 'boolean' ||
    (state.recordingId !== null &&
      (typeof state.recordingId !== 'string' || state.recordingId.length === 0))
  ) {
    return false;
  }

  const isLiveStatus = LIVE_STATUSES.has(state.status);
  return state.recording === isLiveStatus && (!isLiveStatus || state.recordingId !== null);
}

/**
 * Delete a recording from a user-facing page only after checking canonical
 * service ownership at the time of the action. Live sessions are never stopped
 * here; terminal same-ID recovery sessions must be retired by the service first.
 * Persisted DB status is not an ownership signal: orphaned rows remain deletable.
 */
export async function deleteRecordingFromUI(recordingId) {
  if (typeof recordingId !== 'string' || recordingId.length === 0) {
    throw new Error('Invalid recording ID.');
  }

  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: MSG_GET_STATE });
  } catch {
    throw new Error('Could not confirm whether recording is active. Try again before deleting.');
  }

  if (!isCanonicalState(state)) {
    throw new Error('Could not confirm whether recording is active. Try again before deleting.');
  }

  if (LIVE_STATUSES.has(state.status) && state.recordingId === recordingId) {
    throw new Error('Stop the recording before deleting it.');
  }

  if (TERMINAL_RECOVERY_STATUSES.has(state.status) && state.recordingId === recordingId) {
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: MSG_RECOVERY_DISCARD,
        recordingId,
      });
    } catch {
      throw new Error('Could not clear the recovery session before deleting. Try again.');
    }

    if (!result || typeof result !== 'object' || result.ok !== true) {
      throw new Error('Could not clear the recovery session before deleting. Try again.');
    }
  }
  let owner;
  try {
    owner = await readSessionOwner();
  } catch {
    throw new Error('Could not verify the recording owner. Try again before deleting.');
  }

  if (owner?.status === 'active' && owner.recordingId === recordingId) {
    throw new Error('Stop the recording before deleting it.');
  }

  await deleteRecording(recordingId);
}
