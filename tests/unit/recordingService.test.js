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
    alarms: {
      create: jest.fn(),
      clear: jest.fn(async () => true),
    },
    ...overrides,
  };
}

// RecordingService's onStateChange side effects (badge, session snapshot
// persist/clear) run off a fire-and-forget promise queue chained from the
// XState subscription — callers like handleRecoveryDiscard don't await it.
// Use this to let queued side effects settle before asserting on them.
async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function acknowledgeOffscreen(svc) {
  return svc.handleOffscreenStarted(svc.getState().recordingId);
}

function acknowledgeRecorder(svc) {
  return svc.handleRecorderStarted(svc.getState().recordingId);
}

// A chrome stub whose storage.local actually retains written values, so a
// "service-worker restart" (fresh service over the same chrome) can read back
// the session snapshot a previous instance persisted.
function makeStorageBackedChrome(overrides = {}) {
  const store = {};
  const chrome = makeStubChrome({
    storage: {
      get: jest.fn(async (key) => ({ [key]: store[key] })),
      set: jest.fn(async (data) => Object.assign(store, data)),
      remove: jest.fn(async (key) => {
        delete store[key];
      }),
    },
    ...overrides,
  });
  return { chrome, store };
}

// Simulate the SW being terminated + restarted mid-recording: a brand-new
// RecordingService over the same chrome stub, whose machine starts fresh in
// `idle` with no in-memory knowledge of the live capture.
function simulateServiceWorkerRestart(chrome) {
  __resetRecordingServiceForTests();
  return createRecordingService(chrome);
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
      bestQuality: false,
      recordingId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      targetTabId: 42,
    });
  });

  it('uses the recorder page when the browser does not support offscreen documents', async () => {
    const chrome = makeStubChrome({ capabilities: { offscreen: false } });
    const svc = createRecordingService(chrome);

    const result = await svc.startRecording('screen', false, false);

    expect(result.ok).toBe(true);
    expect(svc.getState().strategy).toBe('page');
    expect(svc.getState().options.includeMic).toBe(false);
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: expect.stringMatching(
        /^chrome-extension:\/\/test\/recorder\.html\?id=[0-9a-f-]{36}&mode=screen&mic=0&sys=0&best=0$/i
      ),
      active: true,
    });
  });

  it('forwards best quality to the offscreen recorder and machine state', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    const result = await svc.startRecording('tab', false, false, true);

    expect(result.ok).toBe(true);
    expect(svc.getState().options.bestQuality).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'OFFSCREEN_START',
        bestQuality: true,
      })
    );
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
        /^chrome-extension:\/\/test\/recorder\.html\?id=[0-9a-f-]{36}&mode=screen&mic=1&sys=1&best=0$/i
      ),
      active: true,
    });
    expect(svc.getState().status).toBe('starting');
  });

  it('fails page startup when the newly created recorder tab already closed', async () => {
    const chrome = makeStubChrome();
    chrome.tabs.get.mockRejectedValueOnce(new Error('No tab with id: 99'));
    const svc = createRecordingService(chrome);

    const result = await svc.startRecording('screen', true, true);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No tab with id/);
    expect(svc.getState().status).toBe('idle');
    expect(svc.recorderTabId).toBeNull();
  });

  it('rejects duplicate START while a recording is active', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    const recordingId = svc.getState().recordingId;

    const result = await svc.startRecording('tab', false, false);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recording/);
    expect(svc.getState().recordingId).toBe(recordingId);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent START requests before their first await', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    const [first, second] = await Promise.all([
      svc.startRecording('tab', false, false),
      svc.startRecording('tab', false, false),
    ]);
    const offscreenStarts = chrome.runtime.sendMessage.mock.calls.filter(
      ([message]) => message.type === 'OFFSCREEN_START'
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      error: 'Cannot start: initialization already in progress',
    });
    expect(offscreenStarts).toHaveLength(1);
  });

  it('blocks replacement START until a cancelled initialization settles', async () => {
    const chrome = makeStubChrome();
    let resolveTabCreation;
    const tabCreation = new Promise((resolve) => {
      resolveTabCreation = resolve;
    });
    chrome.tabs.create.mockImplementationOnce(() => tabCreation);
    const svc = createRecordingService(chrome);

    const firstStart = svc.startRecording('tab', true, false);
    await flushMicrotasks();
    await svc.stopRecording();
    const overlappingStart = await svc.startRecording('tab', false, false);

    expect(overlappingStart).toEqual({
      ok: false,
      error: 'Cannot start: initialization already in progress',
    });

    resolveTabCreation({ id: 99 });
    await expect(firstStart).resolves.toEqual({
      ok: false,
      error: 'Recording start was cancelled during initialization',
    });

    const replacementStart = await svc.startRecording('tab', false, false);
    expect(replacementStart.ok).toBe(true);
  });

  it('ignores a stale acknowledgment without cancelling the current start timeout', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    const staleRecordingId = svc.getState().recordingId;
    await svc.stopRecording();

    await svc.startRecording('tab', true, false);
    const currentRecordingId = svc.getState().recordingId;
    const accepted = svc.handleOffscreenStarted(staleRecordingId);

    expect(accepted).toBe(false);
    expect(currentRecordingId).not.toBe(staleRecordingId);
    expect(svc.getState().status).toBe('starting');
    jest.advanceTimersByTime(5000);
    expect(svc.getState().status).toBe('recording');
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
    acknowledgeOffscreen(svc);
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
    acknowledgeOffscreen(svc);
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
    acknowledgeRecorder(svc);
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
    acknowledgeOffscreen(svc);

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
    if (withMic) acknowledgeRecorder(svc);
    else acknowledgeOffscreen(svc);
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

describe('tab close handling', () => {
  it('ignores unrelated tab close events', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);

    await svc.handleTabClosing(12345);

    expect(svc.getState().status).toBe('recording');
    expect(svc.getState().recording).toBe(true);
  });

  it('transitions to failed when the active recording tab closes', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);

    // Overlay tab from stubbed query is id 42.
    await svc.handleTabClosing(42);

    expect(svc.getState().status).toBe('failed');
    expect(svc.getState().error).toBe('Tab closed during recording');
    expect(svc.getState().recording).toBe(false);
  });

  it('fails and cleans up when the recorder tab closes during startup', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', true, false);

    const handled = await svc.handleTabClosing(99);

    expect(handled).toBe(true);
    expect(svc.getState().status).toBe('failed');
    expect(svc.getState().error).toBe('Tab closed during recording');
    expect(chrome.tabs.remove).not.toHaveBeenCalledWith(99);
    jest.advanceTimersByTime(5000);
    expect(svc.getState().status).toBe('failed');
  });

  it('removes a recorder tab that finishes opening after startup was cancelled', async () => {
    const chrome = makeStubChrome();
    let resolveTabCreation;
    const tabCreation = new Promise((resolve) => {
      resolveTabCreation = resolve;
    });
    chrome.tabs.create.mockImplementationOnce(() => tabCreation);
    const svc = createRecordingService(chrome);

    const start = svc.startRecording('tab', true, false);
    await flushMicrotasks();
    expect(chrome.tabs.create).toHaveBeenCalled();

    await svc.handleTabClosing(42);
    resolveTabCreation({ id: 99 });
    const result = await start;

    expect(result).toEqual({
      ok: false,
      error: 'Recording start was cancelled during initialization',
    });
    expect(svc.getState().status).toBe('failed');
    expect(chrome.tabs.remove).toHaveBeenCalledWith(99);
  });

  it('continues cleanup when a sibling recorder tab is already gone', async () => {
    const chrome = makeStubChrome();
    chrome.tabs.remove.mockRejectedValueOnce(new Error('No tab with id: 99'));
    chrome.offscreen.hasDocument.mockResolvedValue(true);
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', true, false);
    acknowledgeRecorder(svc);

    await expect(svc.handleTabClosing(42)).resolves.toBe(true);

    expect(svc.getState().status).toBe('failed');
    expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
    expect(svc.recorderTabId).toBeNull();
  });
});

describe('state projection and recovery exits', () => {
  it('does not report recording=true after saved data arrives', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    const recordingId = svc.getState().recordingId;

    await svc.handleOffscreenData(recordingId, 'video/webm');

    expect(svc.getState().status).toBe('saved');
    expect(svc.getState().recording).toBe(false);
  });

  it('recovery discard clears a recording after its save times out', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    const recordingId = svc.getState().recordingId;

    await svc.stopRecording();
    jest.advanceTimersByTime(60_000);
    expect(svc.getState().status).toBe('recoverable');

    await svc.handleRecoveryDiscard(recordingId);

    expect(svc.getState().status).toBe('idle');
    expect(svc.getState().recording).toBe(false);
    await flushMicrotasks();
    expect(chrome.storage.remove).toHaveBeenCalledWith('sessionSnapshot');
  });

  it('rejects a stale recovery discard without touching the active session', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', true, false);
    acknowledgeRecorder(svc);
    const recordingId = svc.getState().recordingId;

    const discarded = await svc.handleRecoveryDiscard(VALID_UUID);

    expect(discarded).toBe(false);
    expect(svc.getState().status).toBe('recording');
    expect(svc.getState().recordingId).toBe(recordingId);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
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
    acknowledgeOffscreen(svc);

    await svc.handleOffscreenError('Permission denied', 'PERMISSION_DENIED');

    expect(svc.getState().status).toBe('failed');
    expect(svc.getState().recording).toBe(false);
    expect(chrome.offscreen.closeDocument).toHaveBeenCalled();
  });

  it('ignores stale errors from a different recording id', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);

    await svc.handleOffscreenError('stale failure', 'CAPTURE_FAILED', VALID_UUID);

    expect(svc.getState().status).toBe('recording');
    expect(svc.getState().recording).toBe(true);
  });

  it('does not re-arm a checkpoint stopped while persistence is in flight', async () => {
    jest.useRealTimers();
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);

    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    chrome.storage.set.mockClear();
    chrome.alarms.create.mockClear();
    chrome.alarms.clear.mockClear();

    let releasePersist;
    const blockedPersist = new Promise((resolve) => {
      releasePersist = resolve;
    });
    chrome.storage.set.mockImplementationOnce(() => blockedPersist);

    const checkpoint = svc.handleCheckpointAlarm();
    await flushMicrotasks(2);
    expect(chrome.storage.set).toHaveBeenCalledTimes(1);

    await svc.handleOffscreenError('capture failed');
    expect(chrome.alarms.clear).toHaveBeenCalled();
    releasePersist();
    await checkpoint;

    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });
});

describe('session restore & heartbeat (service-worker restart recovery)', () => {
  async function startAndPersist(chrome) {
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    expect(svc.getState().status).toBe('recording');
    const recordingId = svc.getState().recordingId;
    await flushMicrotasks(); // let the queued snapshot persist settle
    return { svc, recordingId };
  }

  it('accepts heartbeats for the active session', async () => {
    const chrome = makeStorageBackedChrome().chrome;
    const { svc, recordingId } = await startAndPersist(chrome);

    const result = await svc.handleHeartbeat(recordingId);

    expect(result).toEqual({ ok: true });
    expect(svc.getState().status).toBe('recording');
  });

  it('rejects heartbeats with an invalid id', async () => {
    const chrome = makeStorageBackedChrome().chrome;
    const svc = createRecordingService(chrome);
    const result = await svc.handleHeartbeat('not-a-uuid');
    expect(result).toEqual({ ok: false, error: 'Invalid recording ID' });
  });

  it('restores a live offscreen session after a service-worker restart', async () => {
    const { chrome } = makeStorageBackedChrome({
      offscreen: { ...makeStubChrome().offscreen, hasDocument: jest.fn(async () => true) },
    });
    const { recordingId } = await startAndPersist(chrome);

    const restarted = simulateServiceWorkerRestart(chrome);
    expect(restarted.getState().status).toBe('idle');

    const result = await restarted.handleHeartbeat(recordingId);

    expect(result).toEqual({ ok: true });
    expect(restarted.getState().status).toBe('recording');
    expect(restarted.getState().recordingId).toBe(recordingId);
  });

  it('does not restore when the offscreen document is gone', async () => {
    const { chrome } = makeStorageBackedChrome(); // hasDocument → false
    const { recordingId } = await startAndPersist(chrome);

    const restarted = simulateServiceWorkerRestart(chrome);
    const result = await restarted.handleHeartbeat(recordingId);

    expect(result.ok).toBe(false);
    expect(restarted.getState().status).toBe('idle');
  });

  it('accepts late OFFSCREEN_DATA for a live session after restart', async () => {
    const { chrome } = makeStorageBackedChrome({
      offscreen: { ...makeStubChrome().offscreen, hasDocument: jest.fn(async () => true) },
    });
    const { recordingId } = await startAndPersist(chrome);

    const restarted = simulateServiceWorkerRestart(chrome);
    await restarted.handleOffscreenData(recordingId, 'video/webm');

    expect(restarted.getState().status).toBe('saved');
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/preview.html?id=${encodeURIComponent(recordingId)}`,
    });
  });

  it('rejects a new START while a live session is reclaimed after restart', async () => {
    const { chrome } = makeStorageBackedChrome({
      offscreen: { ...makeStubChrome().offscreen, hasDocument: jest.fn(async () => true) },
    });
    const { recordingId } = await startAndPersist(chrome);

    const restarted = simulateServiceWorkerRestart(chrome);
    const result = await restarted.startRecording('tab', false, false);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already in progress/);
    expect(restarted.getState().recordingId).toBe(recordingId);
  });

  it('restores a live recorder-tab session after a service-worker restart', async () => {
    const { chrome } = makeStorageBackedChrome();
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', true, false); // mic → page strategy
    acknowledgeRecorder(svc);
    const recordingId = svc.getState().recordingId;
    await flushMicrotasks(); // let the queued snapshot persist settle

    chrome.tabs.query.mockResolvedValue([
      { id: 99, windowId: 1, url: `chrome-extension://test/recorder.html?id=${recordingId}` },
    ]);

    const restarted = simulateServiceWorkerRestart(chrome);
    const result = await restarted.handleHeartbeat(recordingId);

    expect(result).toEqual({ ok: true });
    expect(restarted.getState().status).toBe('recording');
    expect(restarted.recorderTabId).toBe(99);

    await restarted.stopRecording();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, { type: 'RECORDER_STOP' });
  });
});

describe('recording duration badge', () => {
  it('shows a ticking elapsed-time badge while recording', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    expect(svc.getState().status).toBe('recording');
    await flushMicrotasks();

    // Entering `recording` writes the elapsed time immediately.
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '0:00' });

    // The 1s badge interval keeps the duration fresh.
    jest.advanceTimersByTime(1500);
    await flushMicrotasks();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '0:01' });

    jest.advanceTimersByTime(65_000);
    await flushMicrotasks();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1:06' });
  });

  it('stops updating the badge once recording ends', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    await flushMicrotasks();

    await svc.stopRecording();
    await flushMicrotasks();

    // Leaving `recording` flips the badge to SAVE and clears the ticker.
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: 'SAVE' });
    const writesAfterStop = chrome.action.setBadgeText.mock.calls.length;

    // No further badge writes: the 1s ticker was cleared.
    jest.advanceTimersByTime(3000);
    await flushMicrotasks();
    expect(chrome.action.setBadgeText.mock.calls.length).toBe(writesAfterStop);
  });

  it('re-arms and refreshes the duration badge after a service-worker restart', async () => {
    const { chrome } = makeStorageBackedChrome({
      offscreen: { ...makeStubChrome().offscreen, hasDocument: jest.fn(async () => true) },
    });
    const svc = createRecordingService(chrome);
    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    const recordingId = svc.getState().recordingId;
    await flushMicrotasks(); // let the queued snapshot persist settle

    const restarted = simulateServiceWorkerRestart(chrome);
    await restarted.handleHeartbeat(recordingId);

    expect(restarted.getState().status).toBe('recording');
    // The heartbeat writes the badge immediately and restarts the ticker.
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '0:00' });

    jest.advanceTimersByTime(1500);
    await flushMicrotasks();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '0:01' });
  });
});

describe('overlay STATE_UPDATE push', () => {
  it('pushes starting→recording transitions to the overlay tab', async () => {
    const chrome = makeStubChrome();
    const svc = createRecordingService(chrome);

    await svc.startRecording('tab', false, false);
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'STATE_UPDATE',
      status: 'starting',
    });

    acknowledgeOffscreen(svc);
    await flushMicrotasks();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'STATE_UPDATE',
      status: 'recording',
    });
  });

  it('keeps recording when the overlay tab rejects the push', async () => {
    const chrome = makeStubChrome();
    chrome.tabs.sendMessage.mockRejectedValue(new Error('no receiver'));
    const svc = createRecordingService(chrome);

    await svc.startRecording('tab', false, false);
    acknowledgeOffscreen(svc);
    await flushMicrotasks();

    expect(svc.getState().status).toBe('recording');
  });
});
