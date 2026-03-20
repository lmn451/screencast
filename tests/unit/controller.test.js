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

async function hasOffscreenDocument() {
  return await chrome.offscreen.hasDocument?.();
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

  const existing = await hasOffscreenDocument();
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

function getState() {
  return {
    ...STATE,
    recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING',
  };
}

function handleControllerMessage(message) {
  switch (message.type) {
    case 'CONTROLLER_START':
      return startRecording(message.mode, false, false, {
        targetTabId: message.targetTabId || null,
        backend: message.backend || 'tabCapture',
        automation: true,
      });
    case 'CONTROLLER_STOP':
      return stopRecording();
    case 'CONTROLLER_STATE':
      return Promise.resolve(getState());
    default:
      return Promise.resolve({ ok: false, error: 'Unknown message type' });
  }
}

describe('Controller Message API', () => {
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

  describe('CONTROLLER_START', () => {
    it('should start recording with tabCapture backend by default', async () => {
      const result = await handleControllerMessage({ type: 'CONTROLLER_START' });
      expect(result.ok).toBe(true);
      expect(result.backend).toBe('tabCapture');
    });

    it('should start recording with explicit tabCapture backend', async () => {
      const result = await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'tabCapture',
      });
      expect(result.ok).toBe(true);
      expect(result.backend).toBe('tabCapture');
    });

    it('should start recording with cdpScreencast backend', async () => {
      const result = await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'cdpScreencast',
      });
      expect(result.ok).toBe(true);
      expect(result.backend).toBe('cdpScreencast');
    });

    it('should set isAutomation to true for controller start', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START' });
      expect(STATE.isAutomation).toBe(true);
    });

    it('should reject start when already recording', async () => {
      STATE.status = 'RECORDING';
      const result = await handleControllerMessage({ type: 'CONTROLLER_START' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Already recording or saving');
    });

    it('should include backend in response', async () => {
      const result = await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'cdpScreencast',
      });
      expect(result).toHaveProperty('backend', 'cdpScreencast');
    });

    it('should use provided targetTabId', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'tabCapture',
        targetTabId: 999,
      });
      expect(STATE.overlayTabId).toBe(999);
    });

    it('should default to tab mode', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START' });
      expect(STATE.mode).toBe('tab');
    });

    it('should use provided mode', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        mode: 'screen',
      });
      expect(STATE.mode).toBe('screen');
    });
  });

  describe('CONTROLLER_STOP', () => {
    it('should stop recording and return ok: true', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START' });
      const result = await handleControllerMessage({ type: 'CONTROLLER_STOP' });
      expect(result.ok).toBe(true);
    });

    it('should transition status to SAVING', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START' });
      await handleControllerMessage({ type: 'CONTROLLER_STOP' });
      expect(STATE.status).toBe('SAVING');
    });

    it('should reject stop when not recording', async () => {
      const result = await handleControllerMessage({ type: 'CONTROLLER_STOP' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not recording');
    });

    it('should disconnect cdpPort when stopping cdpScreencast', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'cdpScreencast',
      });
      await handleControllerMessage({ type: 'CONTROLLER_STOP' });
      expect(mockPortDisconnect).toHaveBeenCalled();
    });
  });

  describe('CONTROLLER_STATE', () => {
    it('should return current state with backend field', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START', backend: 'tabCapture' });
      const state = await handleControllerMessage({ type: 'CONTROLLER_STATE' });
      expect(state.backend).toBe('tabCapture');
    });

    it('should return recording: true when RECORDING', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START' });
      const state = await handleControllerMessage({ type: 'CONTROLLER_STATE' });
      expect(state.recording).toBe(true);
    });

    it('should return recording: false when IDLE', async () => {
      const state = await handleControllerMessage({ type: 'CONTROLLER_STATE' });
      expect(state.recording).toBe(false);
    });

    it('should return full state object', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'cdpScreencast',
        mode: 'tab',
      });
      const state = await handleControllerMessage({ type: 'CONTROLLER_STATE' });
      expect(state).toMatchObject({
        status: 'RECORDING',
        backend: 'cdpScreencast',
        mode: 'tab',
        recording: true,
        isAutomation: true,
      });
    });
  });

  describe('message routing', () => {
    it('should route CONTROLLER_START to startRecording', async () => {
      const result = await handleControllerMessage({ type: 'CONTROLLER_START' });
      expect(result.ok).toBe(true);
      expect(STATE.status).toBe('RECORDING');
    });

    it('should route CONTROLLER_STOP to stopRecording', async () => {
      await handleControllerMessage({ type: 'CONTROLLER_START' });
      await handleControllerMessage({ type: 'CONTROLLER_STOP' });
      expect(STATE.status).toBe('SAVING');
    });

    it('should route CONTROLLER_STATE to getState', async () => {
      const state = await handleControllerMessage({ type: 'CONTROLLER_STATE' });
      expect(state).toBeDefined();
      expect(state.recording).toBe(false);
    });

    it('should return error for unknown message types', async () => {
      const result = await handleControllerMessage({ type: 'UNKNOWN' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Unknown message type');
    });
  });

  describe('backend-specific behavior', () => {
    it('should set up CDP port for cdpScreencast', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'cdpScreencast',
      });
      expect(mockRuntimeConnect).toHaveBeenCalledWith(undefined, { name: 'cdpScreencast' });
    });

    it('should not set up CDP port for tabCapture', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'tabCapture',
      });
      expect(mockRuntimeConnect).not.toHaveBeenCalled();
    });

    it('should send CDP_START message for cdpScreencast', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'cdpScreencast',
      });
      expect(mockPortPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CDP_START' })
      );
    });

    it('should send OFFSCREEN_START message for tabCapture offscreen', async () => {
      await handleControllerMessage({
        type: 'CONTROLLER_START',
        backend: 'tabCapture',
      });
      expect(mockRuntimeSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'OFFSCREEN_START' })
      );
    });
  });
});

describe('Badge Updates', () => {
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

  it('should set REC badge when recording', async () => {
    await handleControllerMessage({ type: 'CONTROLLER_START' });
    expect(mockActionSetBadgeText).toHaveBeenCalledWith({ text: 'REC' });
    expect(mockActionSetBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#d93025' });
  });

  it('should set SAVE badge when stopping', async () => {
    await handleControllerMessage({ type: 'CONTROLLER_START' });
    mockActionSetBadgeText.mockClear();
    mockActionSetBadgeBackgroundColor.mockClear();

    await handleControllerMessage({ type: 'CONTROLLER_STOP' });
    expect(mockActionSetBadgeText).toHaveBeenCalledWith({ text: 'SAVE' });
    expect(mockActionSetBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#f9ab00' });
  });

  it('should clear badge after reset', async () => {
    await handleControllerMessage({ type: 'CONTROLLER_START' });
    await resetRecordingState();
    const lastTextCall = mockActionSetBadgeText.mock.calls.at(-1);
    expect(lastTextCall).toEqual([{ text: '' }]);
  });
});

describe('SAVING State', () => {
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

  it('should not allow start when in SAVING state', async () => {
    STATE.status = 'SAVING';
    const result = await handleControllerMessage({ type: 'CONTROLLER_START' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Already recording or saving');
  });

  it('should not allow stop when already in SAVING state', async () => {
    STATE.status = 'SAVING';
    const result = await handleControllerMessage({ type: 'CONTROLLER_STOP' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Not recording');
  });

  it('should report recording: true during SAVING', async () => {
    STATE.status = 'SAVING';
    const state = await handleControllerMessage({ type: 'CONTROLLER_STATE' });
    expect(state.recording).toBe(true);
  });
});
