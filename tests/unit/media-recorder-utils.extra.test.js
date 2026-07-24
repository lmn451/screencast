import { jest } from '@jest/globals';

describe('media-recorder-utils (additional)', () => {
  // Note: These tests have async timing issues with Jest's ESM mocking.
  // They are skipped to allow the test suite to pass.
  // The core MediaRecorder functionality is tested in media-recorder-utils.test.js

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('createMediaRecorder: records chunks and calls callbacks', async () => {
    const saveChunkMock = jest.fn(() => Promise.resolve());

    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({
      saveChunk: saveChunkMock,
    }));

    // Fake MediaRecorder that simulates dataavailable/start/stop
    class FakeMediaRecorder {
      static isTypeSupported(type) {
        return type === 'video/webm;codecs=vp9,opus';
      }
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'video/webm';
        this.videoBitsPerSecond = options.videoBitsPerSecond;
        this.state = 'inactive';
        this.onstart = null;
        this.ondataavailable = null;
        this.onerror = null;
        this.onstop = null;
      }
      start() {
        this.state = 'recording';
        this.onstart?.();
      }
      requestData() {
        // simulate a chunk available
        if (this.ondataavailable) {
          this.ondataavailable({ data: { size: 256 } });
        }
      }
      stop() {
        if (this.state !== 'inactive') {
          this.state = 'inactive';
          return this.onstop?.();
        }
      }
    }

    global.MediaRecorder = FakeMediaRecorder;

    const mod = await import('../../src/lib/media-recorder-utils.js');
    const { createMediaRecorder, BEST_QUALITY_VIDEO_BITS_PER_SECOND } = mod;

    const stream = {}; // not inspected by our fake
    const onStart = jest.fn();
    const onStop = jest.fn(() => Promise.resolve());
    const onError = jest.fn();

    const { recorder, getStats } = createMediaRecorder(
      stream,
      'r1',
      { onStart, onStop, onError },
      { videoBitsPerSecond: BEST_QUALITY_VIDEO_BITS_PER_SECOND }
    );

    recorder.start();
    // request a chunk (triggers ondataavailable -> saveChunk)
    recorder.requestData();

    // wait a tick for async saveChunk
    await Promise.resolve();

    await recorder.stop();

    expect(onStart).toHaveBeenCalled();
    expect(saveChunkMock).toHaveBeenCalledWith('r1', expect.objectContaining({ size: 256 }), 0);
    expect(onStop).toHaveBeenCalled();
    expect(recorder.videoBitsPerSecond).toBe(BEST_QUALITY_VIDEO_BITS_PER_SECOND);

    const stats = getStats();
    expect(stats.chunkIndex).toBeGreaterThanOrEqual(1);
    expect(stats.totalSize).toBeGreaterThanOrEqual(256);
  });

  it('createMediaRecorder: continues when saveChunk fails', async () => {
    const saveChunkMock = jest.fn(() => Promise.reject(new Error('DB fail')));

    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({
      saveChunk: saveChunkMock,
    }));

    class FakeMediaRecorder2 {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        this.state = 'inactive';
        this.onstart = null;
        this.ondataavailable = null;
        this.onstop = null;
      }
      start() {
        this.state = 'recording';
        this.onstart?.();
      }
      requestData() {
        this.ondataavailable?.({ data: { size: 10 } });
      }
      stop() {
        this.state = 'inactive';
        return this.onstop?.();
      }
    }

    global.MediaRecorder = FakeMediaRecorder2;

    const mod = await import('../../src/lib/media-recorder-utils.js');
    const { createMediaRecorder } = mod;

    const onStop = jest.fn(() => Promise.resolve());
    const { recorder } = createMediaRecorder({}, 'r2', { onStop });

    recorder.start();
    recorder.requestData();

    await recorder.stop();

    expect(onStop).toHaveBeenCalled();
    expect(saveChunkMock).toHaveBeenCalled();
  });

  it('createMediaRecorder: throws when no codec supported', async () => {
    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({
      saveChunk: jest.fn(),
    }));

    class NoCodecRecorder {
      static isTypeSupported() {
        return false;
      }
    }

    global.MediaRecorder = NoCodecRecorder;

    const mod = await import('../../src/lib/media-recorder-utils.js');
    const { createMediaRecorder } = mod;

    expect(() => createMediaRecorder({}, 'x')).toThrow('No supported video codec');
  });
});
