import { jest } from '@jest/globals';

let serviceState = { recording: false, recordingId: null };
let reconcileUnfinishedSessions;
const handleTabClosing = jest.fn();
let onRemovedListener;

const getAllRecordings = jest.fn();
const hasChunks = jest.fn();
const markRecordingRecoverable = jest.fn(async () => undefined);

jest.unstable_mockModule('../../src/services/recordingService.js', () => ({
  CHECKPOINT_ALARM_NAME: 'capturecast-checkpoint',
  createRecordingService: jest.fn(() => ({
    getState: () => serviceState,
    handleMessage: jest.fn(),
    handleCheckpointAlarm: jest.fn(async () => undefined),
    handleTabClosing,
  })),
}));
jest.unstable_mockModule('../../src/lib/db.js', () => ({
  cleanupOldRecordings: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../../src/lib/recording.js', () => ({ getAllRecordings }));
jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({
  hasChunks,
  markRecordingRecoverable,
}));
jest.unstable_mockModule('../../src/logger.js', () => ({
  createLogger: jest.fn(() => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));
jest.unstable_mockModule('../../src/messages.js', () => ({
  schemas: {},
  validateMessageStrict: jest.fn(() => ({ valid: true, errors: [] })),
}));

function makeChrome() {
  return {
    storage: {
      local: {
        get: jest.fn(async () => ({})),
        set: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      },
    },
    tabs: {
      query: jest.fn(),
      create: jest.fn(async () => ({})),
      remove: jest.fn(),
      update: jest.fn(),
      get: jest.fn(),
      sendMessage: jest.fn(),
      onRemoved: { addListener: jest.fn() },
    },
    scripting: { executeScript: jest.fn() },
    offscreen: { createDocument: jest.fn(), closeDocument: jest.fn(), hasDocument: jest.fn() },
    action: { setBadgeBackgroundColor: jest.fn(), setBadgeText: jest.fn() },
    runtime: {
      id: 'test-extension',
      getURL: jest.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: jest.fn(),
      onMessage: { addListener: jest.fn() },
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
    },
    windows: { update: jest.fn() },
    alarms: { create: jest.fn(), clear: jest.fn(), onAlarm: { addListener: jest.fn() } },
  };
}

beforeAll(async () => {
  global.chrome = makeChrome();
  ({ reconcileUnfinishedSessions } = await import('../../src/background.ts'));
  onRemovedListener = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
});

beforeEach(() => {
  jest.clearAllMocks();
  serviceState = { recording: false, recordingId: null };
  getAllRecordings.mockResolvedValue([]);
  hasChunks.mockResolvedValue(false);
  chrome.storage.local.get.mockResolvedValue({});
});

afterAll(() => {
  delete global.chrome;
});

it('leaves the current live recording untouched during periodic reconciliation', async () => {
  serviceState = { recording: true, recordingId: 'live-recording' };
  getAllRecordings.mockResolvedValue([{ id: 'live-recording', status: 'active' }]);
  chrome.storage.local.get.mockResolvedValue({
    sessionSnapshot: { recordingId: 'live-recording', status: 'recording' },
  });

  await reconcileUnfinishedSessions();

  expect(markRecordingRecoverable).not.toHaveBeenCalled();
  expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it('prompts after recovering an orphan that has no session snapshot', async () => {
  getAllRecordings.mockResolvedValue([{ id: 'orphan-recording', status: 'active' }]);

  await reconcileUnfinishedSessions();

  expect(markRecordingRecoverable).toHaveBeenCalledWith('orphan-recording');
  expect(chrome.tabs.create).toHaveBeenCalledWith({
    url: 'chrome-extension://test/recovery.html',
  });
});

it('recovers and prompts for an interrupted persisted snapshot', async () => {
  hasChunks.mockResolvedValue(true);
  chrome.storage.local.get.mockResolvedValue({
    sessionSnapshot: { recordingId: 'interrupted-recording', status: 'recording' },
  });

  await reconcileUnfinishedSessions();

  expect(chrome.storage.local.remove).toHaveBeenCalledWith('sessionSnapshot');
  expect(markRecordingRecoverable).toHaveBeenCalledWith('interrupted-recording');
  expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
});

it('skips reconciling an active recording that still appears live after SW restart', async () => {
  chrome.offscreen.hasDocument.mockResolvedValueOnce(true);
  getAllRecordings.mockResolvedValue([
    { id: 'live-recording', status: 'active' },
    { id: 'orphan-recording', status: 'active' },
  ]);
  chrome.storage.local.get.mockResolvedValue({
    sessionSnapshot: {
      recordingId: 'live-recording',
      status: 'recording',
      strategy: 'offscreen',
      lastActivityAt: Date.now(),
    },
  });

  await reconcileUnfinishedSessions();

  expect(markRecordingRecoverable).toHaveBeenCalledTimes(1);
  expect(markRecordingRecoverable).toHaveBeenCalledWith('orphan-recording');
  expect(chrome.storage.local.remove).not.toHaveBeenCalledWith('sessionSnapshot');
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it('registers a tab removed listener wired to TAB_CLOSING handling', async () => {
  await onRemovedListener(123, { isWindowClosing: false });

  expect(handleTabClosing).toHaveBeenCalledWith(123);
});
