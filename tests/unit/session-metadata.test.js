import indexedDB from 'fake-indexeddb';
import {
  SESSION_METADATA_DB_NAME,
  claimSessionOwner,
  readSessionOwner,
  retireSessionOwner,
  updateSessionOwner,
} from '../../src/lib/session-metadata.ts';

const FIRST_ID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_ID = '550e8400-e29b-41d4-a716-446655440001';
const resources = { strategy: 'offscreen', recorderTabId: null, overlayTabId: 42 };
const owner = (recordingId) => ({ recordingId, ...resources });

beforeEach(async () => {
  global.indexedDB = indexedDB;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SESSION_METADATA_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Session metadata connection was not closed'));
  });
});

it('allows only one recording to win concurrent claims from separate workers', async () => {
  const claims = await Promise.all([
    claimSessionOwner(owner(FIRST_ID)),
    claimSessionOwner(owner(SECOND_ID)),
  ]);
  const winners = claims.filter(Boolean);
  expect(winners).toHaveLength(1);
  expect(await readSessionOwner()).toEqual(winners[0]);
});

it('prevents a retired recording and its delayed writes from replacing a newer owner', async () => {
  const first = await claimSessionOwner(owner(FIRST_ID));
  expect(await retireSessionOwner(FIRST_ID, resources)).toBe(true);
  expect(await claimSessionOwner(owner(FIRST_ID))).toBeNull();

  const second = await claimSessionOwner(owner(SECOND_ID));
  expect(second.generation).toBeGreaterThan(first.generation);
  expect(await updateSessionOwner(FIRST_ID, { ...resources, overlayTabId: 99 })).toBe(false);
  expect(await retireSessionOwner(FIRST_ID, resources)).toBe(false);
  expect(await claimSessionOwner(owner(FIRST_ID))).toBeNull();
  expect(await readSessionOwner()).toEqual(second);
});

it('keeps one durable owner record across repeated completed recordings', async () => {
  for (let index = 0; index < 20; index += 1) {
    const recordingId = `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`;
    const claimed = await claimSessionOwner(owner(recordingId));
    expect(claimed.generation).toBe(index + 1);
    expect(await retireSessionOwner(recordingId, resources)).toBe(true);
  }

  const rowCount = await new Promise((resolve, reject) => {
    const open = indexedDB.open(SESSION_METADATA_DB_NAME);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('session', 'readonly');
      const count = transaction.objectStore('session').count();
      transaction.oncomplete = () => {
        db.close();
        resolve(count.result);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    };
  });
  expect(rowCount).toBe(1);
});
