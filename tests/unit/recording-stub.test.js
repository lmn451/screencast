// Coverage for the start-time metadata stub used by crash recovery.
import { jest } from '@jest/globals';
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';
import {
  createRecordingStub,
  finishRecording,
  getAllRecordings,
  RECORDING_STATUS,
} from '../../src/lib/recording.js';
import { saveChunk } from '../../src/lib/chunkStorage.js';

beforeEach(async () => {
  setupIndexedDB();
  await clearDatabase();
});

afterEach(() => {
  jest.restoreAllMocks();
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

  it('preserves the stub creation time when finishing a recording', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    await createRecordingStub('stub-created-at', 'video/webm');

    now.mockReturnValue(31_000);
    await finishRecording('stub-created-at', 'video/webm', 30_000, 1024);

    const all = await getAllRecordings();
    const row = all.find((recording) => recording.id === 'stub-created-at');
    expect(row.createdAt).toBe(1_000);
  });
});
