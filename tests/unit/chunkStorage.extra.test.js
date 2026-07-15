import { jest } from '@jest/globals';
import { DB_NAME } from '../../src/lib/db-shared.js';

describe('chunkStorage.js additional tests', () => {
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

  it('saveChunk stores chunk successfully', async () => {
    // Mock a minimal indexedDB that accepts the put and completes the tx
    const origOpen = indexedDB.open;
    const fakeDB = {
      transaction: () => {
        const store = {
          put: () => {
            const req = {};
            setTimeout(() => req.onsuccess && req.onsuccess(), 0);
            return req;
          },
        };
        const tx = {
          objectStore: () => store,
          oncomplete: null,
          onerror: null,
        };
        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
        return tx;
      },
      close: jest.fn(),
    };

    global.indexedDB.open = () => {
      const req = { onsuccess: null, onerror: null, result: fakeDB };
      setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
      return req;
    };

    const { saveChunk } = await import('../../src/lib/chunkStorage.js');
    const blob = new Blob(['hello']);
    await expect(saveChunk('r-chunk', blob, 0)).resolves.toBeUndefined();

    global.indexedDB.open = origOpen;
  });

  it('saveChunk throws when indexedDB.open fails', async () => {
    const origOpen = indexedDB.open;

    // mock open to call onerror
    global.indexedDB.open = () => {
      const req = { error: new Error('open failed'), onsuccess: null, onerror: null };
      setTimeout(() => req.onerror && req.onerror(), 0);
      return req;
    };

    const { saveChunk } = await import('../../src/lib/chunkStorage.js');
    await expect(saveChunk('x', {}, 0)).rejects.toThrow('Failed to open database');

    // restore
    global.indexedDB.open = origOpen;
  });

  // ── AC1 (finding #1): a commit-time failure must reject saveChunk, not
  // silently resolve. Before the fix, saveChunk resolved on request.onsuccess
  // (the write being merely *queued*), so a QuotaExceededError raised when the
  // transaction actually commits (tx.onabort/tx.onerror) was never observed by
  // the caller — chunks could be silently lost. saveChunk must resolve on
  // tx.oncomplete and reject on tx.onabort/tx.onerror.
  it('saveChunk REJECTS when the transaction aborts at commit time (e.g. QuotaExceededError)', async () => {
    const origOpen = indexedDB.open;
    const commitError = new Error('QuotaExceededError');
    commitError.name = 'QuotaExceededError';

    const fakeDB = {
      transaction: () => {
        const store = {
          put: () => {
            const req = {};
            // The put request itself succeeds (data is queued)...
            setTimeout(() => req.onsuccess && req.onsuccess(), 0);
            return req;
          },
        };
        const tx = {
          objectStore: () => store,
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: commitError,
        };
        // ...but the transaction as a whole aborts at commit time (quota
        // exceeded, disk full, etc). request.onsuccess firing first and
        // tx.onabort firing after is exactly the sequence that a
        // resolve-on-request.onsuccess implementation would miss.
        setTimeout(() => {
          tx.error = commitError;
          tx.onabort && tx.onabort();
        }, 0);
        return tx;
      },
      close: jest.fn(),
    };

    global.indexedDB.open = () => {
      const req = { onsuccess: null, onerror: null, result: fakeDB };
      setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
      return req;
    };

    const { saveChunk } = await import('../../src/lib/chunkStorage.js');
    const blob = new Blob(['hello']);
    await expect(saveChunk('r-abort', blob, 0)).rejects.toBe(commitError);
    expect(fakeDB.close).toHaveBeenCalled();

    global.indexedDB.open = origOpen;
  });

  it('saveChunk REJECTS when the transaction fires onerror at commit time', async () => {
    const origOpen = indexedDB.open;
    const commitError = new Error('commit failed');

    const fakeDB = {
      transaction: () => {
        const store = {
          put: () => {
            const req = {};
            setTimeout(() => req.onsuccess && req.onsuccess(), 0);
            return req;
          },
        };
        const tx = {
          objectStore: () => store,
          oncomplete: null,
          onerror: null,
          error: commitError,
        };
        setTimeout(() => tx.onerror && tx.onerror(), 0);
        return tx;
      },
      close: jest.fn(),
    };

    global.indexedDB.open = () => {
      const req = { onsuccess: null, onerror: null, result: fakeDB };
      setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
      return req;
    };

    const { saveChunk } = await import('../../src/lib/chunkStorage.js');
    await expect(saveChunk('r-err', new Blob(['x']), 0)).rejects.toBe(commitError);

    global.indexedDB.open = origOpen;
  });
});
