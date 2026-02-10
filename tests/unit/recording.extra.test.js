import { jest } from '@jest/globals';
import { DB_NAME } from '../../db-shared.js';

describe('recording.js additional tests', () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    // ensure clean DB between tests when supported
    if (typeof indexedDB.deleteDatabase === 'function') {
      const delReq = indexedDB.deleteDatabase(DB_NAME);
      await new Promise((resolve) => {
        delReq.onsuccess = resolve;
        delReq.onerror = resolve;
        delReq.onblocked = resolve;
      });
    }
    // provide a minimal fake indexedDB.open to keep tests deterministic
    const origOpen = indexedDB.open;
    const recordings = {};
    const chunks = [];
    global.__origIndexedDBOpen = origOpen;
    global.indexedDB.open = () => {
      const db = {
        transaction: (storeName) => {
          const store = {};
          if (storeName === 'recordings') {
            store.get = (id) => {
              const req = {};
              setTimeout(() => {
                req.result = recordings[id];
                req.onsuccess && req.onsuccess();
              }, 0);
              return req;
            };
            store.put = (val) => {
              const req = {};
              setTimeout(() => {
                recordings[val.id] = val;
                req.onsuccess && req.onsuccess();
              }, 0);
              return req;
            };
            store.getAll = () => {
              const req = {};
              setTimeout(() => {
                req.result = Object.values(recordings);
                req.onsuccess && req.onsuccess();
              }, 0);
              return req;
            };
          }
          if (storeName === 'chunks') {
            store.index = () => ({
              getAll: () => {
                const req = {};
                setTimeout(() => {
                  req.result = chunks.slice();
                  req.onsuccess && req.onsuccess();
                }, 0);
                return req;
              },
            });
            store.put = (obj) => {
              const req = {};
              setTimeout(() => {
                chunks.push(obj);
                req.onsuccess && req.onsuccess();
              }, 0);
              return req;
            };
          }

          const tx = { objectStore: () => store, oncomplete: null, onerror: null };
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
          return tx;
        },
        close: () => {},
      };

      const req = { onsuccess: null, onerror: null, result: db };
      setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
      return req;
    };
    // polyfill IDBKeyRange.only for this test harness
    global.IDBKeyRange = { only: (v) => ({ _value: v }) };
  });

  afterEach(() => {
    // restore original indexedDB.open if we replaced it
    if (global.__origIndexedDBOpen) {
      global.indexedDB.open = global.__origIndexedDBOpen;
      delete global.__origIndexedDBOpen;
    }
    if (global.IDBKeyRange) delete global.IDBKeyRange;
  });

  it('finishRecording then getRecording returns metadata and blob', async () => {
    const { finishRecording, getRecording } = await import('../../recording.js');

    await finishRecording('rec-1', 'video/webm', 1500, 2048);

    const rec = await getRecording('rec-1');
    expect(rec).not.toBeNull();
    expect(rec.id).toBe('rec-1');
    expect(rec.mimeType).toBe('video/webm');
    expect(rec.duration).toBe(1500);
    expect(rec.size).toBe(2048);
    expect(rec.blob).toBeInstanceOf(Blob);
  });

  it('getRecording returns null when metadata missing', async () => {
    const { getRecording } = await import('../../recording.js');
    const res = await getRecording('no-such');
    expect(res).toBeNull();
  });

  it('updateRecordingName rejects when recording not found', async () => {
    const { updateRecordingName } = await import('../../recording.js');
    await expect(updateRecordingName('missing', 'new name')).rejects.toThrow('Recording not found');
  });
});
