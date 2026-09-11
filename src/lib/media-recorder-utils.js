// Shared MediaRecorder utilities to reduce code duplication

import { saveChunk } from './chunkStorage.js';
import { createLogger } from '../logger.js';
import { createError, CODES } from '../error-codes.js';

const logger = createLogger('MediaRecorderUtils');

// A MediaStream can only expose one audio track reliably to MediaRecorder in
// Chromium. When a screen capture and a microphone are both present we route
// them through Web Audio and retain the graph's lifetime alongside the output
// stream. A WeakMap keeps the resource bookkeeping private to this module and
// avoids adding application-specific properties to browser MediaStream
// objects.
const combinedStreamResources = new WeakMap();

// Constants for recorder configuration
export const CHUNK_INTERVAL_MS = 1000; // 1 second chunks for balance of memory/recovery
export const BEST_QUALITY_FRAME_RATE = 60;
export const BEST_QUALITY_VIDEO_BITS_PER_SECOND = 25_000_000;
// A browser can leave AudioContext.resume() pending when autoplay or sticky
// user activation is unavailable. Keep this below the service's startup
// confirmation timeout so a capture cannot remain untracked indefinitely.
export const MIXED_AUDIO_RESUME_TIMEOUT_MS = 3000;

/**
 * Return display-capture constraints for the selected quality mode.
 * Leaving width and height unconstrained preserves the selected source's native resolution.
 * @param {boolean} bestQuality - Whether to target the best-quality preset
 * @returns {true|MediaTrackConstraints} Video constraints for getDisplayMedia
 */
export function getDisplayVideoConstraints(bestQuality = false) {
  if (!bestQuality) return true;
  return {
    frameRate: { ideal: BEST_QUALITY_FRAME_RATE, max: BEST_QUALITY_FRAME_RATE },
  };
}

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
 * @param {Object} recordingOptions - MediaRecorder encoding options
 * @param {number} recordingOptions.videoBitsPerSecond - Optional target video bitrate
 * @returns {{
 *   recorder: MediaRecorder,
 *   getStats: () => { chunkIndex: number, totalSize: number, duration: number, failedChunks: number },
 *   getFailedChunkCount: () => number,
 * }} MediaRecorder + per-instance stats accessors.
 */
export function createMediaRecorder(stream, recordingId, callbacks = {}, recordingOptions = {}) {
  const { onStart, onStop, onError } = callbacks;
  const { videoBitsPerSecond } = recordingOptions;

  if (
    videoBitsPerSecond !== undefined &&
    (!Number.isSafeInteger(videoBitsPerSecond) || videoBitsPerSecond <= 0)
  ) {
    throw new TypeError('videoBitsPerSecond must be a positive safe integer');
  }

  const mimeType = getOptimalCodec();
  const mediaRecorderOptions = { mimeType };
  if (videoBitsPerSecond !== undefined) {
    mediaRecorderOptions.videoBitsPerSecond = videoBitsPerSecond;
  }
  const recorder = new MediaRecorder(stream, mediaRecorderOptions);

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
 * Combine multiple media streams into one. When both inputs have audio, the
 * returned stream has one Web Audio mixed track so MediaRecorder receives both
 * sources reliably.
 * @param {Object} streams - Object containing display and optional mic streams
 * @param {MediaStream} streams.displayStream - Screen/window/tab stream
 * @param {MediaStream} [streams.micStream] - Optional microphone stream
 * @returns {MediaStream} Combined stream with all tracks
 */
export function combineStreams({ displayStream, micStream }) {
  const displayVideoTracks = displayStream?.getVideoTracks?.() || [];
  const displayAudioTracks = displayStream?.getAudioTracks?.() || [];
  const micAudioTracks = micStream?.getAudioTracks?.() || [];

  // Keep the old track-preserving behavior when there is only one audio
  // source. In particular, this avoids introducing a resampling/latency step
  // for recordings that do not need mixing.
  if (displayAudioTracks.length === 0 || micAudioTracks.length === 0) {
    return new MediaStream([...displayVideoTracks, ...displayAudioTracks, ...micAudioTracks]);
  }

  const AudioContextConstructor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('Web Audio is required to record system audio and microphone audio together');
  }

  let audioContext = null;
  let combinedStream = null;
  let sourceNodes = [];
  let inputTracksStopped = false;
  let cleanupPromise = null;

  const stopInputTracks = () => {
    if (inputTracksStopped) return;
    inputTracksStopped = true;
    for (const track of [...displayAudioTracks, ...micAudioTracks]) {
      try {
        track.stop?.();
      } catch (error) {
        logger.warn('Failed to stop an audio capture track (non-fatal):', error);
      }
    }
  };

  const closeAudioContext = async () => {
    if (!audioContext || audioContext.state === 'closed') return;
    try {
      await audioContext.close();
    } catch (error) {
      logger.warn('Failed to close mixed-audio context (non-fatal):', error);
    }
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;

    // Disconnect and stop synchronously so callers that cannot await during
    // unload still release the live capture sources immediately.
    for (const { sourceNode, gainNode } of sourceNodes) {
      for (const node of [sourceNode, gainNode]) {
        try {
          node?.disconnect?.();
        } catch (error) {
          logger.warn('Failed to disconnect mixed-audio source (non-fatal):', error);
        }
      }
    }
    sourceNodes = [];
    stopInputTracks();

    cleanupPromise = closeAudioContext();
    return cleanupPromise;
  };

  try {
    audioContext = new AudioContextConstructor();
    const destination = audioContext.createMediaStreamDestination();
    const mixedAudioTrack = destination?.stream?.getAudioTracks?.()?.[0];
    if (!mixedAudioTrack) {
      throw new Error('Web Audio did not provide a mixed audio track');
    }

    // Give each input half the available headroom. Directly summing two
    // full-scale sources can clip before MediaRecorder receives the signal.
    const inputStreams = [displayStream, micStream];
    sourceNodes = inputStreams.map((inputStream) => {
      const sourceNode = audioContext.createMediaStreamSource(inputStream);
      if (typeof audioContext.createGain === 'function') {
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0.5;
        sourceNode.connect(gainNode);
        gainNode.connect(destination);
        return { sourceNode, gainNode };
      }
      sourceNode.connect(destination);
      return { sourceNode };
    });

    combinedStream = new MediaStream([...displayVideoTracks, mixedAudioTrack]);
    const resource = {
      cleanup,
      ready: null,
    };
    combinedStreamResources.set(combinedStream, resource);

    resource.ready = resumeAudioContext(audioContext).catch((error) => {
      // A suspended context that cannot be resumed must fail startup. Closing
      // the graph here also prevents an unhandled live capture source if the
      // caller abandons the failed promise.
      return cleanupCombinedStream(combinedStream).then(() => {
        throw error;
      });
    });

    return combinedStream;
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Wait until a stream's mixed-audio graph is running.
 *
 * Single-source streams have no graph and are ready immediately. The promise
 * rejects when a browser refuses to resume Web Audio, so callers cannot start
 * a recording that silently contains no audio.
 * @param {MediaStream} stream - A stream returned by combineStreams
 * @returns {Promise<void>} Resolves when mixed audio is ready
 */
export function waitForCombinedStreamReady(stream) {
  return combinedStreamResources.get(stream)?.ready || Promise.resolve();
}

/**
 * Release tracks and Web Audio resources owned by a combined stream.
 * Cleanup is idempotent and safe to call from both stop and failure paths.
 * @param {MediaStream} stream - A stream returned by combineStreams
 * @returns {Promise<void>} Resolves after AudioContext.close, when applicable
 */
export async function cleanupCombinedStream(stream) {
  if (!stream) return;

  const resource = combinedStreamResources.get(stream);
  try {
    await resource?.cleanup?.();
  } finally {
    // Stop the mixed track and all video tracks. For single-source streams the
    // audio track is also the original capture track, so this covers that
    // path without needing a second owner reference.
    try {
      stream.getTracks?.().forEach((track) => track.stop?.());
    } catch (error) {
      logger.warn('Failed to stop combined stream tracks (non-fatal):', error);
    }
    if (resource) combinedStreamResources.delete(stream);
  }
}

/**
 * Resume a context before MediaRecorder starts consuming its destination.
 * @param {AudioContext} audioContext - Context used for mixed audio
 * @returns {Promise<void>} Resolves only when the context is running
 */
async function resumeAudioContext(audioContext) {
  if (audioContext.state === 'running') return;
  if (audioContext.state === 'closed') {
    throw new Error('Mixed-audio context is already closed');
  }
  if (typeof audioContext.resume !== 'function') {
    throw new Error('Mixed-audio context cannot be resumed');
  }

  let timeoutId;
  try {
    const resumePromise = Promise.resolve().then(() => audioContext.resume());
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const timeoutError = new Error(
          `Timed out waiting ${MIXED_AUDIO_RESUME_TIMEOUT_MS}ms for mixed-audio context to resume`
        );
        timeoutError.name = 'TimeoutError';
        reject(timeoutError);
      }, MIXED_AUDIO_RESUME_TIMEOUT_MS);
    });
    // Promise.race observes a late resume rejection too, so a browser that
    // eventually settles the original operation cannot create an unhandled
    // rejection after the timeout has already failed startup.
    await Promise.race([resumePromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (audioContext.state && audioContext.state !== 'running') {
    throw new Error(`Mixed-audio context did not start (state: ${audioContext.state})`);
  }
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
