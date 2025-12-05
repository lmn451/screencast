// Shared MediaRecorder utilities to reduce code duplication

import { saveChunk } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger('MediaRecorderUtils');

// Constants for recorder configuration
export const CHUNK_INTERVAL_MS = 1000; // 1 second chunks for balance of memory/recovery

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
 * Create and configure a MediaRecorder with standard handlers
 * @param {MediaStream} stream - The media stream to record
 * @param {string} recordingId - Unique recording identifier
 * @param {Object} callbacks - Event callbacks
 * @param {Function} callbacks.onStart - Called when recording starts
 * @param {Function} callbacks.onStop - Called when recording stops (receives mimeType, duration, totalSize)
 * @param {Function} callbacks.onError - Called on recorder error
 * @returns {Object} { recorder, getStats } - MediaRecorder instance and stats getter
 */
export function createMediaRecorder(stream, recordingId, callbacks = {}) {
  const { onStart, onStop, onError } = callbacks;

  const mimeType = getOptimalCodec();
  const recorder = new MediaRecorder(stream, { mimeType });

  let chunkIndex = 0;
  let totalSize = 0;
  let recordingStartTime = 0;

  recorder.onstart = () => {
    recordingStartTime = Date.now();
    logger.log('MediaRecorder started, mimeType:', recorder.mimeType);
    onStart?.();
  };

  recorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) {
      try {
        totalSize += e.data.size;
        await saveChunk(recordingId, e.data, chunkIndex++);
      } catch (err) {
        logger.error('Failed to save chunk:', err);
        // Continue recording despite save failure
      }
    }
  };

  recorder.onerror = (e) => {
    logger.error('MediaRecorder error:', e);
    onError?.(e);
  };

  recorder.onstop = async () => {
    const duration = Date.now() - recordingStartTime;
    logger.log(`MediaRecorder stopped after ${duration}ms. Total chunks: ${chunkIndex}, size: ${totalSize} bytes`);

    if (chunkIndex === 0) {
      logger.warn('No chunks recorded! Recording may have been too short.');
    }

    const finalMimeType = recorder.mimeType || 'video/webm';
    await onStop?.(finalMimeType, duration, totalSize);
  };

  return {
    recorder,
    getStats: () => ({ chunkIndex, totalSize, duration: Date.now() - recordingStartTime }),
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
