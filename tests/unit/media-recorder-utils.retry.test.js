// AC1 (finding #1) coverage: media-recorder-utils.js's internal
// saveChunkWithRetry must retry a rejecting saveChunk (e.g. a commit-time
// QuotaExceededError, per chunkStorage.extra.test.js) up to MAX_CHUNK_SAVE_RETRIES
// times before giving up, and only then count the chunk as failed. This
// verifies createMediaRecorder awaits the corrected (commit-durable) saveChunk
// promise rather than firing-and-forgetting it.
import { jest } from '@jest/globals';

describe('createMediaRecorder chunk save retry (AC1)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function installFakeMediaRecorder() {
    globalThis.MediaRecorder = class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'video/webm';
        this.ondataavailable = null;
        this.onstop = null;
        this.onerror = null;
      }
    };
  }

  it('retries a rejecting saveChunk and eventually succeeds without counting a failed chunk', async () => {
    let attempts = 0;
    const saveChunk = jest.fn(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(new Error('QuotaExceededError'));
      }
      return Promise.resolve();
    });

    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({ saveChunk }));
    installFakeMediaRecorder();

    const { createMediaRecorder } = await import('../../src/lib/media-recorder-utils.js');
    const onStop = jest.fn(async () => undefined);
    const { recorder, getStats } = createMediaRecorder({}, 'retry-rec', { onStop });

    // ondataavailable awaits the full retry loop (including the
    // CHUNK_SAVE_RETRY_DELAY_MS backoff between attempts), so await it directly
    // instead of manually flushing timers.
    await recorder.ondataavailable({ data: { size: 42 } });

    expect(saveChunk).toHaveBeenCalledTimes(3);
    expect(saveChunk).toHaveBeenNthCalledWith(1, 'retry-rec', { size: 42 }, 0);
    expect(getStats().failedChunks).toBe(0);

    await recorder.onstop();
    expect(onStop).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 42, {
      failedChunks: 0,
    });
  });

  it('counts the chunk as failed only after all retries are exhausted', async () => {
    const saveChunk = jest.fn(() => Promise.reject(new Error('QuotaExceededError')));

    await jest.unstable_mockModule('../../src/lib/chunkStorage.js', () => ({ saveChunk }));
    installFakeMediaRecorder();

    const { createMediaRecorder } = await import('../../src/lib/media-recorder-utils.js');
    const onStop = jest.fn(async () => undefined);
    const { recorder, getStats, getFailedChunkCount } = createMediaRecorder({}, 'fail-rec', {
      onStop,
    });

    await recorder.ondataavailable({ data: { size: 10 } });

    // MAX_CHUNK_SAVE_RETRIES = 3 (media-recorder-utils.js) — every attempt
    // rejects, so the chunk is counted as permanently failed exactly once.
    expect(saveChunk).toHaveBeenCalledTimes(3);
    expect(getFailedChunkCount()).toBe(1);
    expect(getStats().failedChunks).toBe(1);

    await recorder.onstop();
    expect(onStop).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 10, {
      failedChunks: 1,
    });
  });
});
