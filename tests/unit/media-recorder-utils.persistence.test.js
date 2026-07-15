import { jest } from '@jest/globals';

describe('createMediaRecorder chunk persistence', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('reserves chunk indexes synchronously and waits for pending saves before stop', async () => {
    const pendingSaves = [];
    const saveChunk = jest.fn(
      () =>
        new Promise((resolve) => {
          pendingSaves.push(resolve);
        })
    );

    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({
      saveChunk,
    }));

    globalThis.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'video/webm';
        this.ondataavailable = null;
        this.onstop = null;
      }
    };

    const { createMediaRecorder } = await import('../../src/lib/media-recorder-utils.js');
    const onStop = jest.fn(async () => undefined);
    const { recorder } = createMediaRecorder({}, 'recording-id', { onStop });

    const firstData = { size: 10 };
    const secondData = { size: 20 };
    const firstDataPromise = recorder.ondataavailable({ data: firstData });
    const secondDataPromise = recorder.ondataavailable({ data: secondData });

    expect(saveChunk).toHaveBeenNthCalledWith(1, 'recording-id', firstData, 0);
    expect(saveChunk).toHaveBeenNthCalledWith(2, 'recording-id', secondData, 1);

    const stopPromise = recorder.onstop();
    await Promise.resolve();
    expect(onStop).not.toHaveBeenCalled();

    pendingSaves.forEach((resolve) => resolve());
    await Promise.all([firstDataPromise, secondDataPromise, stopPromise]);

    expect(onStop).toHaveBeenCalledWith(
      expect.stringContaining('video/webm'),
      expect.any(Number),
      30,
      { failedChunks: 0 }
    );
  });

  it('retries a rejecting saveChunk and succeeds without counting a failed chunk', async () => {
    // saveChunk rejects on the first two attempts, then commits on the third.
    // saveChunkWithRetry (MAX_CHUNK_SAVE_RETRIES = 3) should keep the chunk.
    let attempts = 0;
    const saveChunk = jest.fn(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error('commit aborted (quota)'));
      }
      return Promise.resolve();
    });

    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({
      saveChunk,
    }));

    globalThis.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'video/webm';
        this.ondataavailable = null;
        this.onstop = null;
      }
    };

    const { createMediaRecorder } = await import('../../src/lib/media-recorder-utils.js');
    const onStop = jest.fn(async () => undefined);
    const { recorder, getFailedChunkCount } = createMediaRecorder({}, 'recording-id', { onStop });

    await recorder.ondataavailable({ data: { size: 10 } });

    // Same chunk index retried 3 times (2 rejects + 1 success).
    expect(saveChunk).toHaveBeenCalledTimes(3);
    expect(saveChunk).toHaveBeenNthCalledWith(1, 'recording-id', { size: 10 }, 0);
    expect(saveChunk).toHaveBeenNthCalledWith(3, 'recording-id', { size: 10 }, 0);
    expect(getFailedChunkCount()).toBe(0);

    await recorder.onstop();
    expect(onStop).toHaveBeenCalledWith(
      expect.stringContaining('video/webm'),
      expect.any(Number),
      10,
      { failedChunks: 0 }
    );
  });
});
