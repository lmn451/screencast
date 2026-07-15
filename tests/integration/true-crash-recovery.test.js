// Integration test: service ↔ machine ↔ storage, true-crash simulation
// (plan AC3 / Critic MAJOR #1 "metadata gap").
//
// Scenario: a recording starts (metadata stub written, chunks persisted) but
// the service worker/browser dies before `finishRecording` ever runs (no
// clean `onStop`). This is the exact crash the WS-C stub fix targets: before
// the fix, a crash mid-recording left chunks with NO metadata row, so
// markRecordingRecoverable's `else { resolve() }` was a silent no-op,
// getRecoverableRecordings never listed it, and getRecording returned null —
// save-partial would produce nothing for the scenario it exists to handle.
//
// This test drives the REAL production code paths (no mocks):
//   - src/lib/recording.js: createRecordingStub, getRecording, getAllRecordings
//   - src/lib/chunkStorage.js: saveChunk, markRecordingRecoverable
//   - src/entries/recovery.js: real getRecoverableRecordings()/countChunks(),
//     exercised via its actual DOMContentLoaded render() (see
//     tests/unit/recovery.entries.test.js for the technique/rationale).
//
// It intentionally does NOT call finishRecording, matching a true mid-
// recording crash — if the stub fix regresses, this test fails against the
// real code (not against a mock).
import { jest } from '@jest/globals';
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';
import {
  createRecordingStub,
  getRecording,
  getAllRecordings,
  RECORDING_STATUS,
} from '../../src/lib/recording.js';
import { saveChunk, markRecordingRecoverable } from '../../src/lib/chunkStorage.js';

const RECORDING_ID = '550e8400-e29b-41d4-a716-446655440000';

// Mirrors src/entries/recordings.js:36 — that file is a DOM entry point with
// no exports, so the completed-recordings list filter can't be imported
// directly. Keep this literal in sync with recordings.js if that set changes.
const COMPLETED_LIST_EXCLUDED_STATUSES = new Set(['active', 'partial', 'failed']);

async function flushMacrotasks(times = 20) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(async () => {
  setupIndexedDB();
  await clearDatabase();
  jest.resetModules();
  document.body.innerHTML = '<div id="subtitle"></div><div id="list"></div>';
  global.chrome = {
    storage: { local: { get: jest.fn(async () => ({})) } },
    runtime: { sendMessage: jest.fn(async () => undefined) },
  };
});

afterEach(() => {
  teardownIndexedDB();
  delete global.chrome;
});

describe('true-crash simulation: chunks + start-time stub, never finishRecording', () => {
  it('is recoverable end-to-end: partial status, playable blob, listed for recovery, hidden from the completed list', async () => {
    // ── 1. Recording starts: the offscreen/recorder entry points write the
    //    metadata stub as soon as the codec/mimeType is known, then chunks
    //    stream in every CHUNK_INTERVAL_MS. ──
    await createRecordingStub(RECORDING_ID, 'video/webm;codecs=vp9,opus');
    await saveChunk(RECORDING_ID, new Blob(['first-chunk-']), 0);
    await saveChunk(RECORDING_ID, new Blob(['second-chunk']), 1);

    // ── 2. CRASH: no STOP, no finishRecording. Confirm the pre-crash state
    //    is exactly what a real mid-recording snapshot looks like. ──
    const preCrash = (await getAllRecordings()).find((r) => r.id === RECORDING_ID);
    expect(preCrash).toBeDefined();
    expect(preCrash.status).toBe(RECORDING_STATUS.ACTIVE);
    expect(COMPLETED_LIST_EXCLUDED_STATUSES.has(preCrash.status)).toBe(true);

    // ── 3. Reconcile on next startup: mirrors background.ts's
    //    reconcileUnfinishedSessions snapshot-independent orphan sweep —
    //    "any recording left in `active` is flipped to `partial` via
    //    markRecordingRecoverable, snapshot or no snapshot". ──
    for (const rec of await getAllRecordings()) {
      if (rec.status === RECORDING_STATUS.ACTIVE) {
        await markRecordingRecoverable(rec.id);
      }
    }

    // ── 4. Assert the fix: flipped to partial, playable, listed, still
    //    hidden from the completed list. ──
    const postSweep = (await getAllRecordings()).find((r) => r.id === RECORDING_ID);
    expect(postSweep.status).toBe('partial');
    expect(COMPLETED_LIST_EXCLUDED_STATUSES.has(postSweep.status)).toBe(true);

    const recovered = await getRecording(RECORDING_ID);
    expect(recovered).not.toBeNull();
    expect(recovered.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(recovered.blob).toBeInstanceOf(Blob);
    expect(recovered.blob.size).toBeGreaterThan(0); // playable, not an empty/corrupt blob
    expect(recovered.status).toBe('partial');

    // Drive the real recovery.html render() (getRecoverableRecordings +
    // countChunks), not a re-implementation of its filter logic.
    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    const listHtml = document.getElementById('list').innerHTML;
    expect(listHtml).toContain(RECORDING_ID);
    expect(listHtml).toContain('2 chunks');
    expect(listHtml).toContain('Save partial');
    expect(document.getElementById('subtitle').textContent).toMatch(/1 recording/);
  });
});
