/**
 * Unit tests for RecordingService — the bridge between the XState recording
 * machine and Chrome APIs. Uses a stub ChromeAPI to verify the service:
 *  - routes incoming messages to the right handler
 *  - runs the expected Chrome-side effects for startRecording / stopRecording
 *  - validates UUIDs in handleOffscreenData / handleRecorderData
 *  - is resettable between tests via __resetRecordingServiceForTests
 */

import { jest } from '@jest/globals';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// Mock checkStorageQuota so the service doesn't try to read real IndexedDB.
jest.unstable_mockModule('../../src/lib/storage-utils.js', () => ({
  checkStorageQuota: jest.fn(async () => ({ ok: true })),
}));

let createRecordingService;
let __resetRecordingServiceForTests;
let storageUtils;

beforeAll(async () => {
  storageUtils = await import('../../src/lib/storage-utils.js');
  const mod = await import('../../src/services/recordingService.ts');
  createRecordingService = mod.createRecordingService;
  __resetRecordingServiceForTests = mod.__resetRecordingServiceForTests;
});

function makeStubChrome(overrides = {}) {
  return {
    storage: {
      get: jest.fn(async () => ({})),
      set: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    },
    tabs: {
      query: jest.fn(async () => [{ id: 42, windowId: 1 }]),
      create: jest.fn(async () => ({ id: 99 })),
      remove: jest.fn(async () => undefined),
      update: jest.fn(async () => undefined),
      get: jest.fn(async () => ({ windowId: 1 })),
      sendMessage: jest.fn(async () => undefined),
    },
    scripting: {
      executeScript: jest.fn(async () => undefined),
    },
    offscreen: {
      createDocument: jest.fn(async () => undefined),
      closeDocument: jest.fn(async () => undefined),
      hasDocument: jest.fn(async () => false),
    },
    action: {
      setBadgeBackgroundColor: jest.fn(async () => undefined),
      setBadgeText: jest.fn(async () => undefined),
    },
    runtime: {
      getURL: jest.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: jest.fn(async () => undefined),
      id: 'test-extension-id',
    },
    windows: {
      update: jest.fn(async () => undefined),
    },
    ...overrides,
  };
}

beforeEach(() => {
  __resetRecordingServiceForTests();
  storageUtils.checkStorageQuota.mockClear();
  storageUtils.checkStorageQuota.mockResolvedValue({ ok: true });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createRecordingService factory', () => {
  it('returns the same singleton instance on repeated calls', () => {
    const chrome = makeStubChrome();
    const a = createRecordingService(chrome);
    const b = createRecordingService(chrome);
    expect(a).toBe(b);
  });

  it('__resetRecordingServiceForTests releases the singleton', () => {
    const chrome = makeStubChrome();
    const a = createRecordingService(chrome);
    __resetRecordingServiceForTests();
    const b = createRecordingService(chrome);
    expect(a).not.toBe(b);
  });
});

describe('startRecording', () => {
  it('checks storage quota, queries the active tab, and starts the machine', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    const result = await svc.startRecording('tab', false, false);

    expect(result.ok).toBe(true);
    expect(storageUtils.checkStorageQuota).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(svc.getState().status).toBe('starting');
    expect(svc.getState().options.mode).toBe('tab');
    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith({
      url: 'chrome-extension://test/offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.',
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'OFFSCREEN_START',
      mode: 'tab',
      includeAudio: false,
      recordingId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      targetTabId: 42,
    });
  });

  it('refuses to start when storage quota is exhausted', async () => {
    const chrome = makeStubChrome();
    storageUtils.checkStorageQuota.mockResolvedValueOnce({
      ok: false,
      error: 'storage-quota-exceeded',
    });
    const svc = createRecordingService(chrome);

    const result = await svc.startRecording('tab', false, false);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('storage-quota-exceeded');
    expect(svc.getState().status).toBe('idle');
  });

  it('eventually fires CONFIRMATION_TIMEOUT and moves to recording', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    await svc.startRecording('tab', false, false);
    expect(svc.getState().status).toBe('starting');

    // Fast-forward past the confirmation timeout (5000ms). Don't use
    // runAllTimers() — the service also schedules a recurring checkpoint
    // interval, which would loop forever.
    jest.advanceTimersByTime(5000);
    expect(svc.getState().status).toBe('recording');
  });

  it('opens the recorder tab for page strategy when microphone is enabled', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    const result = await svc.startRecording('screen', true, true);

    expect(result.ok).toBe(true);
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringMatching(
        /^chrome-extension:\/\/test\/recorder\.html\?id=[0-9a-f-]{36}&mode=screen&mic=1&sys=1$/i
      ),
      active: true,
    });
    expect(svc.getState().status).toBe('starting');
  });

  it('rejects duplicate START while a recording is active', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();
    const recordingId = svc.getState().recordingId;

    const result = await svc.startRecording('tab', false, false);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recording/);
    expect(svc.getState().recordingId).toBe(recordingId);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  });

  describe('tab closing handling', () => {
    it('ignores tab close events for non-owned tabs while recording', async () => {
      const chrome = makeStubChrome();
      const svc = createRecordingService(chrome);
      await svc.startRecording('tab', false, false);
      svc.handleOffscreenStarted();
      expect(svc.getState().status).toBe('recording');

      svc.handleTabClosing(1234);

      expect(svc.getState().status).toBe('recording');
    });

  it('transitions to failed when the active overlay tab closes during recording', async () => {
      const chrome = makeStubChrome();
      const svc = createRecordingService(chrome);
      await svc.startRecording('tab', false, false);
      svc.handleOffscreenStarted();

      svc.overlayTabId = 42;

      svc.handleTabClosing(42); // active tab where overlay is injected

      expect(svc.getState().status).toBe('failed');
    });

  it('transitions to failed and closes the recorder tab when recorder tab closes during recording', async () => {
      const chrome = makeStubChrome();
      const svc = createRecordingService(chrome);
      await svc.startRecording('tab', true, false);
      svc.handleRecorderStarted();
      expect(svc.getState().status).toBe('recording');

      svc.recorderTabId = 99;

      svc.handleTabClosing(99); // recorder tab id

      expect(svc.getState().status).toBe('failed');
      expect(chrome.tabs.remove).toHaveBeenCalledWith(99);
    });

    it('does not transition to failed for tab closes already tracked as service-owned cleanup', async () => {
      const chrome = makeStubChrome();
      const svc = createRecordingService(chrome);
      await svc.startRecording('tab', true, false);
      svc.handleRecorderStarted();

      svc.expectedClosedTabs.add(99);
      svc.handleTabClosing(99);

      expect(svc.getState().status).toBe('recording');
      expect(svc.expectedClosedTabs.has(99)).toBe(false);
    });
  });

  describe('stopRecording', () => {
  it('rejects when state is idle', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    const result = await svc.stopRecording();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/idle/);
  });

  it('accepts STOP from starting and returns to idle', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    expect(svc.getState().status).toBe('starting');

    const result = await svc.stopRecording();

    expect(result.ok).toBe(true);
    expect(svc.getState().status).toBe('idle');
  });

  it('accepts STOP from recording and transitions to stopping', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();
    expect(svc.getState().status).toBe('recording');

    const result = await svc.stopRecording();

    expect(result.ok).toBe(true);
    expect(svc.getState().status).toBe('stopping');
    // Offscreen strategy → outbound OFFSCREEN_STOP message
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP' });
  });

  it('is idempotent when called again during stopping', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();
    await svc.stopRecording();
    expect(svc.getState().status).toBe('stopping');

    const result = await svc.stopRecording();
    expect(result.ok).toBe(true);
    expect(svc.getState().status).toBe('stopping');
  });

  it('uses RECORDER_STOP for the page strategy (mic enabled)', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', true /* mic */, false);
    svc.handleRecorderStarted();
    expect(svc.getState().status).toBe('recording');

    await svc.stopRecording();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, { type: 'RECORDER_STOP' });
  });

  it('moves to recoverable when the stop control message fails', async () => {
    const chrome = makeStubChrome({
      runtime: {
        getURL: jest.fn((path) => `chrome-extension://test/${path}`),
        sendMessage: jest.fn(async (message) => {
          if (message.type === 'OFFSCREEN_STOP') throw new Error('Receiving end does not exist');
          return undefined;
        }),
        id: 'test-extension-id',
      },
    });
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();

    const result = await svc.stopRecording();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Receiving end/);
    expect(svc.getState().status).toBe('recoverable');
    expect(svc.getState().recording).toBe(false);
  });
});

describe('handleOffscreenData / handleRecorderData', () => {
  async function arriveAtStopping(chrome, svc, withMic = false) {
    await svc.startRecording('tab', withMic, false);
    if (withMic) svc.handleRecorderStarted();
    else svc.handleOffscreenStarted();
    const recordingId = svc.getState().recordingId;
    await svc.stopRecording();
    return recordingId;
  }

  it('rejects invalid UUIDs without state change', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await arriveAtStopping(chrome, svc);

    await svc.handleOffscreenData('not-a-uuid', 'video/webm');
    expect(svc.getState().status).toBe('stopping'); // unchanged
    expect(chrome.tabs.create).not.toHaveBeenCalled(); // no preview opened
  });

  it('transitions stopping → saved and opens the preview tab on valid UUID', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    const recordingId = await arriveAtStopping(chrome, svc);

    await svc.handleOffscreenData(recordingId, 'video/webm');
    expect(svc.getState().status).toBe('saved');
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/preview.html?id=${encodeURIComponent(recordingId)}`,
    });
  });

  it('accepts final data that arrives while start confirmation is still pending', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    const recordingId = svc.getState().recordingId;

    await svc.handleOffscreenData(recordingId, 'video/webm');

    expect(svc.getState().status).toBe('saved');
    expect(svc.getState().recording).toBe(false);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/preview.html?id=${encodeURIComponent(recordingId)}`,
    });
  });

  it('handleRecorderData mirrors the offscreen flow for the page strategy', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    const recordingId = await arriveAtStopping(chrome, svc, true /* mic */);

    await svc.handleRecorderData(recordingId, 'video/webm');
    expect(svc.getState().status).toBe('saved');
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/preview.html?id=${encodeURIComponent(recordingId)}`,
    });
  });

  it('ignores data messages for a different recording id', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await arriveAtStopping(chrome, svc);
    const removeCallsBefore = chrome.storage.remove.mock.calls.length;

    await svc.handleOffscreenData(VALID_UUID, 'video/webm');

    expect(svc.getState().status).toBe('stopping');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.storage.remove).toHaveBeenCalledTimes(removeCallsBefore);
  });

  it('accepts late matching data after save timeout moves to recoverable', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    const recordingId = await arriveAtStopping(chrome, svc);
    jest.advanceTimersByTime(60000);
    expect(svc.getState().status).toBe('recoverable');

    await svc.handleOffscreenData(recordingId, 'video/webm');

    expect(svc.getState().status).toBe('saved');
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/preview.html?id=${encodeURIComponent(recordingId)}`,
    });
  });
});

describe('handleMessage routing', () => {
  it('routes START messages through startRecording', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    const result = await svc.handleMessage(
      { type: 'START', mode: 'tab', mic: false, systemAudio: false },
      { id: chrome.runtime.id }
    );

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(svc.getState().status).toBe('starting');
  });

  it('routes GET_STATE and returns the snapshot', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    const result = await svc.handleMessage({ type: 'GET_STATE' }, { id: chrome.runtime.id });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('idle');
    expect(result.recording).toBe(false);
  });

  it('returns ok for echoed outbound message types (OFFSCREEN_STOP, RECORDER_STOP, etc.)', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    for (const type of ['OFFSCREEN_START', 'OFFSCREEN_STOP', 'RECORDER_STOP', 'OFFSCREEN_TEST']) {
      const result = await svc.handleMessage({ type }, { id: chrome.runtime.id });
      expect(result.ok).toBe(true);
    }
  });

  it('returns ok:false for unhandled types', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    const result = await svc.handleMessage({ type: 'TOTALLY_BOGUS' }, { id: chrome.runtime.id });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unhandled/);
  });
});

describe('state projection and recovery exits', () => {
  it('does not report recording=true after saved data arrives', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();
    const recordingId = svc.getState().recordingId;

    await svc.handleOffscreenData(recordingId, 'video/webm');

    expect(svc.getState().status).toBe('saved');
    expect(svc.getState().recording).toBe(false);
  });

  it('recovery discard clears an active reconciled recording', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    svc.reconcile({
      recordingId: VALID_UUID,
      status: 'recording',
      startedAt: 1,
      lastActivityAt: 2,
      options: { mode: 'tab', includeMic: false, includeSystemAudio: false },
      strategy: 'offscreen',
      correlationId: VALID_UUID,
    });

    await svc.handleRecoveryDiscard(VALID_UUID);

    expect(svc.getState().status).toBe('idle');
    expect(svc.getState().recording).toBe(false);
    expect(chrome.storage.remove).toHaveBeenCalledWith('sessionSnapshot');
  });

  it('cleans up and reports inactive after offscreen errors', async () => {
    const chrome = makeStubChrome({
      offscreen: {
        createDocument: jest.fn(async () => undefined),
        closeDocument: jest.fn(async () => undefined),
        hasDocument: jest.fn(async () => true),
      },
    });
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();

    await svc.handleOffscreenError('Permission denied', 'PERMISSION_DENIED');

    expect(svc.getState().status).toBe('failed');
    expect(svc.getState().recording).toBe(false);
    expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
  });

  it('ignores stale errors from a different recording id', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();

    await svc.handleOffscreenError('stale failure', 'CAPTURE_FAILED', VALID_UUID);

    expect(svc.getState().status).toBe('recording');
    expect(svc.getState().recording).toBe(true);
  });
});

describe('reconcile', () => {
  it('hydrates the machine from a snapshot when idle', () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    svc.reconcile({
      recordingId: VALID_UUID,
      status: 'recording',
      startedAt: 1,
      lastActivityAt: 2,
      options: { mode: 'tab', includeMic: false, includeSystemAudio: false },
      strategy: 'offscreen',
      correlationId: VALID_UUID,
    });

    expect(svc.getState().status).toBe('recording');
    expect(svc.getState().recordingId).toBe(VALID_UUID);
  });

  it('does not clobber an already-active machine', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    await svc.startRecording('tab', false, false);
    svc.handleOffscreenStarted();
    const idBeforeReconcile = svc.getState().recordingId;

    svc.reconcile({
      recordingId: VALID_UUID,
      status: 'recording',
      startedAt: 1,
      lastActivityAt: 2,
      options: { mode: 'tab', includeMic: false, includeSystemAudio: false },
      strategy: 'offscreen',
      correlationId: VALID_UUID,
    });

    expect(svc.getState().recordingId).toBe(idBeforeReconcile);
  });
});
