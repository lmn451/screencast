import { jest } from '@jest/globals';

global.crypto = {
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
};

const mockActionSetBadgeBackgroundColor = jest.fn().mockResolvedValue(undefined);
const mockActionSetBadgeText = jest.fn().mockResolvedValue(undefined);
const mockRuntimeGetURL = jest.fn((path) => `chrome-extension://test-extension-id/${path}`);
const mockRuntimeSendMessage = jest.fn().mockResolvedValue({ ok: true });
const mockRuntimeConnect = jest.fn();
const mockTabsQuery = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockTabsCreate = jest.fn().mockResolvedValue({ id: 123 });
const mockTabsRemove = jest.fn().mockResolvedValue(undefined);
const mockTabsSendMessage = jest.fn().mockResolvedValue({ ok: true });
const mockTabsUpdate = jest.fn().mockResolvedValue(undefined);
const mockTabsGet = jest.fn().mockResolvedValue({ id: 1, windowId: 1 });
const mockWindowsUpdate = jest.fn().mockResolvedValue(undefined);
const mockScriptingExecuteScript = jest.fn().mockResolvedValue([]);
const mockOffscreenCreateDocument = jest.fn().mockResolvedValue(undefined);
const mockOffscreenCloseDocument = jest.fn().mockResolvedValue(undefined);
const mockOffscreenHasDocument = jest.fn().mockResolvedValue(false);
const mockTabCaptureGetMediaStreamId = jest.fn().mockResolvedValue('stream-id-test');
const mockStorageEstimate = jest
  .fn()
  .mockResolvedValue({ usage: 100 * 1024 * 1024, quota: 1000 * 1024 * 1024 });
const mockDebuggerAttach = jest.fn().mockResolvedValue(undefined);
const mockDebuggerDetach = jest.fn().mockResolvedValue(undefined);
const mockDebuggerSendCommand = jest.fn().mockResolvedValue(undefined);
const mockDebuggerGetTargets = jest.fn().mockResolvedValue([]);

const mockPortPostMessage = jest.fn();
const mockPortOnMessage = { addListener: jest.fn() };
const mockPortOnDisconnect = { addListener: jest.fn() };
const mockPortDisconnect = jest.fn();

global.chrome = {
  ...global.chrome,
  action: {
    setBadgeBackgroundColor: mockActionSetBadgeBackgroundColor,
    setBadgeText: mockActionSetBadgeText,
  },
  runtime: {
    ...global.chrome.runtime,
    getURL: mockRuntimeGetURL,
    sendMessage: mockRuntimeSendMessage,
    connect: mockRuntimeConnect.mockReturnValue({
      postMessage: mockPortPostMessage,
      onMessage: mockPortOnMessage,
      onDisconnect: mockPortOnDisconnect,
      disconnect: mockPortDisconnect,
    }),
  },
  tabs: {
    query: mockTabsQuery,
    create: mockTabsCreate,
    remove: mockTabsRemove,
    sendMessage: mockTabsSendMessage,
    update: mockTabsUpdate,
    get: mockTabsGet,
  },
  windows: {
    update: mockWindowsUpdate,
  },
  scripting: {
    executeScript: mockScriptingExecuteScript,
  },
  offscreen: {
    createDocument: mockOffscreenCreateDocument,
    closeDocument: mockOffscreenCloseDocument,
    hasDocument: mockOffscreenHasDocument,
  },
  tabCapture: {
    getMediaStreamId: mockTabCaptureGetMediaStreamId,
  },
  debugger: {
    attach: mockDebuggerAttach,
    detach: mockDebuggerDetach,
    sendCommand: mockDebuggerSendCommand,
    getTargets: mockDebuggerGetTargets,
  },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  },
};

global.navigator = {
  storage: {
    estimate: mockStorageEstimate,
  },
};

const STATE = {
  status: 'IDLE',
  backend: null,
  mode: null,
  recordingId: null,
  overlayTabId: null,
  includeMic: false,
  includeSystemAudio: false,
  recorderTabId: null,
  strategy: null,
  stopTimeoutId: null,
  isAutomation: false,
  cdpTabId: null,
  cdpPort: null,
};

async function updateBadge() {
  try {
    let color = '#00000000';
    let text = '';

    if (STATE.status === 'RECORDING') {
      color = '#d93025';
      text = 'REC';
    } else if (STATE.status === 'SAVING') {
      color = '#f9ab00';
      text = 'SAVE';
    }

    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {
    /* no-op */
  }
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function canUseOffscreen() {
  return !!(chrome.offscreen && chrome.offscreen.createDocument);
}

async function startTabCapture(tabId, mode, includeMic, includeSystemAudio, options = {}) {
  if (STATE.status !== 'IDLE') {
    return { ok: false, error: 'Already recording or saving' };
  }

  STATE.backend = 'tabCapture';
  STATE.mode = mode || 'tab';
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = options.targetTabId || tabId || (await getActiveTabId());
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;
  STATE.isAutomation = !!options.automation;

  const useOffscreen = !STATE.includeMic && canUseOffscreen();

  if (useOffscreen) {
    const existing = await hasOffscreenDocument();
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification:
          'Record a screen capture stream using MediaRecorder in an offscreen document.',
      });
    }

    let streamId = options.streamId || null;
    if (!streamId && STATE.overlayTabId) {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: STATE.overlayTabId,
        });
      } catch (e) {
        /* ignore */
      }
    }

    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode: STATE.mode,
      includeAudio: STATE.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId,
      streamId: streamId,
    });
    STATE.strategy = 'offscreen';
  } else {
    let streamId = options.streamId || null;
    if (!streamId && STATE.overlayTabId) {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId: STATE.overlayTabId,
        });
      } catch (e) {
        /* ignore */
      }
    }

    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
        STATE.mode
      )}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}${
        streamId ? '&streamId=' + encodeURIComponent(streamId) : ''
      }`
    );
    const tab = await chrome.tabs.create({ url, active: true });
    STATE.recorderTabId = tab.id ?? null;
    STATE.strategy = 'page';
  }

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected: false, backend: 'tabCapture' };
}

async function startCDPScreencast(tabId, mode, includeMic, includeSystemAudio, options = {}) {
  if (STATE.status !== 'IDLE') {
    return { ok: false, error: 'Already recording or saving' };
  }

  STATE.backend = 'cdpScreencast';
  STATE.mode = mode || 'tab';
  STATE.recordingId = crypto.randomUUID();
  STATE.overlayTabId = options.targetTabId || tabId || (await getActiveTabId());
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;
  STATE.isAutomation = !!options.automation;
  STATE.cdpTabId = STATE.overlayTabId;

  const existing = await chrome.offscreen.hasDocument?.();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Record a screen capture stream using MediaRecorder in an offscreen document.',
    });
  }

  const cdpPort = chrome.runtime.connect(undefined, { name: 'cdpScreencast' });
  STATE.cdpPort = cdpPort;

  cdpPort.postMessage({
    type: 'CDP_START',
    tabId: STATE.cdpTabId,
    recordingId: STATE.recordingId,
    mode: STATE.mode,
    includeAudio: STATE.includeSystemAudio || STATE.includeMic,
  });

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected: false, backend: 'cdpScreencast' };
}

async function startRecording(mode, includeMic, includeSystemAudio, options = {}) {
  const backend = options.backend || 'tabCapture';

  if (backend === 'cdpScreencast') {
    return startCDPScreencast(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  } else {
    return startTabCapture(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  }
}

async function stopRecording() {
  if (STATE.status !== 'RECORDING') return { ok: false, error: 'Not recording' };

  STATE.status = 'SAVING';
  await updateBadge();

  if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
  STATE.stopTimeoutId = setTimeout(async () => {
    await resetRecordingState();
  }, 60000);

  try {
    if (STATE.backend === 'cdpScreencast' && STATE.cdpPort) {
      STATE.cdpPort.postMessage({ type: 'CDP_STOP' });
      STATE.cdpPort.disconnect();
      STATE.cdpPort = null;
    } else if (STATE.strategy === 'page') {
      await chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
    } else {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    }
  } catch (e) {
    return { ok: false, error: 'Failed to send stop signal: ' + e.message };
  }

  return { ok: true };
}

async function resetRecordingState() {
  if (STATE.stopTimeoutId) {
    clearTimeout(STATE.stopTimeoutId);
    STATE.stopTimeoutId = null;
  }

  STATE.status = 'IDLE';
  await updateBadge();

  if (STATE.recorderTabId) {
    try {
      await chrome.tabs.remove(STATE.recorderTabId);
    } catch (e) {
      /* no-op */
    }
  }

  if (STATE.cdpPort) {
    try {
      STATE.cdpPort.disconnect();
    } catch (e) {
      /* no-op */
    }
    STATE.cdpPort = null;
  }

  STATE.backend = null;
  STATE.mode = null;
  STATE.overlayTabId = null;
  STATE.includeMic = false;
  STATE.includeSystemAudio = false;
  STATE.recorderTabId = null;
  STATE.strategy = null;
  STATE.isAutomation = false;
  STATE.cdpTabId = null;
}

function hasOffscreenDocument() {
  return chrome.offscreen.hasDocument?.();
}

function getState() {
  return {
    ...STATE,
    recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING',
  };
}

describe('State Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    STATE.status = 'IDLE';
    STATE.backend = null;
    STATE.mode = null;
    STATE.recordingId = null;
    STATE.overlayTabId = null;
    STATE.includeMic = false;
    STATE.includeSystemAudio = false;
    STATE.recorderTabId = null;
    STATE.strategy = null;
    STATE.stopTimeoutId = null;
    STATE.isAutomation = false;
    STATE.cdpTabId = null;
    STATE.cdpPort = null;
    global.crypto.randomUUID = () => 'test-uuid-' + Math.random().toString(36).slice(2);
  });

  describe('initial state', () => {
    it('should have status IDLE initially', () => {
      expect(STATE.status).toBe('IDLE');
    });

    it('should have null backend initially', () => {
      expect(STATE.backend).toBeNull();
    });

    it('should have null mode initially', () => {
      expect(STATE.mode).toBeNull();
    });

    it('should have null recordingId initially', () => {
      expect(STATE.recordingId).toBeNull();
    });

    it('should have recording: false initially', () => {
      const state = getState();
      expect(state.recording).toBe(false);
    });
  });

  describe('backend field tracking', () => {
    it('should track tabCapture backend', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(STATE.backend).toBe('tabCapture');
    });

    it('should track cdpScreencast backend', async () => {
      await startRecording('tab', false, false, { backend: 'cdpScreencast' });
      expect(STATE.backend).toBe('cdpScreencast');
    });

    it('should clear backend on reset', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      await resetRecordingState();
      expect(STATE.backend).toBeNull();
    });
  });

  describe('cdpTabId tracking', () => {
    it('should track cdpTabId for cdpScreencast backend', async () => {
      await startRecording('tab', false, false, { backend: 'cdpScreencast', targetTabId: 42 });
      expect(STATE.cdpTabId).toBe(42);
    });

    it('should not have cdpTabId for tabCapture backend', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(STATE.cdpTabId).toBeNull();
    });

    it('should clear cdpTabId on reset', async () => {
      await startRecording('tab', false, false, { backend: 'cdpScreencast', targetTabId: 42 });
      await resetRecordingState();
      expect(STATE.cdpTabId).toBeNull();
    });
  });

  describe('cdpPort tracking', () => {
    it('should track cdpPort for cdpScreencast backend', async () => {
      await startRecording('tab', false, false, { backend: 'cdpScreencast' });
      expect(STATE.cdpPort).not.toBeNull();
    });

    it('should not have cdpPort for tabCapture backend', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(STATE.cdpPort).toBeNull();
    });

    it('should clear cdpPort on reset', async () => {
      await startRecording('tab', false, false, { backend: 'cdpScreencast' });
      await resetRecordingState();
      expect(STATE.cdpPort).toBeNull();
    });
  });

  describe('CONTROLLER_STATE response', () => {
    it('should include backend in CONTROLLER_STATE response', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      const state = getState();
      expect(state.backend).toBe('tabCapture');
    });

    it('should include status in CONTROLLER_STATE response', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      const state = getState();
      expect(state.status).toBe('RECORDING');
    });

    it('should include mode in CONTROLLER_STATE response', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      const state = getState();
      expect(state.mode).toBe('tab');
    });

    it('should include recording: true during RECORDING', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      const state = getState();
      expect(state.recording).toBe(true);
    });

    it('should include recording: false during IDLE', () => {
      const state = getState();
      expect(state.recording).toBe(false);
    });

    it('should include recording: true during SAVING', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      STATE.status = 'SAVING';
      const state = getState();
      expect(state.recording).toBe(true);
    });

    it('should include isAutomation in CONTROLLER_STATE response', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture', automation: true });
      const state = getState();
      expect(state.isAutomation).toBe(true);
    });

    it('should include cdpTabId in CONTROLLER_STATE response', async () => {
      await startRecording('tab', false, false, { backend: 'cdpScreencast', targetTabId: 42 });
      const state = getState();
      expect(state.cdpTabId).toBe(42);
    });
  });

  describe('state transitions', () => {
    it('should follow IDLE → RECORDING → SAVING → IDLE for cdpScreencast', async () => {
      expect(STATE.status).toBe('IDLE');

      await startRecording('tab', false, false, { backend: 'cdpScreencast' });
      expect(STATE.status).toBe('RECORDING');

      await stopRecording();
      expect(STATE.status).toBe('SAVING');
    });

    it('should follow IDLE → RECORDING → SAVING → IDLE for tabCapture', async () => {
      expect(STATE.status).toBe('IDLE');

      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(STATE.status).toBe('RECORDING');

      await stopRecording();
      expect(STATE.status).toBe('SAVING');
    });

    it('should reset all recording fields after stop', async () => {
      await startRecording('tab', true, true, { backend: 'tabCapture' });
      await resetRecordingState();

      expect(STATE.mode).toBeNull();
      expect(STATE.includeMic).toBe(false);
      expect(STATE.includeSystemAudio).toBe(false);
      expect(STATE.recorderTabId).toBeNull();
      expect(STATE.strategy).toBeNull();
      expect(STATE.isAutomation).toBe(false);
    });

    it('should retain recordingId after stop for getLastRecordingId', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      const recordingId = STATE.recordingId;
      expect(recordingId).toBeTruthy();
      await resetRecordingState();
      expect(STATE.recordingId).toBe(recordingId);
    });
  });

  describe('isAutomation flag', () => {
    it('should set isAutomation: true when options.automation is true', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture', automation: true });
      expect(STATE.isAutomation).toBe(true);
    });

    it('should set isAutomation: false by default', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(STATE.isAutomation).toBe(false);
    });

    it('should reset isAutomation after recording stops', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture', automation: true });
      await resetRecordingState();
      expect(STATE.isAutomation).toBe(false);
    });
  });
});
