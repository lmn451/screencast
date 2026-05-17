// Shared MediaRecorder utilities to reduce code duplication

import { saveChunk } from './chunkStorage.js';
import { createLogger } from '../logger.js';
import { createError, CODES } from '../error-codes.js';

const logger = createLogger('MediaRecorderUtils');

// Constants for recorder configuration
export const CHUNK_INTERVAL_MS = 1000; // 1 second chunks for balance of memory/recovery

// Retry configuration for chunk saves
const MAX_CHUNK_SAVE_RETRIES = 3;
const CHUNK_SAVE_RETRY_DELAY_MS = 100;

/**
 * Get the best supported video codec from a prioritized list
 * Priority: AV1 (best compression) → VP9 → VP8 (best compatibility) → generic webm
 * @returns {string} MIME type of the best supported codec
 */
export function getOptimalCodec() {
  const codecs = [
    'video/webm;codecs=av01,opus',
    'video/webm;codecs=av1,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  for (const codec of codecs) {
    if (MediaRecorder.isTypeSupported(codec)) {
      logger.log('Selected codec:', codec);
      return codec;
    }
  }

  throw new Error('No supported video codec found. Your browser may not support video recording.');
}

/**
 * Apply content hints to media tracks for encoder optimization
 * @param {MediaStream} stream - The media stream to optimize
 * @param {Object} options - Configuration options
 * @param {boolean} options.hasSystemAudio - Whether system audio is included
 * @param {boolean} options.hasMicrophone - Whether microphone is included
 */
export function applyContentHints(stream, { hasSystemAudio = false, hasMicrophone = false } = {}) {
  try {
    // Video track: optimize for screen/text detail
    const videoTrack = stream.getVideoTracks?.()?.[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'detail';
    }

    // System audio: optimize for music (high fidelity)
    if (hasSystemAudio) {
      const audioTracks = stream.getAudioTracks?.() || [];
      for (const track of audioTracks) {
        if ('contentHint' in track) {
          track.contentHint = 'music';
        }
      }
    }

    // Microphone: optimize for speech (separate stream)
    if (hasMicrophone) {
      const micTracks = stream.getAudioTracks?.() || [];
      for (const track of micTracks) {
        if ('contentHint' in track) {
          track.contentHint = 'speech';
        }
      }
    }
  } catch (e) {
    logger.warn('Failed to apply content hints (non-fatal):', e);
  }
}

/**
 * Create and configure a MediaRecorder with standard handlers.
 *
 * The returned object owns its own per-recorder `failedChunkCount` — there is
 * no module-level shared counter. Two recorders running concurrently (e.g. in
 * tests, or future page+offscreen overlap) won't clobber each other's stats.
 *
 * @param {MediaStream} stream - The media stream to record
 * @param {string} recordingId - Unique recording identifier
 * @param {Object} callbacks - Event callbacks
 * @param {Function} callbacks.onStart - Called when recording starts
 * @param {Function} callbacks.onStop - Called when recording stops (receives mimeType, duration, totalSize, { failedChunks })
 * @param {Function} callbacks.onError - Called on recorder error
 * @returns {{
 *   recorder: MediaRecorder,
 *   getStats: () => { chunkIndex: number, totalSize: number, duration: number, failedChunks: number },
 *   getFailedChunkCount: () => number,
 * }} MediaRecorder + per-instance stats accessors.
 */
export function createMediaRecorder(stream, recordingId, callbacks = {}) {
  const { onStart, onStop, onError } = callbacks;

  const mimeType = getOptimalCodec();
  const recorder = new MediaRecorder(stream, { mimeType });

  let chunkIndex = 0;
  let totalSize = 0;
  let recordingStartTime = 0;
  let failedChunkCount = 0;
  const pendingChunkSaves = new Set();

  async function saveChunkWithRetry(chunk, index) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_CHUNK_SAVE_RETRIES; attempt++) {
      try {
        await saveChunk(recordingId, chunk, index);
        return { saved: true };
      } catch (err) {
        lastError = err;
        logger.warn(`Chunk save attempt ${attempt}/${MAX_CHUNK_SAVE_RETRIES} failed:`, err);
        if (attempt < MAX_CHUNK_SAVE_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, CHUNK_SAVE_RETRY_DELAY_MS));
        }
      }
    }
    failedChunkCount++;
    logger.error('Chunk save permanently failed after retries:', {
      recordingId,
      index,
      attempts: MAX_CHUNK_SAVE_RETRIES,
      error: lastError,
    });
    return { saved: false, error: 'CHUNK_SAVE_FAILED', chunksLost: 1 };
  }

  recorder.onstart = () => {
    recordingStartTime = Date.now();
    failedChunkCount = 0;
    logger.log('MediaRecorder started, mimeType:', recorder.mimeType);
    onStart?.();
  };

  recorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) {
      totalSize += e.data.size;
      const index = chunkIndex++;
      const pendingSave = saveChunkWithRetry(e.data, index);
      pendingChunkSaves.add(pendingSave);

      const result = await pendingSave.finally(() => {
        pendingChunkSaves.delete(pendingSave);
      });

      if (!result.saved) {
        const structuredError = createError(
          CODES.CHUNK_SAVE_FAILED,
          'Failed to save recording chunk',
          `Failed to save chunk at index ${index} after ${MAX_CHUNK_SAVE_RETRIES} attempts (recordingId=${recordingId})`
        );
        logger.error('Chunk save failed:', structuredError);
      }
    }
  };

  recorder.onerror = (e) => {
    logger.error('MediaRecorder error:', e);
    onError?.(e);
  };

  recorder.onstop = async () => {
    const duration = Date.now() - recordingStartTime;
    logger.log(
      `MediaRecorder stopped after ${duration}ms. Total chunks: ${chunkIndex}, size: ${totalSize} bytes`
    );

    if (chunkIndex === 0) {
      logger.warn('No chunks recorded! Recording may have been too short.');
    }
    if (pendingChunkSaves.size > 0) {
      await Promise.allSettled(pendingChunkSaves);
    }

    const finalMimeType = recorder.mimeType || 'video/webm';
    await onStop?.(finalMimeType, duration, totalSize, { failedChunks: failedChunkCount });
  };

  return {
    recorder,
    getStats: () => ({
      chunkIndex,
      totalSize,
      duration: Date.now() - recordingStartTime,
      failedChunks: failedChunkCount,
    }),
    getFailedChunkCount: () => failedChunkCount,
  };
}

/**
 * Combine multiple media streams into one
 * @param {Object} streams - Object containing display and optional mic streams
 * @param {MediaStream} streams.displayStream - Screen/window/tab stream
 * @param {MediaStream} [streams.micStream] - Optional microphone stream
 * @returns {MediaStream} Combined stream with all tracks
 */
export function combineStreams({ displayStream, micStream }) {
  const tracks = [
    ...displayStream.getVideoTracks(),
    ...displayStream.getAudioTracks(),
    ...(micStream ? micStream.getAudioTracks() : []),
  ];
  return new MediaStream(tracks);
}

/**
 * Setup auto-stop listener when screen sharing ends
 * @param {MediaStream} stream - The media stream to monitor
 * @param {MediaRecorder} recorder - The recorder to stop
 */
export function setupAutoStop(stream, recorder) {
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      logger.log('Video track ended, auto-stopping recorder');
      if (recorder && recorder.state !== 'inactive') {
        if (recorder.state === 'recording') {
          recorder.requestData();
        }
        recorder.stop();
      }
    });
  });
}
