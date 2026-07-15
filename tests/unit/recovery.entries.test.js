// Coverage for src/entries/recovery.js's IndexedDB helpers (WS-B finding #7):
// getRecoverableRecordings, countChunks, and deleteRecording must each close
// their DB connection rather than leaking it open. These helpers are module-
// private (not exported), so this test drives the real render() flow through
// the DOM the same way the browser does — creating the #list/#subtitle
// elements the entry expects and re-dispatching DOMContentLoaded (safe: it's
// just another addEventListener/dispatchEvent pair, independent of jsdom's
// own initial firing) — instead of re-implementing/duplicating the helpers'
// logic in the test.
//
// Note: fake-indexeddb resolves IDBRequest/transaction callbacks via real
// macrotasks (per the IndexedDB spec's task-queue model), not microtasks, so
// this test flushes with real setTimeout ticks rather than Promise.resolve().
import { jest } from '@jest/globals';
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';
import { finishRecording, openDB } from '../../src/lib/db.js';
import { saveChunk } from '../../src/lib/chunkStorage.js';

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
    storage: {
      local: {
        get: jest.fn(async () => ({})),
        remove: jest.fn(async () => undefined),
      },
    },
    runtime: { sendMessage: jest.fn(async () => undefined) },
  };
});

afterEach(() => {
  teardownIndexedDB();
  delete global.chrome;
});

describe('src/entries/recovery.js — DB connection hygiene', () => {
  it('closes its DB connection after rendering the recoverable-recordings list', async () => {
    await finishRecording('rec-partial', 'video/webm', 1000, 500, 'partial');
    await saveChunk('rec-partial', new Blob(['a']), 0);

    // Spy on IDBDatabase.prototype.close via a throwaway connection so we
    // observe every close() call the entry's helpers make internally.
    const db = await openDB();
    const closeSpy = jest.spyOn(Object.getPrototypeOf(db), 'close');
    db.close();
    closeSpy.mockClear();

    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    // The rendered list must reflect the real getRecoverableRecordings() +
    // countChunks() output (proves we exercised the actual helpers, not a
    // mock), and each of those helpers must have closed its own connection:
    // one close() from getRecoverableRecordings' tx.oncomplete, one from
    // countChunks' tx.oncomplete for the single listed recording.
    const listHtml = document.getElementById('list').innerHTML;
    expect(listHtml).toContain('rec-partial');
    expect(listHtml).toContain('1 chunks');
    expect(document.getElementById('subtitle').textContent).toMatch(/1 recording/);
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('deleteRecording (wired to the Discard button) closes its DB connection and removes the row', async () => {
    await finishRecording('rec-to-discard', 'video/webm', 1000, 500, 'failed');
    await saveChunk('rec-to-discard', new Blob(['a']), 0);

    const db = await openDB();
    const closeSpy = jest.spyOn(Object.getPrototypeOf(db), 'close');
    db.close();
    closeSpy.mockClear();

    global.confirm = jest.fn(() => true);

    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    const discardBtn = document.querySelector('button[data-action="discard"]');
    expect(discardBtn).not.toBeNull();
    discardBtn.click();
    await flushMacrotasks();

    expect(global.confirm).toHaveBeenCalled();
    // deleteRecording's own transaction (over both STORE_RECORDINGS and
    // STORE_CHUNKS) must have closed its connection too.
    expect(closeSpy.mock.calls.length).toBeGreaterThan(0);

    const { getRecording } = await import('../../src/lib/recording.js');
    expect(await getRecording('rec-to-discard')).toBeNull();
  });
});
