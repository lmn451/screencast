// Coverage for WS-B finding #2: a failure while constructing/starting the
// MediaRecorder (e.g. createMediaRecorder throwing "No supported video codec
// found") must stop every acquired capture track before reporting the error,
// so the browser's screen-share indicator clears instead of leaking.
//
// src/entries/offscreen.js is a DOM/chrome-API entry point excluded from
// coverage collection (jest.config.js), but its startCapture() catch path is
// plain, mockable async logic, so this test drives the REAL entry module
// (imported directly) with getDisplayMedia + createMediaRecorder mocked,
// rather than re-implementing the cleanup logic in the test.
//
// Note: src/entries/recorder.js (the page/mic-strategy twin, `recorder.js:
// 229-241` in the remediation plan) has the identical try/catch/stop-tracks
// pattern, but its start() reads recordingId from the page's query string
// (`new URL(location.href)`), which needs a navigated jsdom URL
// (`@jest-environment-options`) to drive past the UUID guard. That's a
// bigger investment for the same code shape already proven here, so it's
// left to e2e coverage; flag this if recorder.js's cleanup path ever
// diverges from offscreen.js's.
import { jest } from '@jest/globals';
import { setupIndexedDB, clearDatabase, teardownIndexedDB } from '../lib/indexeddb-mock.js';

const RECORDING_ID = '550e8400-e29b-41d4-a716-446655440000';

let capturedListener;

function makeTrack() {
  return { stop: jest.fn(), contentHint: '' };
}

beforeEach(async () => {
  jest.resetModules();
  setupIndexedDB();
  await clearDatabase();
  capturedListener = null;
  global.chrome = {
    runtime: {
      id: 'test-ext',
      sendMessage: jest.fn(async () => undefined),
      onMessage: {
        addListener: jest.fn((fn) => {
          capturedListener = fn;
        }),
      },
    },
  };
});

afterEach(() => {
  teardownIndexedDB();
  delete global.chrome;
  try {
    delete global.navigator.mediaDevices;
  } catch (e) {
    // ignore
  }
});

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

it('stops every acquired capture track when createMediaRecorder throws (no supported codec)', async () => {
  const videoTrack = makeTrack();
  const audioTrack = makeTrack();
  const fakeStream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
    id: 'stream-1',
    active: true,
  };

  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: { getDisplayMedia: jest.fn(async () => fakeStream) },
    configurable: true,
  });

  await jest.unstable_mockModule('../../src/lib/media-recorder-utils.js', () => ({
    createMediaRecorder: jest.fn(() => {
      throw new Error(
        'No supported video codec found. Your browser may not support video recording.'
      );
    }),
    applyContentHints: jest.fn(),
    setupAutoStop: jest.fn(),
    CHUNK_INTERVAL_MS: 1000,
  }));

  await import('../../src/entries/offscreen.js');
  await flush(); // let the module's top-level self-test IIFE settle

  expect(typeof capturedListener).toBe('function');

  const sendResponse = jest.fn();
  capturedListener(
    { type: 'OFFSCREEN_START', mode: 'tab', recordingId: RECORDING_ID, includeAudio: false },
    { id: 'test-ext' },
    sendResponse
  );

  await flush();

  // The screen-share indicator only clears when every track acquired via
  // getDisplayMedia is stopped — this is the actual regression finding #2
  // targets (a throw during recorder construction previously left the
  // stream's tracks running).
  expect(videoTrack.stop).toHaveBeenCalled();
  expect(audioTrack.stop).toHaveBeenCalled();

  // The failure must also be reported back (OFFSCREEN_ERROR to background,
  // ok:false to the message sender) rather than silently swallowed.
  expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'OFFSCREEN_ERROR', recordingId: RECORDING_ID })
  );
});
