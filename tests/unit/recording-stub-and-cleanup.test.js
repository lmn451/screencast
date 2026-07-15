// Coverage for the start-time metadata stub (WS-C metadata-gap fix) and its
// companion orphan-cleanup pass:
//  - createRecordingStub(id, mimeType) writes {id, mimeType, createdAt,
//    status: 'active'} so a mid-recording crash still leaves a recoverable
//    metadata row (see src/lib/recording.js, WS-C ADR).
//  - cleanupActiveRecordings reclaims only STALE `active` stub rows (older
//    than the threshold), leaving fresh `active` rows and non-active rows
//    alone (src/lib/cleanup.js).
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';
import {
  createRecordingStub,
  finishRecording,
  getRecording,
  getAllRecordings,
  RECORDING_STATUS,
} from '../../src/lib/recording.js';
import { cleanupActiveRecordings } from '../../src/lib/cleanup.js';
import { saveChunk } from '../../src/lib/chunkStorage.js';

beforeEach(async () => {
  setupIndexedDB();
  await clearDatabase();
});

afterEach(() => {
  teardownIndexedDB();
});

describe('createRecordingStub', () => {
  it('writes a minimal {id, mimeType, createdAt, status: active} row', async () => {
    const before = Date.now();
    await createRecordingStub('stub-1', 'video/webm;codecs=vp9,opus');

    const all = await getAllRecordings();
    const row = all.find((r) => r.id === 'stub-1');
    expect(row).toBeDefined();
    expect(row.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(row.status).toBe('active');
    expect(row.status).toBe(RECORDING_STATUS.ACTIVE);
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('is overwritten by finishRecording on a clean stop (put upsert, not a duplicate row)', async () => {
    await createRecordingStub('stub-2', 'video/webm');
    await saveChunk('stub-2', new Blob(['chunk']), 0);

    await finishRecording('stub-2', 'video/webm', 5000, 1024, RECORDING_STATUS.SAVED);

    const all = await getAllRecordings();
    const rows = all.filter((r) => r.id === 'stub-2');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('saved');
    expect(rows[0].duration).toBe(5000);
  });
});

describe('cleanupActiveRecordings', () => {
  it('reclaims a stale active row and its chunks (orphan from an abnormal end)', async () => {
    await createRecordingStub('stale-active', 'video/webm');
    await saveChunk('stale-active', new Blob(['a']), 0);
    await saveChunk('stale-active', new Blob(['b']), 1);

    // Let createdAt fall strictly before the cutoff, then use a 0ms threshold
    // so "cutoff = now" reclaims anything already persisted.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await cleanupActiveRecordings(0);

    expect(result.deleted).toBe(1);
    expect(await getRecording('stale-active')).toBeNull();
  });

  it('leaves a freshly-created active row alone under the default 1h threshold', async () => {
    await createRecordingStub('just-started', 'video/webm');

    const result = await cleanupActiveRecordings(); // default threshold: 1 hour

    expect(result.deleted).toBe(0);
    const all = await getAllRecordings();
    expect(all.find((r) => r.id === 'just-started')).toBeDefined();
  });

  it('never touches non-active recordings, even ones older than the cutoff', async () => {
    await finishRecording('already-saved', 'video/webm', 100, 200, RECORDING_STATUS.SAVED);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await cleanupActiveRecordings(0); // cutoff = now; only status==='active' is eligible

    expect(result.deleted).toBe(0);
    expect(await getRecording('already-saved')).not.toBeNull();
  });
});
