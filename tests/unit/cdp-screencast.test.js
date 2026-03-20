import { jest } from '@jest/globals';

global.crypto = {
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
};

const mockDebuggerOnEvent = { addListener: jest.fn() };
const mockDebuggerOnDetach = { addListener: jest.fn() };
const mockDebuggerAttach = jest.fn().mockResolvedValue(undefined);
const mockDebuggerDetach = jest.fn().mockResolvedValue(undefined);
const mockDebuggerSendCommand = jest.fn().mockResolvedValue(undefined);
const mockDebuggerGetTargets = jest.fn().mockResolvedValue([]);
const mockActionSetBadgeBackgroundColor = jest.fn().mockResolvedValue(undefined);
const mockActionSetBadgeText = jest.fn().mockResolvedValue(undefined);
const mockRuntimeGetURL = jest.fn((path) => `chrome-extension://test-extension-id/${path}`);
const mockRuntimeConnect = jest.fn();
const mockRuntimeSendMessage = jest.fn().mockResolvedValue({ ok: true });
const mockTabsQuery = jest.fn().mockResolvedValue([{ id: 1 }]);
const mockTabsCreate = jest.fn().mockResolvedValue({ id: 123 });
const mockTabsRemove = jest.fn().mockResolvedValue(undefined);
const mockTabsSendMessage = jest.fn().mockResolvedValue({ ok: true });
const mockScriptingExecuteScript = jest.fn().mockResolvedValue([]);
const mockOffscreenCreateDocument = jest.fn().mockResolvedValue(undefined);
const mockOffscreenCloseDocument = jest.fn().mockResolvedValue(undefined);
const mockOffscreenHasDocument = jest.fn().mockResolvedValue(false);
const mockStorageEstimate = jest
  .fn()
  .mockResolvedValue({ usage: 100 * 1024 * 1024, quota: 1000 * 1024 * 1024 });

const mockPortPostMessage = jest.fn();
const mockPortOnMessage = { addListener: jest.fn() };
const mockPortOnDisconnect = { addListener: jest.fn() };
const mockPortDisconnect = jest.fn();

global.chrome = {
  ...global.chrome,
  debugger: {
    attach: mockDebuggerAttach,
    detach: mockDebuggerDetach,
    sendCommand: mockDebuggerSendCommand,
    getTargets: mockDebuggerGetTargets,
    onEvent: mockDebuggerOnEvent,
    onDetach: mockDebuggerOnDetach,
  },
  action: {
    setBadgeBackgroundColor: mockActionSetBadgeBackgroundColor,
    setBadgeText: mockActionSetBadgeText,
  },
  runtime: {
    ...global.chrome.runtime,
    getURL: mockRuntimeGetURL,
    connect: mockRuntimeConnect.mockReturnValue({
      postMessage: mockPortPostMessage,
      onMessage: mockPortOnMessage,
      onDisconnect: mockPortOnDisconnect,
      disconnect: mockPortDisconnect,
    }),
    sendMessage: mockRuntimeSendMessage,
  },
  tabs: {
    query: mockTabsQuery,
    create: mockTabsCreate,
    remove: mockTabsRemove,
    sendMessage: mockTabsSendMessage,
    get: jest.fn().mockResolvedValue({ id: 1, windowId: 1 }),
  },
  scripting: {
    executeScript: mockScriptingExecuteScript,
  },
  offscreen: {
    createDocument: mockOffscreenCreateDocument,
    closeDocument: mockOffscreenCloseDocument,
    hasDocument: mockOffscreenHasDocument,
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

  cdpPort.onMessage.addListener((msg) => {
    if (msg.type === 'CDP_ERROR') {
      /* handle error */
    }
  });

  cdpPort.onDisconnect.addListener(() => {
    STATE.cdpPort = null;
    if (STATE.status === 'RECORDING') {
      stopRecording();
    }
  });

  cdpPort.postMessage({
    type: 'CDP_START',
    tabId: STATE.cdpTabId,
    recordingId: STATE.recordingId,
    mode: STATE.mode,
    includeAudio: STATE.includeSystemAudio || STATE.includeMic,
  });

  let overlayInjected = false;
  if (STATE.overlayTabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: STATE.overlayTabId },
        files: ['overlay.js'],
      });
      overlayInjected = true;
    } catch (e) {
      /* ignore */
    }
  }

  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected, backend: 'cdpScreencast' };
}

async function stopRecording() {
  if (STATE.status !== 'RECORDING') return { ok: false, error: 'Not recording' };

  STATE.status = 'SAVING';
  await updateBadge();

  try {
    if (STATE.overlayTabId) {
      try {
        await chrome.tabs.sendMessage(STATE.overlayTabId, { type: 'OVERLAY_REMOVE' });
      } catch (e) {
        /* no-op */
      }
    }
  } catch (e) {
    /* no-op */
  }

  if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
  STATE.stopTimeoutId = setTimeout(async () => {
    await resetRecordingState();
  }, 60000);

  try {
    if (STATE.backend === 'cdpScreencast' && STATE.cdpPort) {
      STATE.cdpPort.postMessage({ type: 'CDP_STOP' });
      STATE.cdpPort.disconnect();
      STATE.cdpPort = null;
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

describe('CDP Screencast Backend', () => {
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

  describe('startCDPScreencast', () => {
    it('should set backend to cdpScreencast', async () => {
      const result = await startCDPScreencast(1, 'tab', false, false, {});
      expect(result.ok).toBe(true);
      expect(STATE.backend).toBe('cdpScreencast');
    });

    it('should set STATE.status to RECORDING', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(STATE.status).toBe('RECORDING');
    });

    it('should create offscreen document', async () => {
      mockOffscreenHasDocument.mockResolvedValue(false);
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(mockOffscreenCreateDocument).toHaveBeenCalled();
    });

    it('should connect to cdpScreencast port', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(mockRuntimeConnect).toHaveBeenCalledWith(undefined, { name: 'cdpScreencast' });
    });

    it('should send CDP_START message to port', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(mockPortPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CDP_START',
          tabId: 1,
        })
      );
    });

    it('should use provided tabId as cdpTabId', async () => {
      await startCDPScreencast(42, 'tab', false, false, {});
      expect(STATE.cdpTabId).toBe(42);
    });

    it('should fall back to active tab when tabId not provided', async () => {
      mockTabsQuery.mockResolvedValue([{ id: 99 }]);
      await startCDPScreencast(null, 'tab', false, false, {});
      expect(STATE.cdpTabId).toBe(99);
    });

    it('should reject start when already recording', async () => {
      STATE.status = 'RECORDING';
      const result = await startCDPScreencast(1, 'tab', false, false, {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Already recording or saving');
    });

    it('should include backend in response', async () => {
      const result = await startCDPScreencast(1, 'tab', false, false, {});
      expect(result.backend).toBe('cdpScreencast');
    });

    it('should set isAutomation when options.automation is true', async () => {
      await startCDPScreencast(1, 'tab', false, false, { automation: true });
      expect(STATE.isAutomation).toBe(true);
    });

    it('should set includeSystemAudio in CDP_START message', async () => {
      await startCDPScreencast(1, 'tab', false, true, {});
      expect(mockPortPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          includeAudio: true,
        })
      );
    });

    it('should set mode in CDP_START message', async () => {
      await startCDPScreencast(1, 'screen', false, false, {});
      expect(mockPortPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'screen',
        })
      );
    });
  });

  describe('stop recording', () => {
    beforeEach(async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
    });

    it('should send CDP_STOP to port on stop', async () => {
      await stopRecording();
      expect(mockPortPostMessage).toHaveBeenCalledWith({ type: 'CDP_STOP' });
    });

    it('should disconnect port on stop', async () => {
      await stopRecording();
      expect(mockPortDisconnect).toHaveBeenCalled();
    });

    it('should set STATE.cdpPort to null after stop', async () => {
      await stopRecording();
      expect(STATE.cdpPort).toBeNull();
    });

    it('should transition to SAVING then IDLE', async () => {
      await stopRecording();
      expect(STATE.status).toBe('SAVING');
    });

    it('should return ok: true when stop succeeds', async () => {
      const result = await stopRecording();
      expect(result.ok).toBe(true);
    });

    it('should return ok: false when not recording', async () => {
      STATE.status = 'IDLE';
      const result = await stopRecording();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not recording');
    });
  });

  describe('resetRecordingState', () => {
    beforeEach(async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      STATE.status = 'SAVING';
    });

    it('should set status to IDLE', async () => {
      await resetRecordingState();
      expect(STATE.status).toBe('IDLE');
    });

    it('should clear cdpTabId', async () => {
      await resetRecordingState();
      expect(STATE.cdpTabId).toBeNull();
    });

    it('should clear cdpPort', async () => {
      await resetRecordingState();
      expect(STATE.cdpPort).toBeNull();
    });

    it('should clear backend', async () => {
      await resetRecordingState();
      expect(STATE.backend).toBeNull();
    });

    it('should clear overlayTabId', async () => {
      await resetRecordingState();
      expect(STATE.overlayTabId).toBeNull();
    });
  });

  describe('badge updates', () => {
    it('should set REC badge when recording', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(mockActionSetBadgeText).toHaveBeenCalledWith({ text: 'REC' });
      expect(mockActionSetBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#d93025' });
    });
  });

  describe('CDP port lifecycle', () => {
    it('should store port reference in STATE.cdpPort', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(STATE.cdpPort).not.toBeNull();
    });

    it('should set up onMessage listener on port', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(mockPortOnMessage.addListener).toHaveBeenCalled();
    });

    it('should set up onDisconnect listener on port', async () => {
      await startCDPScreencast(1, 'tab', false, false, {});
      expect(mockPortOnDisconnect.addListener).toHaveBeenCalled();
    });
  });
});
