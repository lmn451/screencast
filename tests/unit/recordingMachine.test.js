/**
 * XState v5 Recording Machine Tests
 * Jest compatible version - no TypeScript syntax
 * 
 * Note: In XState v5, global `on` handlers use relative targets (e.g., '.idle')
 */

import { createActor, createMachine } from 'xstate';

// Recording machine with global RESET handler
// Note: In XState v5, global on handlers need to use .stateName for relative targets
const recordingMachine = createMachine({
  id: 'recording',
  initial: 'idle',
  context: {
    recordingId: null,
    correlationId: null,
  },
  states: {
    idle: {
      on: {
        START: { target: 'starting' },
        RESET: { target: 'idle' }, // Allow reset from idle
      },
    },
    starting: {
      on: {
        CONFIRMATION_TIMEOUT: { target: 'recording' },
        STOP: { target: 'idle' },
        RESET: { target: 'idle' },
      },
    },
    recording: {
      on: {
        STOP: { target: 'stopping' },
        RESET: { target: 'idle' },
      },
    },
    stopping: {
      on: {
        STOP: { target: 'stopping' }, // Idempotent
        RESET: { target: 'idle' },
      },
    },
  },
});

describe('Recording State Machine', () => {
  let actor;

  afterEach(() => {
    if (actor) {
      actor.stop();
    }
  });

  test('should start in idle state', () => {
    actor = createActor(recordingMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe('idle');
  });

  test('should transition to starting on START event', () => {
    actor = createActor(recordingMachine);
    actor.start();
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
  });

  test('should transition to recording on CONFIRMATION_TIMEOUT', () => {
    actor = createActor(recordingMachine);
    actor.start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('recording');
  });

  test('should transition to stopping on STOP', () => {
    actor = createActor(recordingMachine);
    actor.start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');
  });

  test('should allow START from idle', () => {
    actor = createActor(recordingMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe('idle');
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
  });

  test('should allow STOP from recording', () => {
    actor = createActor(recordingMachine);
    actor.start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');
  });

  test('should be idempotent for STOP during stopping', () => {
    actor = createActor(recordingMachine);
    actor.start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');
  });

  test('should go back to idle on RESET from any state', () => {
    actor = createActor(recordingMachine);
    actor.start();
    
    // From idle (should stay idle)
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().value).toBe('idle');
    
    // Start and reset from starting
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
    
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().value).toBe('idle');
    
    // Start again and reset from recording
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('recording');
    
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().value).toBe('idle');
  });

  test('should initialize context correctly', () => {
    actor = createActor(recordingMachine);
    actor.start();
    
    const snapshot = actor.getSnapshot();
    expect(snapshot.context.recordingId).toBeNull();
    expect(snapshot.context.correlationId).toBeNull();
  });
});

describe('State Transition Validation', () => {
  test('complete recording flow: idle -> starting -> recording -> stopping', () => {
    const actor = createActor(recordingMachine);
    actor.start();
    
    // Start recording
    expect(actor.getSnapshot().value).toBe('idle');
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
    
    // Recording confirmed (via timeout for this test)
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    expect(actor.getSnapshot().value).toBe('recording');
    
    // Stop recording
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('stopping');
    
    actor.stop();
  });

  test('abort start by stopping during starting', () => {
    const actor = createActor(recordingMachine);
    actor.start();
    
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
    
    // User cancelled before confirmation
    actor.send({ type: 'STOP' });
    expect(actor.getSnapshot().value).toBe('idle');
    
    actor.stop();
  });
});

describe('Event Handling', () => {
  test('RESET should work from any state', () => {
    const actor = createActor(recordingMachine);
    actor.start();
    
    // idle -> starting
    actor.send({ type: 'START', mode: 'tab' });
    expect(actor.getSnapshot().value).toBe('starting');
    
    // Reset from starting
    actor.send({ type: 'RESET' });
    expect(actor.getSnapshot().value).toBe('idle');
    
    actor.stop();
  });

  test('STOP is idempotent in stopping state', () => {
    const actor = createActor(recordingMachine);
    actor.start();
    
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    
    const first = actor.getSnapshot().value;
    actor.send({ type: 'STOP' });
    const second = actor.getSnapshot().value;
    
    expect(first).toBe('stopping');
    expect(second).toBe('stopping');
    
    actor.stop();
  });
});