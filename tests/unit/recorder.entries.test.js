import { jest } from '@jest/globals';

let capturedListener;

beforeEach(() => {
  jest.resetModules();
  capturedListener = null;
  global.chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: jest.fn(async () => undefined),
      onMessage: {
        addListener: jest.fn((listener) => {
          capturedListener = listener;
        }),
      },
    },
  };
});

afterEach(() => {
  delete global.chrome;
});

it('rejects recorder commands from an unauthorized sender', async () => {
  await import('../../src/entries/recorder.js');

  const sendResponse = jest.fn();
  const result = capturedListener(
    { type: 'RECORDER_STOP' },
    { id: 'rogue-extension' },
    sendResponse
  );

  expect(result).toBe(false);
  expect(sendResponse).not.toHaveBeenCalled();
});

it('reports a mixed-audio startup failure and releases acquired tracks', async () => {
  const recordingId = '550e8400-e29b-41d4-a716-446655440000';
  const displayVideoTrack = { stop: jest.fn() };
  const displayAudioTrack = { stop: jest.fn() };
  const micAudioTrack = { stop: jest.fn() };
  const displayStream = {
    getVideoTracks: () => [displayVideoTrack],
    getAudioTracks: () => [displayAudioTrack],
    getTracks: () => [displayVideoTrack, displayAudioTrack],
  };
  const micStream = {
    getAudioTracks: () => [micAudioTrack],
    getTracks: () => [micAudioTrack],
  };
  const combinedStream = {
    getTracks: () => [displayVideoTrack],
    getVideoTracks: () => [displayVideoTrack],
  };
  const mixError = new Error('autoplay blocked');
  const cleanupCombinedStream = jest.fn(async () => {});

  document.body.innerHTML = `
    <div id="status"></div>
    <video id="preview"></video>
    <button id="start"></button>
    <button id="stop"></button>
  `;
  window.history.replaceState({}, '', `/recorder.html?id=${recordingId}&mic=1&sys=1&mode=tab`);
  global.alert = jest.fn();
  Object.defineProperty(global.navigator, 'mediaDevices', {
    value: {
      getDisplayMedia: jest.fn(async () => displayStream),
      getUserMedia: jest.fn(async () => micStream),
    },
    configurable: true,
  });

  await jest.unstable_mockModule('../../src/lib/recording.js', () => ({
    finishRecording: jest.fn(),
    createRecordingStub: jest.fn(),
    RECORDING_STATUS: { SAVED: 'saved', FAILED: 'failed', PARTIAL: 'partial' },
  }));
  await jest.unstable_mockModule('../../src/lib/media-recorder-utils.js', () => ({
    createMediaRecorder: jest.fn(),
    applyContentHints: jest.fn(),
    combineStreams: jest.fn(() => combinedStream),
    waitForCombinedStreamReady: jest.fn(() => Promise.reject(mixError)),
    cleanupCombinedStream,
    setupAutoStop: jest.fn(),
    getDisplayVideoConstraints: jest.fn(() => true),
    CHUNK_INTERVAL_MS: 1000,
    BEST_QUALITY_VIDEO_BITS_PER_SECOND: 25_000_000,
  }));

  await import('../../src/entries/recorder.js');
  window.dispatchEvent(new Event('DOMContentLoaded'));
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(cleanupCombinedStream).toHaveBeenCalledWith(combinedStream);
  expect(displayVideoTrack.stop).toHaveBeenCalled();
  expect(displayAudioTrack.stop).toHaveBeenCalled();
  expect(micAudioTrack.stop).toHaveBeenCalled();
  expect(global.chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'RECORDER_ERROR', recordingId })
  );
});
