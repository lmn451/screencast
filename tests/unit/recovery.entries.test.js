// Coverage for src/entries/recovery.js's IndexedDB reads and guarded discard
// flow. The module-private helpers are exercised through the real DOM entry:
// rendering verifies getRecoverableRecordings()/countChunks(), and Discard
// verifies user-facing ownership checks plus persisted metadata/chunk effects.
//
// fake-indexeddb resolves IDBRequest/transaction callbacks via real macrotasks
// (per the IndexedDB spec's task-queue model), so tests flush with setTimeout
// ticks rather than Promise.resolve().
//
import { jest } from '@jest/globals';
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';
import { finishRecording, openDB } from '../../src/lib/db.js';
import { saveChunk } from '../../src/lib/chunkStorage.js';
import {
  SESSION_METADATA_DB_NAME,
  claimSessionOwner,
  readSessionOwner,
  retireSessionOwner,
} from '../../src/lib/session-metadata.ts';

async function flushMacrotasks(times = 20) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
// Track the entry's page-load listeners so module resets do not leave stale handlers between tests.
let recoveryDomContentLoadedListeners = [];

beforeEach(async () => {
  setupIndexedDB();
  await clearDatabase();
  await clearDatabase(SESSION_METADATA_DB_NAME);
  jest.resetModules();
  document.body.innerHTML = '<div id="subtitle"></div><div id="list"></div>';
  recoveryDomContentLoadedListeners = [];
  const addDocumentListener = document.addEventListener.bind(document);
  jest.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'DOMContentLoaded') recoveryDomContentLoadedListeners.push(listener);
    return addDocumentListener(type, listener, options);
  });
  global.chrome = {
    storage: {
      local: {
        get: jest.fn(async () => ({})),
        remove: jest.fn(async () => undefined),
      },
    },
    runtime: {
      sendMessage: jest.fn(async () => ({
        ok: true,
        status: 'idle',
        recordingId: null,
        recording: false,
      })),
    },
  };
  global.alert = jest.fn();
});

afterEach(() => {
  recoveryDomContentLoadedListeners.forEach((listener) =>
    document.removeEventListener('DOMContentLoaded', listener)
  );
  jest.restoreAllMocks();
  teardownIndexedDB();
  delete global.chrome;
  delete global.confirm;
  delete global.alert;
});

describe('src/entries/recovery.js — IndexedDB and discard behavior', () => {
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

  it('removes the row and its chunks through the guarded Discard button', async () => {
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
    expect(closeSpy.mock.calls.length).toBeGreaterThan(0);

    const { getRecording } = await import('../../src/lib/recording.js');
    expect(await getRecording('rec-to-discard')).toBeNull();
  });

  it('refuses active-session discard without removing its row or chunks', async () => {
    const activeId = 'active-recording';
    const activeState = {
      ok: true,
      status: 'recording',
      recordingId: activeId,
      recording: true,
    };
    chrome.runtime.sendMessage.mockResolvedValue(activeState);
    await finishRecording(activeId, 'video/webm', 1000, 500, 'active');
    await saveChunk(activeId, new Blob(['active chunk']), 0);
    global.confirm = jest.fn(() => true);
    global.alert = jest.fn();

    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    const discardBtn = document.querySelector(
      `button[data-action="discard"][data-id="${activeId}"]`
    );
    expect(discardBtn).not.toBeNull();
    discardBtn.click();
    await flushMacrotasks();

    const { getRecording } = await import('../../src/lib/recording.js');
    const { getChunkCount } = await import('../../src/lib/chunkStorage.js');
    expect((await getRecording(activeId)).blob.size).toBe('active chunk'.length);
    expect(await getChunkCount(activeId)).toBe(1);
    expect(
      document.querySelector(`button[data-id="${activeId}"][data-action="discard"]`)
    ).not.toBeNull();
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Stop the recording before deleting it.')
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_STATE' });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RECOVERY_DISCARD' })
    );
  });

  it('retires the same-ID recoverable service state before deleting its persisted data', async () => {
    const recordingId = '550e8400-e29b-41d4-a716-446655440002';
    const idleState = {
      ok: true,
      status: 'idle',
      recordingId: null,
      recording: false,
    };
    let currentState = {
      ok: true,
      status: 'recoverable',
      recordingId,
      recording: false,
    };
    const resources = { strategy: 'page', recorderTabId: null, overlayTabId: null };
    expect(await claimSessionOwner({ recordingId, ...resources })).not.toBeNull();
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === 'GET_STATE') return currentState;
      if (message.type === 'RECOVERY_DISCARD') {
        if (
          currentState.recordingId !== message.recordingId ||
          currentState.status !== 'recoverable'
        ) {
          return { ok: false };
        }
        if (!(await retireSessionOwner(message.recordingId, resources))) {
          return { ok: false };
        }
        currentState = idleState;
        return { ok: true };
      }
      return { ok: false };
    });
    await finishRecording(recordingId, 'video/webm', 1000, 500, 'recoverable');
    await saveChunk(recordingId, new Blob(['recoverable chunk']), 0);
    global.confirm = jest.fn(() => true);

    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    document.querySelector(`button[data-action="discard"][data-id="${recordingId}"]`).click();
    await flushMacrotasks();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'RECOVERY_DISCARD',
      recordingId,
    });
    expect(currentState).toBe(idleState);
    expect((await readSessionOwner()).status).toBe('retired');
    const { getRecording } = await import('../../src/lib/recording.js');
    const { getChunkCount } = await import('../../src/lib/chunkStorage.js');
    expect(await getRecording(recordingId)).toBeNull();
    expect(await getChunkCount(recordingId)).toBe(0);
    expect(global.alert).not.toHaveBeenCalled();
  });

  it('preserves recovery data when terminal session disposal is rejected', async () => {
    const recordingId = 'rec-discard-rejected';
    const recoverableState = {
      ok: true,
      status: 'recoverable',
      recordingId,
      recording: false,
    };
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === 'GET_STATE') return recoverableState;
      if (message.type === 'RECOVERY_DISCARD') return { ok: false, error: 'stale session' };
      return { ok: false };
    });
    await finishRecording(recordingId, 'video/webm', 1000, 500, 'recoverable');
    await saveChunk(recordingId, new Blob(['recoverable chunk']), 0);
    global.confirm = jest.fn(() => true);
    global.alert = jest.fn();

    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    const discardButton = document.querySelector(
      `button[data-action="discard"][data-id="${recordingId}"]`
    );
    expect(discardButton).not.toBeNull();
    discardButton.click();
    await flushMacrotasks();

    const { getRecording } = await import('../../src/lib/recording.js');
    const { getChunkCount } = await import('../../src/lib/chunkStorage.js');
    expect((await getRecording(recordingId)).blob.size).toBe('recoverable chunk'.length);
    expect(await getChunkCount(recordingId)).toBe(1);
    expect(
      document.querySelector(`button[data-action="discard"][data-id="${recordingId}"]`)
    ).not.toBeNull();
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Could not clear the recovery session before deleting.')
    );
  });

  it('keeps recovery data when the canonical ownership query fails after confirmation', async () => {
    const recordingId = 'rec-query-failure';
    await finishRecording(recordingId, 'video/webm', 1000, 500, 'partial');
    await saveChunk(recordingId, new Blob(['partial chunk']), 0);
    let confirmedDiscard = false;
    chrome.runtime.sendMessage.mockImplementation(async () => {
      if (confirmedDiscard) throw new Error('service unavailable');
      return {
        ok: true,
        status: 'idle',
        recordingId: null,
        recording: false,
      };
    });
    global.confirm = jest.fn(() => {
      confirmedDiscard = true;
      return true;
    });
    global.alert = jest.fn();

    await import('../../src/entries/recovery.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMacrotasks();

    const discardBtn = document.querySelector(
      `button[data-action="discard"][data-id="${recordingId}"]`
    );
    expect(discardBtn).not.toBeNull();
    discardBtn.click();
    await flushMacrotasks();

    const { getRecording } = await import('../../src/lib/recording.js');
    const { getChunkCount } = await import('../../src/lib/chunkStorage.js');
    expect((await getRecording(recordingId)).blob.size).toBe('partial chunk'.length);
    expect(await getChunkCount(recordingId)).toBe(1);
    expect(
      document.querySelector(`button[data-id="${recordingId}"][data-action="discard"]`)
    ).not.toBeNull();
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Could not confirm whether recording is active.')
    );
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });
});
