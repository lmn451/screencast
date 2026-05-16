/**
 * XState v5 Usage Review Tests
 *
 * These tests verify that the xstate patterns used in the production
 * machine (recordingMachine.ts) are correct for xstate v5.31.0.
 *
 * The production machine currently uses `setup({...}).create()` which
 * is NOT a valid xstate v5 API — see test 1.
 */

import { setup, fromCallback, createMachine, createActor } from 'xstate';

// ═══════════════════════════════════════════════════════════════════
// TEST 1: setup({...}).create() is not a valid xstate v5 API
// ═══════════════════════════════════════════════════════════════════

describe('setup().create() API check', () => {
  test('setup() result does NOT have a .create() method', () => {
    const result = setup({ actions: {}, guards: {}, actors: {}, delays: {} });
    expect(typeof result.create).toBe('undefined');
    expect(typeof result.createMachine).toBe('function');
  });

  test('setup().create() throws TypeError at runtime — exactly like recordingMachine.ts:155', () => {
    expect(() => {
      setup({ actions: {}, guards: {}, actors: {}, delays: {} }).create();
    }).toThrow(TypeError);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 2: Actors must be proper actor logic (fromCallback etc.)
// ═══════════════════════════════════════════════════════════════════

describe('Actor format in setup()', () => {
  test('valid: fromCallback creates a properly working actor', () => {
    const machine = setup({
      actors: {
        worker: fromCallback(() => { /* no-op, stays alive */ }),
      },
    }).createMachine({
      initial: 'a',
      states: {
        a: { on: { GO: 'b' } },
        b: {
          invoke: { src: 'worker' },
          on: { TICK: 'c' },
        },
        c: {},
      },
    });

    const actor = createActor(machine).start();
    expect(actor.getSnapshot().value).toBe('a');
    actor.send({ type: 'GO' });
    expect(actor.getSnapshot().value).toBe('b');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 3: Empty callback actors do NOT trigger onDone
// ═══════════════════════════════════════════════════════════════════

describe('Empty callback actor completion', () => {
  test('fromCallback(() => {}) never triggers onDone — actor stays alive', () => {
    const machine = setup({
      actors: {
        noop: fromCallback(() => { /* empty */ }),
      },
    }).createMachine({
      initial: 'a',
      states: {
        a: { on: { GO: 'b' } },
        b: { invoke: { src: 'noop', onDone: 'c' } },
        c: {},
      },
    });

    const actor = createActor(machine).start();
    actor.send({ type: 'GO' });
    expect(actor.getSnapshot().value).toBe('b');

    // Even after microtasks settle, still in 'b'
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(actor.getSnapshot().value).toBe('b');
        resolve();
      }, 10);
    });
  });

  test('empty generator callback also never triggers onDone', () => {
    const machine = setup({
      actors: {
        noopGen: fromCallback(function* () { /* empty generator */ }),
      },
    }).createMachine({
      initial: 'a',
      states: {
        a: { on: { GO: 'b' } },
        b: { invoke: { src: 'noopGen', onDone: 'c' } },
        c: {},
      },
    });

    const actor = createActor(machine).start();
    actor.send({ type: 'GO' });
    expect(actor.getSnapshot().value).toBe('b');
  });

  test('PRODUCTION BUG: empty callback actor means onDone never fires — timer must be external', () => {
    const machine = setup({
      actors: {
        confirmationTimeoutCallback: fromCallback(function* () {
          // Exactly as in recordingMachine.ts — empty generator
        }),
      },
    }).createMachine({
      initial: 'starting',
      states: {
        starting: {
          invoke: { src: 'confirmationTimeoutCallback', onDone: 'recording' },
          on: {
            CONFIRMATION_TIMEOUT: 'recording',
            OFFSCREEN_ERROR: 'failed',
          },
        },
        recording: {},
        failed: {},
      },
    });

    const actor = createActor(machine).start();
    expect(actor.getSnapshot().value).toBe('starting');

    return new Promise((resolve) => {
      setTimeout(() => {
        // Stays in 'starting' because onDone never fires
        expect(actor.getSnapshot().value).toBe('starting');

        // The REAL way it transitions: external CONFIRMATION_TIMEOUT event
        actor.send({ type: 'CONFIRMATION_TIMEOUT' });
        expect(actor.getSnapshot().value).toBe('recording');
        resolve();
      }, 10);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 4: Named actors must be reachable from the machine
// ═══════════════════════════════════════════════════════════════════

describe('Named actor resolution', () => {
  test('valid: actors defined in setup are available via chained .createMachine()', () => {
    const machine = setup({
      actors: {
        worker: fromCallback(() => {}),
      },
    }).createMachine({
      initial: 'a',
      states: {
        a: { on: { GO: 'b' } },
        b: { invoke: { src: 'worker' } },
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: 'GO' });
    expect(actor.getSnapshot().value).toBe('b');
  });

  test('PRODUCTION BUG: standalone createMachine() silently ignores orphan named actors', () => {
    // The production machine uses:
    //   1) const actions = setup({ actors: { ... } }).create()  ← CRASHES
    //   2) export const recordingMachine = createMachine({ ... }) ← standalone
    //
    // Even if #1 were fixed, the standalone createMachine() call has
    // NO access to actors defined in setup(). xstate v5 silently
    // ignores orphan named actors — the machine sits in the invoking
    // state forever with NO error or transition.
    //
    // This means the invoke would never fire onDone in the production
    // machine even if setup() didn't crash.
    const machine = createMachine({
      initial: 'a',
      states: {
        a: { on: { GO: 'b' } },
        b: { invoke: { src: 'orphanActor', onDone: 'c' } },
        c: {},
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: 'GO' });

    // Machine sits in 'b' forever because orphanActor is not registered
    expect(actor.getSnapshot().value).toBe('b');
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST 5: The correct xstate v5 pattern (reference)
// ═══════════════════════════════════════════════════════════════════

describe('Correct xstate v5 pattern (reference)', () => {
  test('setup + createMachine chained with fromCallback works', () => {
    const machine = setup({
      actors: {
        ticker: fromCallback(({ sendBack }) => {
          sendBack({ type: 'TICK' });
        }),
      },
    }).createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: { src: 'ticker' },
          on: {
            TICK: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    const actor = createActor(machine).start();
    // ticker sends TICK immediately via sendBack
    expect(actor.getSnapshot().value).toBe('done');
  });
});
