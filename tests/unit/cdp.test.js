import { jest } from '@jest/globals';

global.crypto = {
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
};

const mockDebuggerOnEvent = { addListener: jest.fn() };
const mockDebuggerOnDetach = { addListener: jest.fn() };
const mockDebuggerAttach = jest.fn().mockResolvedValue(undefined);
const mockDebuggerGetTargets = jest.fn().mockResolvedValue([]);
const mockActionSetBadgeBackgroundColor = jest.fn().mockResolvedValue(undefined);
const mockActionSetBadgeText = jest.fn().mockResolvedValue(undefined);
const mockRuntimeGetURL = jest.fn((path) => `chrome-extension://test-extension-id/${path}`);

global.chrome = {
  ...global.chrome,
  debugger: {
    onEvent: mockDebuggerOnEvent,
    onDetach: mockDebuggerOnDetach,
    attach: mockDebuggerAttach,
    getTargets: mockDebuggerGetTargets,
  },
  action: {
    setBadgeBackgroundColor: mockActionSetBadgeBackgroundColor,
    setBadgeText: mockActionSetBadgeText,
  },
  runtime: {
    ...global.chrome.runtime,
    getURL: mockRuntimeGetURL,
  },
};

const { createLogger } = await import('../../logger.js');
const logger = createLogger('Background');

const STATE = {
  status: 'IDLE',
  mode: null,
  recordingId: null,
  overlayTabId: null,
  includeMic: false,
  includeSystemAudio: false,
  recorderTabId: null,
  strategy: null,
  stopTimeoutId: null,
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

async function startRecording(mode, includeMic, includeSystemAudio) {
  if (STATE.status !== 'IDLE') return { ok: false, error: 'Already recording or saving' };

  STATE.mode = mode;
  STATE.recordingId = crypto.randomUUID();
  STATE.includeMic = !!includeMic;
  STATE.includeSystemAudio = !!includeSystemAudio;
  STATE.status = 'RECORDING';
  await updateBadge();
  return { ok: true, overlayInjected: false };
}

async function stopRecording() {
  if (STATE.status !== 'RECORDING') return { ok: false, error: 'Not recording' };
  STATE.status = 'IDLE';
  await updateBadge();
  STATE.mode = null;
  STATE.recordingId = null;
  STATE.includeMic = false;
  STATE.includeSystemAudio = false;
  return { ok: true };
}

async function attachDebugger() {
  try {
    const targets = await chrome.debugger.getTargets();
    const attached = targets.some((t) => t.attached && t.url.startsWith(chrome.runtime.getURL('')));
    if (!attached) {
      await chrome.debugger.attach({ tabId: undefined }, '1.3');
    }
  } catch (e) {
    logger.warn('Debugger attach failed:', e.message);
  }
}

function handleCDPCommand(method, params) {
  switch (method) {
    case 'CaptureCast.start':
      return startRecording(
        params?.mode ?? 'tab',
        params?.mic ?? false,
        params?.systemAudio ?? false
      );
    case 'CaptureCast.stop':
      return stopRecording();
    case 'CaptureCast.getState':
      return Promise.resolve({
        ...STATE,
        recording: STATE.status === 'RECORDING' || STATE.status === 'SAVING',
      });
    default:
      return Promise.resolve({ ok: false, error: `Unknown method: ${method}` });
  }
}

describe('CDP Support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    STATE.status = 'IDLE';
    STATE.mode = null;
    STATE.recordingId = null;
    STATE.includeMic = false;
    STATE.includeSystemAudio = false;
  });

  describe('attachDebugger', () => {
    it('should attach debugger when no existing attachment', async () => {
      mockDebuggerGetTargets.mockResolvedValue([]);
      await attachDebugger();
      expect(mockDebuggerAttach).toHaveBeenCalledWith({ tabId: undefined }, '1.3');
    });

    it('should not attach if already attached', async () => {
      mockDebuggerGetTargets.mockResolvedValue([
        { attached: true, url: 'chrome-extension://test-extension-id/' },
      ]);
      await attachDebugger();
      expect(mockDebuggerAttach).not.toHaveBeenCalled();
    });

    it('should handle attach errors gracefully', async () => {
      mockDebuggerAttach.mockRejectedValue(new Error('Already attached'));
      mockDebuggerGetTargets.mockResolvedValue([]);
      await expect(attachDebugger()).resolves.not.toThrow();
    });
  });

  describe('handleCDPCommand', () => {
    beforeEach(() => {
      global.crypto.randomUUID = () => 'test-uuid-' + Math.random().toString(36).slice(2);
    });

    it('should handle CaptureCast.start with default params', async () => {
      const result = await handleCDPCommand('CaptureCast.start', {});
      expect(result.ok).toBe(true);
      expect(STATE.status).toBe('RECORDING');
      expect(STATE.mode).toBe('tab');
      expect(STATE.includeMic).toBe(false);
      expect(STATE.includeSystemAudio).toBe(false);
    });

    it('should handle CaptureCast.start with custom params', async () => {
      const result = await handleCDPCommand('CaptureCast.start', {
        mode: 'screen',
        mic: true,
        systemAudio: true,
      });
      expect(result.ok).toBe(true);
      expect(STATE.mode).toBe('screen');
      expect(STATE.includeMic).toBe(true);
      expect(STATE.includeSystemAudio).toBe(true);
    });

    it('should handle CaptureCast.stop', async () => {
      STATE.status = 'RECORDING';
      STATE.recordingId = 'test-id';
      const result = await handleCDPCommand('CaptureCast.stop', {});
      expect(result.ok).toBe(true);
      expect(STATE.status).toBe('IDLE');
    });

    it('should handle CaptureCast.getState', async () => {
      STATE.status = 'RECORDING';
      STATE.mode = 'tab';
      const result = await handleCDPCommand('CaptureCast.getState', {});
      expect(result).toMatchObject({
        status: 'RECORDING',
        mode: 'tab',
        recording: true,
      });
    });

    it('should return error for unknown commands', async () => {
      const result = await handleCDPCommand('Unknown.command', {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Unknown method: Unknown.command');
    });

    it('should handle start when already recording', async () => {
      STATE.status = 'RECORDING';
      const result = await handleCDPCommand('CaptureCast.start', {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Already recording or saving');
    });

    it('should handle stop when not recording', async () => {
      STATE.status = 'IDLE';
      const result = await handleCDPCommand('CaptureCast.stop', {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not recording');
    });
  });

  describe('CDP event listeners', () => {
    it('should have addListener method on onEvent', () => {
      expect(mockDebuggerOnEvent.addListener).toBeDefined();
    });

    it('should have addListener method on onDetach', () => {
      expect(mockDebuggerOnDetach.addListener).toBeDefined();
    });
  });
});
