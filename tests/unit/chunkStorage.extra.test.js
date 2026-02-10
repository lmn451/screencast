import { jest } from '@jest/globals';
import { DB_NAME } from '../../db-shared.js';

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

    const { saveChunk } = await import('../../chunkStorage.js');
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

    const { saveChunk } = await import('../../chunkStorage.js');
    await expect(saveChunk('x', {}, 0)).rejects.toThrow('Failed to open database');

    // restore
    global.indexedDB.open = origOpen;
  });
});
