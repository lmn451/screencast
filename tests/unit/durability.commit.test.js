import { jest } from '@jest/globals';
import { DB_NAME } from '../../src/lib/db-shared.js';

/**
 * PR1 durability guarantee: saveChunk and finishRecording resolve only when the
 * IndexedDB transaction actually commits (tx.oncomplete). If the transaction
 * aborts at commit time (e.g. a commit-time QuotaExceededError), the returned
 * promise must REJECT rather than resolve — a request.onsuccess is not a durable
 * write on its own.
 */
describe('commit-time durability (transaction abort rejects)', () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (typeof indexedDB.deleteDatabase === 'function') {
      const delReq = indexedDB.deleteDatabase(DB_NAME);
      await new Promise((resolve) => {
        delReq.onsuccess = resolve;
        delReq.onerror = resolve;
        delReq.onblocked = resolve;
      });
    }
  });

  // Fake DB whose per-write request succeeds, but whose transaction aborts at
  // commit — exactly the case the tx.onabort/reject handler must surface.
  function installAbortingDB() {
    const origOpen = indexedDB.open;
    const abortError = new Error('commit aborted (quota)');
    const fakeDB = {
      transaction: () => {
        const store = {
          get: () => {
            const req = { result: undefined };
            setTimeout(() => req.onsuccess && req.onsuccess(), 0);
            return req;
          },
          put: () => {
            const req = {};
            // Individual write "succeeds"…
            setTimeout(() => req.onsuccess && req.onsuccess(), 0);
            return req;
          },
        };
        const tx = {
          objectStore: () => store,
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: abortError,
        };
        // …but the transaction aborts before committing.
        setTimeout(() => tx.onabort && tx.onabort(), 0);
        return tx;
      },
      close: jest.fn(),
    };

    global.indexedDB.open = () => {
      const req = { onsuccess: null, onerror: null, result: fakeDB };
      setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
      return req;
    };

    return { restore: () => (global.indexedDB.open = origOpen), abortError };
  }

  it('saveChunk rejects when the transaction aborts at commit', async () => {
    const { restore, abortError } = installAbortingDB();
    const { saveChunk } = await import('../../src/lib/chunkStorage.js');
    try {
      await expect(saveChunk('rec-abort', new Blob(['x']), 0)).rejects.toBe(abortError);
    } finally {
      restore();
    }
  });

  it('finishRecording rejects when the transaction aborts at commit', async () => {
    const { restore, abortError } = installAbortingDB();
    const { finishRecording } = await import('../../src/lib/recording.js');
    try {
      await expect(finishRecording('rec-abort', 'video/webm', 1000, 512)).rejects.toBe(abortError);
    } finally {
      restore();
    }
  });
});
