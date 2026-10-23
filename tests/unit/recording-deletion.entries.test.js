import { jest } from '@jest/globals';
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';
import {
  SESSION_METADATA_DB_NAME,
  claimSessionOwner,
  readSessionOwner,
  retireSessionOwner,
} from '../../src/lib/session-metadata.ts';

const PREVIEW_ID = '550e8400-e29b-41d4-a716-446655440000';
const INACTIVE_STATE = {
  ok: true,
  status: 'idle',
  recordingId: null,
  recording: false,
};
const ACTIVE_STATE = (recordingId) => ({
  ok: true,
  status: 'recording',
  recordingId,
  recording: true,
});

let createObjectURLDescriptor;
let revokeObjectURLDescriptor;

async function flushMacrotasks(times = 24) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function saveRecording(id, status = 'saved', name = null) {
  const { finishRecording, updateRecordingName } = await import('../../src/lib/recording.js');
  const { saveChunk } = await import('../../src/lib/chunkStorage.js');
  const chunk = new Blob([`chunk for ${id}`]);
  await finishRecording(id, 'video/webm', 1000, chunk.size, status);
  await saveChunk(id, chunk, 0);
  if (name !== null) await updateRecordingName(id, name);
}

async function persistedRecording(id) {
  const { getRecording } = await import('../../src/lib/recording.js');
  return getRecording(id);
}

async function persistedChunkCount(id) {
  const { getChunkCount } = await import('../../src/lib/chunkStorage.js');
  return getChunkCount(id);
}

async function openPreview(id) {
  document.body.innerHTML = `
    <video id="video"></video>
    <input id="filename-input" />
    <button id="btn-download">Download</button>
    <div class="actions"></div>
  `;
  window.history.replaceState({}, '', `/preview.html?id=${encodeURIComponent(id)}`);
  delete window.__TEST_BLOB__;
  await import('../../src/entries/preview.js');
  await flushMacrotasks();
}

async function openRecordings() {
  document.body.innerHTML = '<div id="app-version"></div><div id="list"></div>';
  await import('../../src/entries/recordings.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await flushMacrotasks();
}

beforeEach(async () => {
  setupIndexedDB();
  await clearDatabase();
  await clearDatabase(SESSION_METADATA_DB_NAME);
  jest.resetModules();
  document.body.innerHTML = '';
  global.chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      sendMessage: jest.fn(async () => INACTIVE_STATE),
    },
    storage: { local: { get: jest.fn(async () => ({})) } },
    tabs: { create: jest.fn() },
  };
  global.confirm = jest.fn(() => true);
  global.alert = jest.fn();
  createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: jest.fn(() => 'blob:preview-test'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: jest.fn(),
  });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  teardownIndexedDB();
  delete global.chrome;
  delete global.confirm;
  delete global.alert;
  if (createObjectURLDescriptor) {
    Object.defineProperty(URL, 'createObjectURL', createObjectURLDescriptor);
  } else {
    delete URL.createObjectURL;
  }
  if (revokeObjectURLDescriptor) {
    Object.defineProperty(URL, 'revokeObjectURL', revokeObjectURLDescriptor);
  } else {
    delete URL.revokeObjectURL;
  }
});

describe('user-facing recording deletion', () => {
  it('rechecks same-ID ownership after confirmation and allows a stopped retry on the same page', async () => {
    await saveRecording('saved-current-session');
    let canonicalState = INACTIVE_STATE;
    chrome.runtime.sendMessage.mockImplementation(async () => canonicalState);
    await openRecordings();

    const item = document.querySelector('.item');
    const deleteButton = item.querySelector('.btn-delete');
    global.confirm.mockImplementationOnce(() => {
      canonicalState = ACTIVE_STATE('saved-current-session');
      return true;
    });
    deleteButton.click();
    await flushMacrotasks();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_STATE' });
    expect(await persistedRecording('saved-current-session')).not.toBeNull();
    expect(await persistedChunkCount('saved-current-session')).toBe(1);
    expect(document.querySelector('.item')).toBe(item);
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Stop the recording before deleting it.')
    );

    canonicalState = INACTIVE_STATE;
    deleteButton.click();
    await flushMacrotasks();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(await persistedRecording('saved-current-session')).toBeNull();
    expect(await persistedChunkCount('saved-current-session')).toBe(0);
    expect(document.querySelector('.empty').textContent).toBe('No recordings found.');
  });

  it('allows deleting this recording while a different ID is actively recording', async () => {
    await saveRecording('saved-other-session');
    chrome.runtime.sendMessage.mockResolvedValue(ACTIVE_STATE('another-recording'));
    await openRecordings();

    document.querySelector('.btn-delete').click();
    await flushMacrotasks();

    expect(await persistedRecording('saved-other-session')).toBeNull();
    expect(await persistedChunkCount('saved-other-session')).toBe(0);
    expect(global.alert).not.toHaveBeenCalled();
  });

  it('keeps data and the library item when the ownership response is malformed', async () => {
    await saveRecording('saved-malformed-state');
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: true,
      status: 'recording',
      recordingId: 'saved-malformed-state',
    });
    await openRecordings();
    const item = document.querySelector('.item');

    item.querySelector('.btn-delete').click();
    await flushMacrotasks();

    expect(await persistedRecording('saved-malformed-state')).not.toBeNull();
    expect(await persistedChunkCount('saved-malformed-state')).toBe(1);
    expect(document.querySelector('.item')).toBe(item);
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Could not confirm whether recording is active.')
    );
  });

  it('allows deleting an orphaned persisted active row when canonical state is idle', async () => {
    await saveRecording(PREVIEW_ID, 'active');
    await openPreview(PREVIEW_ID);

    document.querySelector('.actions button').click();
    await flushMacrotasks();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_STATE' });
    expect(await persistedRecording(PREVIEW_ID)).toBeNull();
    expect(await persistedChunkCount(PREVIEW_ID)).toBe(0);
    expect(document.body.textContent).toContain('Recording Deleted');
  });

  it('allows deletion after the durable owner has been retired', async () => {
    const resources = { strategy: 'page', recorderTabId: null, overlayTabId: null };
    await claimSessionOwner({ recordingId: PREVIEW_ID, ...resources });
    expect(await retireSessionOwner(PREVIEW_ID, resources)).toBe(true);
    await saveRecording(PREVIEW_ID, 'active');
    await openPreview(PREVIEW_ID);

    document.querySelector('.actions button').click();
    await flushMacrotasks();

    expect(await persistedRecording(PREVIEW_ID)).toBeNull();
    expect(await persistedChunkCount(PREVIEW_ID)).toBe(0);
    expect(document.body.textContent).toContain('Recording Deleted');
  });

  it('refuses deletion while the durable owner still claims this ID despite canonical idle state', async () => {
    await claimSessionOwner({
      recordingId: PREVIEW_ID,
      strategy: 'page',
      recorderTabId: null,
      overlayTabId: null,
    });
    expect(await readSessionOwner()).toMatchObject({
      recordingId: PREVIEW_ID,
      status: 'active',
    });
    await saveRecording(PREVIEW_ID, 'active');
    await openPreview(PREVIEW_ID);

    document.querySelector('.actions button').click();
    await flushMacrotasks();

    expect(await persistedRecording(PREVIEW_ID)).not.toBeNull();
    expect(await persistedChunkCount(PREVIEW_ID)).toBe(1);
    expect(document.querySelector('.actions button')).not.toBeNull();
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Stop the recording before deleting it.')
    );
  });

  it('fails closed when durable owner metadata cannot be read', async () => {
    await saveRecording(PREVIEW_ID, 'active');
    await openPreview(PREVIEW_ID);
    const ownerRead = jest.spyOn(global.indexedDB, 'open').mockImplementation(() => {
      throw new Error('metadata database unavailable');
    });

    document.querySelector('.actions button').click();
    await flushMacrotasks();
    ownerRead.mockRestore();

    expect(await persistedRecording(PREVIEW_ID)).not.toBeNull();
    expect(await persistedChunkCount(PREVIEW_ID)).toBe(1);
    expect(document.querySelector('.actions button')).not.toBeNull();
    expect(global.alert).toHaveBeenCalledWith(
      expect.stringContaining('Could not verify the recording owner.')
    );
  });
});

describe('preview recording name persistence', () => {
  it('persists repeated renames and clears the cached name after each successful write', async () => {
    await saveRecording(PREVIEW_ID, 'saved', 'Original');
    await openPreview(PREVIEW_ID);
    const input = document.getElementById('filename-input');
    const downloadButton = document.getElementById('btn-download');

    input.value = 'New';
    downloadButton.click();
    await flushMacrotasks();
    expect((await persistedRecording(PREVIEW_ID)).name).toBe('New');

    input.value = 'Original';
    downloadButton.click();
    await flushMacrotasks();
    expect((await persistedRecording(PREVIEW_ID)).name).toBe('Original');

    input.value = '';
    downloadButton.click();
    await flushMacrotasks();
    expect((await persistedRecording(PREVIEW_ID)).name).toBeNull();

    input.value = 'Custom';
    downloadButton.click();
    await flushMacrotasks();
    expect((await persistedRecording(PREVIEW_ID)).name).toBe('Custom');

    input.value = '';
    downloadButton.click();
    await flushMacrotasks();
    expect((await persistedRecording(PREVIEW_ID)).name).toBeNull();
  });

  it('does not cache a name when a database update fails', async () => {
    await saveRecording(PREVIEW_ID, 'saved', 'Original');
    await openPreview(PREVIEW_ID);
    const input = document.getElementById('filename-input');
    const downloadButton = document.getElementById('btn-download');
    const { deleteRecording } = await import('../../src/lib/cleanup.js');
    await deleteRecording(PREVIEW_ID);

    input.value = 'New';
    downloadButton.click();
    await flushMacrotasks();
    expect(await persistedRecording(PREVIEW_ID)).toBeNull();

    await saveRecording(PREVIEW_ID, 'saved', 'Original');
    input.value = 'New';
    downloadButton.click();
    await flushMacrotasks();

    expect((await persistedRecording(PREVIEW_ID)).name).toBe('New');
  });
});
