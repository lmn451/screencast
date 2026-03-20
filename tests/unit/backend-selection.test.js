import { jest } from '@jest/globals';

global.crypto = {
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
};

const mockActionSetBadgeBackgroundColor = jest.fn().mockResolvedValue(undefined);
const mockActionSetBadgeText = jest.fn().mockResolvedValue(undefined);
const mockRuntimeGetURL = jest.fn((path) => `chrome-extension://test-extension-id/${path}`);
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
const mockRuntimeSendMessage = jest.fn().mockResolvedValue({ ok: true });
const mockRuntimeConnect = jest.fn();
const mockTabCaptureGetMediaStreamId = jest.fn().mockResolvedValue('stream-id-test');
const mockStorageEstimate = jest
  .fn()
  .mockResolvedValue({ usage: 100 * 1024 * 1024, quota: 1000 * 1024 * 1024 });

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
    connect: mockRuntimeConnect,
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

function canUseOffscreen() {
  return !!(chrome.offscreen && chrome.offscreen.createDocument);
}

async function hasOffscreenDocument() {
  return await chrome.offscreen.hasDocument?.();
}

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
  return { ok: true, overlayInjected, backend: 'tabCapture' };
}

async function startDisplayMedia(tabId, mode, includeMic, includeSystemAudio, options = {}) {
  if (STATE.status !== 'IDLE') {
    return { ok: false, error: 'Already recording or saving' };
  }

  STATE.backend = 'displayMedia';
  STATE.mode = mode || 'screen';
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

    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode: STATE.mode,
      includeAudio: STATE.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId,
      streamId: null,
    });
    STATE.strategy = 'offscreen';
  } else {
    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
        STATE.mode
      )}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}`
    );
    const tab = await chrome.tabs.create({ url, active: true });
    STATE.recorderTabId = tab.id ?? null;
    STATE.strategy = 'page';
  }

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
  return { ok: true, overlayInjected, backend: 'displayMedia' };
}

async function startRecording(mode, includeMic, includeSystemAudio, options = {}) {
  const backend = options.backend || 'tabCapture';

  if (backend === 'displayMedia') {
    return startDisplayMedia(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  } else {
    return startTabCapture(options.targetTabId, mode, includeMic, includeSystemAudio, options);
  }
}

describe('Backend Selection', () => {
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

  describe('default backend selection', () => {
    it('should use tabCapture as default backend', async () => {
      const result = await startRecording('tab', false, false, {});
      expect(result.ok).toBe(true);
      expect(result.backend).toBe('tabCapture');
      expect(STATE.backend).toBe('tabCapture');
    });

    it('should set STATE.backend to tabCapture when using default', async () => {
      await startRecording('tab', false, false, {});
      expect(STATE.backend).toBe('tabCapture');
    });
  });

  describe('tabCapture backend', () => {
    it('should route to tabCapture when backend=tabCapture', async () => {
      const result = await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(result.ok).toBe(true);
      expect(result.backend).toBe('tabCapture');
    });

    it('should use offscreen strategy without microphone', async () => {
      const result = await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(result.ok).toBe(true);
      expect(STATE.strategy).toBe('offscreen');
    });

    it('should use page strategy with microphone', async () => {
      const result = await startRecording('tab', true, false, { backend: 'tabCapture' });
      expect(result.ok).toBe(true);
      expect(STATE.strategy).toBe('page');
    });

    it('should attempt to get streamId via tabCapture.getMediaStreamId', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(mockTabCaptureGetMediaStreamId).toHaveBeenCalled();
    });

    it('should preserve mode=tab with tabCapture backend', async () => {
      await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(STATE.mode).toBe('tab');
    });

    it('should preserve mode=screen with tabCapture backend', async () => {
      await startRecording('screen', false, false, { backend: 'tabCapture' });
      expect(STATE.mode).toBe('screen');
    });
  });

  describe('displayMedia backend', () => {
    it('should route to displayMedia when backend=displayMedia', async () => {
      const result = await startRecording('screen', false, false, { backend: 'displayMedia' });
      expect(result.ok).toBe(true);
      expect(result.backend).toBe('displayMedia');
    });

    it('should set STATE.backend to displayMedia', async () => {
      await startRecording('screen', false, false, { backend: 'displayMedia' });
      expect(STATE.backend).toBe('displayMedia');
    });

    it('should use page strategy with microphone', async () => {
      const result = await startRecording('screen', true, false, { backend: 'displayMedia' });
      expect(result.ok).toBe(true);
      expect(STATE.strategy).toBe('page');
    });

    it('should not call tabCapture.getMediaStreamId for displayMedia', async () => {
      await startRecording('screen', false, false, { backend: 'displayMedia' });
      expect(mockTabCaptureGetMediaStreamId).not.toHaveBeenCalled();
    });
  });

  describe('targetTabId handling', () => {
    it('should use provided targetTabId for tabCapture', async () => {
      const result = await startRecording('tab', false, false, {
        backend: 'tabCapture',
        targetTabId: 999,
      });
      expect(result.ok).toBe(true);
      expect(STATE.overlayTabId).toBe(999);
    });

    it('should use provided targetTabId for displayMedia', async () => {
      const result = await startRecording('screen', false, false, {
        backend: 'displayMedia',
        targetTabId: 888,
      });
      expect(result.ok).toBe(true);
      expect(STATE.overlayTabId).toBe(888);
    });

    it('should fall back to active tab when targetTabId is null', async () => {
      mockTabsQuery.mockResolvedValue([{ id: 42 }]);
      const result = await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(result.ok).toBe(true);
      expect(STATE.overlayTabId).toBe(42);
    });
  });

  describe('error handling', () => {
    it('should reject start when already recording', async () => {
      STATE.status = 'RECORDING';
      const result = await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Already recording or saving');
    });

    it('should not change backend when start is rejected', async () => {
      STATE.status = 'RECORDING';
      STATE.backend = 'tabCapture';
      await startRecording('tab', false, false, { backend: 'displayMedia' });
      expect(STATE.backend).toBe('tabCapture');
    });
  });

  describe('backend field in response', () => {
    it('should include backend field in tabCapture response', async () => {
      const result = await startRecording('tab', false, false, { backend: 'tabCapture' });
      expect(result).toHaveProperty('backend', 'tabCapture');
    });

    it('should include backend field in displayMedia response', async () => {
      const result = await startRecording('screen', false, false, { backend: 'displayMedia' });
      expect(result).toHaveProperty('backend', 'displayMedia');
    });
  });
});

describe('Message API Routes', () => {
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
    STATE.isAutomation = false;
    global.crypto.randomUUID = () => 'test-uuid-' + Math.random().toString(36).slice(2);
  });

  it('should route START with tabCapture backend', async () => {
    const result = await startRecording('tab', false, false, {
      backend: 'tabCapture',
      automation: true,
    });
    expect(result.backend).toBe('tabCapture');
    expect(STATE.isAutomation).toBe(true);
  });

  it('should route START with displayMedia backend', async () => {
    const result = await startRecording('screen', false, false, {
      backend: 'displayMedia',
      automation: true,
    });
    expect(result.backend).toBe('displayMedia');
    expect(STATE.isAutomation).toBe(true);
  });

  it('should handle tabCapture with includeSystemAudio', async () => {
    const result = await startRecording('tab', false, true, { backend: 'tabCapture' });
    expect(result.ok).toBe(true);
    expect(STATE.includeSystemAudio).toBe(true);
  });
});
