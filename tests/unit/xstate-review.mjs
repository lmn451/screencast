#!/usr/bin/env node
/**
 * XState v5 Production Machine Smoke Test
 *
 * Directly imports the REAL recordingMachine from TypeScript source
 * using tsx and verifies all state transitions work correctly.
 *
 * Run: npx tsx tests/unit/xstate-review.mjs
 */

import { createActor } from 'xstate';

let passed = 0;
let failed = 0;

function assert(condition, desc) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.log(`  ✕ ${desc}`);
  }
}

function assertEqual(actual, expected, desc) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    failed++;
    console.log(
      `  ✕ ${desc} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

async function main() {
  console.log('\n=== Production recordingMachine Smoke Test ===\n');

  let recordingMachine;
  try {
    const mod = await import('../../src/machines/recordingMachine.ts');
    recordingMachine = mod.recordingMachine;
    console.log('✓ Module loaded successfully\n');
  } catch (e) {
    console.log(`✕ MODULE LOAD FAILED: ${e.message}\n`);
    process.exit(1);
  }

  // ── Test 1: idle state ──
  {
    console.log('── Initial State ──');
    const actor = createActor(recordingMachine).start();
    assertEqual(actor.getSnapshot().value, 'idle', 'starts in idle');
    assertEqual(actor.getSnapshot().context.recordingId, null, 'recordingId is null');
    actor.stop();
  }

  // ── Test 2: START → starting ──
  {
    console.log('\n── START Transition ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    assertEqual(actor.getSnapshot().value, 'starting', 'START → starting');
    assert(actor.getSnapshot().context.recordingId !== null, 'recordingId is set');
    assert(actor.getSnapshot().context.correlationId !== null, 'correlationId is set');
    assertEqual(actor.getSnapshot().context.options.mode, 'tab', 'mode is tab');
    assert(actor.getSnapshot().context.startedAt !== null, 'startedAt is set');
    actor.stop();
  }

  // ── Test 3: starting → recording via CONFIRMATION_TIMEOUT ──
  {
    console.log('\n── starting → recording (CONFIRMATION_TIMEOUT) ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    assertEqual(actor.getSnapshot().value, 'recording', '→ recording');
    actor.stop();
  }

  // ── Test 4: starting → recording via OFFSCREEN_STARTED ──
  {
    console.log('\n── starting → recording (OFFSCREEN_STARTED) ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_STARTED' });
    assertEqual(actor.getSnapshot().value, 'recording', '→ recording');
    actor.stop();
  }

  // ── Test 5: starting → recording via RECORDER_STARTED ──
  {
    console.log('\n── starting → recording (RECORDER_STARTED) ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'RECORDER_STARTED' });
    assertEqual(actor.getSnapshot().value, 'recording', '→ recording');
    actor.stop();
  }

  // ── Test 6: starting → failed via OFFSCREEN_ERROR ──
  {
    console.log('\n── starting → failed (OFFSCREEN_ERROR) ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'Permission denied' });
    assertEqual(actor.getSnapshot().value, 'failed', '→ failed');
    assertEqual(actor.getSnapshot().context.error, 'Permission denied', 'error message set');
    actor.stop();
  }

  // ── Test 7: recording → stopping via STOP ──
  {
    console.log('\n── recording → stopping ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    assertEqual(actor.getSnapshot().value, 'stopping', '→ stopping');
    actor.stop();
  }

  // ── Test 8: stopping → saved via OFFSCREEN_DATA ──
  {
    console.log('\n── stopping → saved ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    actor.send({
      type: 'OFFSCREEN_DATA',
      recordingId: '550e8400-e29b-41d4-a716-446655440000',
      mimeType: 'video/webm',
    });
    assertEqual(actor.getSnapshot().value, 'saved', '→ saved');
    actor.stop();
  }

  // ── Test 9: stopping → saved via RECORDER_DATA ──
  {
    console.log('\n── stopping → saved (RECORDER_DATA) ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    actor.send({
      type: 'RECORDER_DATA',
      recordingId: '550e8400-e29b-41d4-a716-446655440000',
      mimeType: 'video/webm',
    });
    assertEqual(actor.getSnapshot().value, 'saved', '→ saved');
    actor.stop();
  }

  // ── Test 10: recording → failed via OFFSCREEN_ERROR ──
  {
    console.log('\n── recording → failed ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'Tab crashed' });
    assertEqual(actor.getSnapshot().value, 'failed', '→ failed');
    assertEqual(actor.getSnapshot().context.error, 'Tab crashed', 'error set');
    actor.stop();
  }

  // ── Test 11: SAVE_TIMEOUT → recoverable; RECOVERY_DISCARD → idle ──
  {
    console.log('\n── recoverable flow (save-partial/discard) ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    actor.send({ type: 'SAVE_TIMEOUT' });
    assertEqual(actor.getSnapshot().value, 'recoverable', '→ recoverable');

    actor.send({ type: 'RECOVERY_DISCARD', recordingId: '550e8400-e29b-41d4-a716-446655440000' });
    assertEqual(actor.getSnapshot().value, 'idle', 'RECOVERY_DISCARD → idle');
    actor.stop();
  }

  // ── Test 12: RECOVERY_DISCARD from failed → idle ──
  {
    console.log('\n── RECOVERY_DISCARD ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'Failed' });
    actor.send({ type: 'RECOVERY_DISCARD', recordingId: '550e8400-e29b-41d4-a716-446655440000' });
    assertEqual(actor.getSnapshot().value, 'idle', '→ idle');
    actor.stop();
  }

  // ── Test 13: RESET from any state → idle ──
  {
    console.log('\n── RESET from various states ──');
    const actor = createActor(recordingMachine).start();

    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'RESET' });
    assertEqual(actor.getSnapshot().value, 'idle', 'RESET from recording → idle');

    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'OFFSCREEN_ERROR', error: 'err' });
    actor.send({ type: 'RESET' });
    assertEqual(actor.getSnapshot().value, 'idle', 'RESET from failed → idle');
    actor.stop();
  }

  // ── Test 14: STOP during starting → idle ──
  {
    console.log('\n── STOP cancellation ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'STOP' });
    assertEqual(actor.getSnapshot().value, 'idle', 'STOP during starting → idle');
    actor.stop();
  }

  // ── Test 15: STOP during stopping is idempotent ──
  {
    console.log('\n── STOP idempotent ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    actor.send({ type: 'STOP' });
    const first = actor.getSnapshot().value;
    actor.send({ type: 'STOP' });
    assertEqual(actor.getSnapshot().value, first, 'STOP during stopping is idempotent');
    actor.stop();
  }

  // ── Test 16: CHUNK_FAILED increments counter ──
  {
    console.log('\n── CHUNK_FAILED counter ──');
    const actor = createActor(recordingMachine).start();
    actor.send({ type: 'START', mode: 'tab' });
    actor.send({ type: 'CONFIRMATION_TIMEOUT' });
    assertEqual(actor.getSnapshot().context.failedChunkCount, 0, 'initial count is 0');
    actor.send({ type: 'CHUNK_FAILED' });
    assertEqual(actor.getSnapshot().context.failedChunkCount, 1, 'after 1 failure');
    actor.send({ type: 'CHUNK_FAILED' });
    assertEqual(actor.getSnapshot().context.failedChunkCount, 2, 'after 2 failures');
    actor.stop();
  }

  // ── Summary ──
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n✕ FATAL: ${e.message}\n`);
  process.exit(1);
});
