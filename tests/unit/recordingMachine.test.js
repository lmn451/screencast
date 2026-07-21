/**
 * Unit tests for the real recording state machine (src/machines/recordingMachine.ts).
 * Exercises every transition and guard the service layer relies on.
 *
 * Note: these tests use jest.useFakeTimers so the machine's `after`-based
 * transition out of `saved` (1000 ms) doesn't fire mid-assertion.
 */

import { jest } from '@jest/globals';
import { createActor } from 'xstate';
import { recordingMachine } from '../../src/machines/recordingMachine.ts';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ANOTHER_UUID = '11111111-2222-3333-4444-555555555555';

function startActor() {
  const actor = createActor(recordingMachine);
  actor.start();
  return actor;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('recordingMachine — initial state', () => {
  it('starts in idle', () => {
    const actor = startActor();
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('idle context is cleared', () => {
    const actor = startActor();
    const { context } = actor.getSnapshot();
    expect(context.recordingId).toBeNull();
    expect(context.correlationId).toBeNull();
    expect(context.strategy).toBeNull();
    expect(context.failedChunkCount).toBe(0);
    actor.stop();
  });
});

describe('recordingMachine — happy path (idle → starting → recording → stopping → saved → idle)', () => {
  it('walks the full lifecycle and resets to idle', () => {
    const actor = startActor();

    actor.send({ type: 'START', mode: 'tab', mic: false, systemAudio: false });
    expect(actor.getSnapshot().value).toBe('starting');

    const startingCtx = actor.getSnapshot().context;
    expect(startingCtx.recordingId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(startingCtx.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(startingCtx.options.mode).toBe('tab');
    expect(startingCtx.strategy).toBe('offscreen'); // determineStrategy: mic=false → offscreen

    actor.send({ type: 'OFFSCREEN_STARTED' });
    expect(actor.getSnapshot().value).toBe('recording');

    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');

    actor.send({ type: 'OFFSCREEN_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });
    expect(actor.getSnapshot().value).toBe('saved');

    // saved auto-transitions back to idle after 1000 ms (machine `after`).
    jest.advanceTimersByTime(1000);
    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context.recordingId).toBeNull(); // cleared on idle entry

    actor.stop();
  });

  it('uses page strategy when mic is included', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab', mic: true, systemAudio: false });
    expect(actor.getSnapshot().context.strategy).toBe('page');
    actor.stop();
  });

  it('RECORDER_DATA from stopping → saved (page strategy path)', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab', mic: true });
    actor.send({ type: 'RECORDER_STARTED' });
    expect(actor.getSnapshot().value).toBe('recording');
    actor.send({ type: 'STOP' });
    actor.send({ type: 'RECORDER_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });
    expect(actor.getSnapshot().value).toBe('saved');
    actor.stop();
  });

  it('OFFSCREEN_DATA from recording → saved for browser auto-stop', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab', mic: false });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    expect(actor.getSnapshot().value).toBe('recording');

    actor.send({ type: 'OFFSCREEN_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });

    expect(actor.getSnapshot().value).toBe('saved');
    actor.stop();
  });

  it('RECORDER_DATA from recording → saved for browser auto-stop', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab', mic: true });
    actor.send({ type: 'RECORDER_STARTED' });
    expect(actor.getSnapshot().value).toBe('recording');

    actor.send({ type: 'RECORDER_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });

    expect(actor.getSnapshot().value).toBe('saved');
    actor.stop();
  });
});

describe('recordingMachine — starting state', () => {
  it('CONFIRMATION_TIMEOUT transitions starting → recording', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('recording');
    actor.stop();
  });

  it('STOP from starting cancels back to idle', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('OFFSCREEN_ERROR from starting transitions to failed and sets error', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'Permission denied' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('Permission denied');
    actor.stop();
  });

  it('RECORDER_ERROR from starting transitions to failed', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'RECORDER_ERROR', error: 'Tab closed' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('Tab closed');
    actor.stop();
  });

  it('OFFSCREEN_DATA from starting transitions to saved', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });
    expect(actor.getSnapshot().value).toBe('saved');
    actor.stop();
  });

  it('RECORDER_DATA from starting transitions to saved', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab', mic: true });
    actor.send({ type: 'RECORDER_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });
    expect(actor.getSnapshot().value).toBe('saved');
    actor.stop();
  });
});

describe('recordingMachine — recording state', () => {
  function toRecording() {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    return actor;
  }

  it('CHUNK_FAILED increments failedChunkCount', () => {
    const actor = toRecording();
    expect(actor.getSnapshot().context.failedChunkCount).toBe(0);
    actor.send({ type: 'CHUNK_FAILED' });
    actor.send({ type: 'CHUNK_FAILED' });
    actor.send({ type: 'CHUNK_FAILED' });
    expect(actor.getSnapshot().context.failedChunkCount).toBe(3);
    expect(actor.getSnapshot().value).toBe('recording'); // still recording
    actor.stop();
  });

  it('OVERLAY_TAB_CLOSED transitions recording to failed', () => {
    const actor = toRecording();
    actor.send({ type: 'OVERLAY_TAB_CLOSED' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('Tab closed during recording');
    actor.stop();
  });

  it('RECORDER_TAB_CLOSED transitions recording to failed', () => {
    const actor = toRecording();
    actor.send({ type: 'RECORDER_TAB_CLOSED' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('Tab closed during recording');
    actor.stop();
  });

  it('OFFSCREEN_ERROR transitions recording → failed', () => {
    const actor = toRecording();
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'GUM crashed' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('GUM crashed');
    actor.stop();
  });

  it('UPDATE_STATE refreshes lastActivityAt without changing state', () => {
    const actor = toRecording();
    const before = actor.getSnapshot().context.lastActivityAt;
    jest.advanceTimersByTime(100);
    actor.send({ type: 'UPDATE_STATE' });
    const after = actor.getSnapshot().context.lastActivityAt;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(actor.getSnapshot().value).toBe('recording');
    actor.stop();
  });
});

describe('recordingMachine — stopping state', () => {
  function toStopping() {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    actor.send({ type: 'STOP' });
    return actor;
  }

  it('is idempotent for repeated STOP events', () => {
    const actor = toStopping();
    expect(actor.getSnapshot().value).toBe('stopping');
    actor.send({ type: 'STOP' });
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');
    actor.stop();
  });

  it('SAVE_TIMEOUT transitions stopping → recoverable', () => {
    const actor = toStopping();
    actor.send({ type: 'SAVE_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('recoverable');
    actor.stop();
  });

  it('OFFSCREEN_ERROR transitions stopping → failed', () => {
    const actor = toStopping();
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'stop failed' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('stop failed');
    actor.stop();
  });

  it('RECORDER_ERROR transitions stopping → failed', () => {
    const actor = toStopping();
    actor.send({ type: 'RECORDER_ERROR', error: 'recorder failed' });
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().context.error).toBe('recorder failed');
    actor.stop();
  });
});

describe('recordingMachine — recoverable state guards', () => {
  function toRecoverable() {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    actor.send({ type: 'STOP' });
    actor.send({ type: 'SAVE_TIMEOUT' });
    return actor;
  }

  it('RECOVERY_RESUME with a valid UUID transitions to recording', () => {
    const actor = toRecoverable();
    actor.send({ type: 'RECOVERY_RESUME', recordingId: VALID_UUID });
    expect(actor.getSnapshot().value).toBe('recording');
    actor.stop();
  });

  it('RECOVERY_RESUME with an invalid UUID is rejected by guard', () => {
    const actor = toRecoverable();
    actor.send({ type: 'RECOVERY_RESUME', recordingId: 'not-a-uuid' });
    expect(actor.getSnapshot().value).toBe('recoverable');
    actor.stop();
  });

  it('RECOVERY_RESUME without recordingId is rejected by guard', () => {
    const actor = toRecoverable();
    actor.send({ type: 'RECOVERY_RESUME' });
    expect(actor.getSnapshot().value).toBe('recoverable');
    actor.stop();
  });

  it('RECOVERY_DISCARD transitions to idle', () => {
    const actor = toRecoverable();
    actor.send({ type: 'RECOVERY_DISCARD', recordingId: VALID_UUID });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('late OFFSCREEN_DATA transitions recoverable → saved', () => {
    const actor = toRecoverable();
    actor.send({ type: 'OFFSCREEN_DATA', recordingId: VALID_UUID, mimeType: 'video/webm' });
    expect(actor.getSnapshot().value).toBe('saved');
    actor.stop();
  });

  it('RESET also bails out to idle', () => {
    const actor = toRecoverable();
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });
});

describe('recordingMachine — failed state', () => {
  function toFailed() {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'boom' });
    return actor;
  }

  it('RESET from failed → idle', () => {
    const actor = toFailed();
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });

  it('RECOVERY_DISCARD from failed → idle', () => {
    const actor = toFailed();
    actor.send({ type: 'RECOVERY_DISCARD', recordingId: VALID_UUID });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.stop();
  });
});

describe('recordingMachine — RECONCILE from idle', () => {
  it('hydrates the machine from a persisted snapshot and lands in recording', () => {
    const actor = startActor();
    const snapshot = {
      recordingId: ANOTHER_UUID,
      status: 'recording',
      startedAt: 1700000000000,
      lastActivityAt: 1700000005000,
      options: { mode: 'screen', includeMic: true, includeSystemAudio: false },
      strategy: 'page',
      correlationId: VALID_UUID,
    };
    actor.send({ type: 'RECONCILE', snapshot });

    expect(actor.getSnapshot().value).toBe('recording');
    const ctx = actor.getSnapshot().context;
    expect(ctx.recordingId).toBe(ANOTHER_UUID);
    expect(ctx.strategy).toBe('page');
    expect(ctx.options.mode).toBe('screen');
    expect(ctx.correlationId).toBe(VALID_UUID);
    actor.stop();
  });
});

describe('recordingMachine — global RESET', () => {
  it('RESET from any state returns to idle', () => {
    const states = [
      (a) => a.send({ type: 'START', mode: 'tab' }),
      (a) => a.send({ type: 'OFFSCREEN_STARTED' }),
      (a) => a.send({ type: 'STOP' }),
      (a) => a.send({ type: 'SAVE_TIMEOUT' }),
    ];

    for (const drive of states) {
      const actor = startActor();
      drive(actor);
      actor.send({ type: 'RESET' });
      expect(actor.getSnapshot().value).toBe('idle');
      actor.stop();
    }
  });

  it('RECOVERY_DISCARD from active recording returns to idle', () => {
    const actor = startActor();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    expect(actor.getSnapshot().value).toBe('recording');

    actor.send({ type: 'RECOVERY_DISCARD', recordingId: VALID_UUID });

    expect(actor.getSnapshot().value).toBe('idle');
    expect(actor.getSnapshot().context.recordingId).toBeNull();
    actor.stop();
  });
});
