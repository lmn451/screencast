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
});
