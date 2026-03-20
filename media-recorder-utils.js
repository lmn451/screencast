// Shared MediaRecorder utilities to reduce code duplication

import { saveChunk } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger('MediaRecorderUtils');

// Constants for recorder configuration
export const CHUNK_INTERVAL_MS = 1000; // 1 second chunks for balance of memory/recovery

// Detect if we're in a CI/testing environment (GPU acceleration may be disabled)
const isCI = typeof process !== 'undefined' && process.env?.CI === 'true';

/**
 * Get the best supported video codec from a prioritized list
 * 
 * For normal browsers: AV1 → VP9 → VP8 (best compression)
 * For CI/testing: VP8 first (most reliable software codec, no GPU needed)
 * 
 * @returns {string} MIME type of the best supported codec
 */
export function getOptimalCodec() {
  // In CI environments with disabled GPU, use VP8 (pure software encoding)
  // AV1/VP9 may require GPU acceleration which isn't available
  const codecsForCI = [
    'video/webm;codecs=vp8,opus',  // Most reliable software codec
    'video/webm;codecs=vp8',        // VP8 without audio
    'video/webm',                   // Generic fallback
  ];

  const codecsForNormal = [
    'video/webm;codecs=av01,opus', // AV1 (best compression, GPU preferred)
    'video/webm;codecs=av1,opus',
    'video/webm;codecs=vp9,opus',   // VP9 (good compression)
    'video/webm;codecs=vp8,opus',   // VP8 (reliable fallback)
    'video/webm',
  ];

  const codecs = isCI ? codecsForCI : codecsForNormal;

  for (const codec of codecs) {
    if (MediaRecorder.isTypeSupported(codec)) {
      logger.log('Selected codec:', codec, isCI ? '(CI mode - software encoding)' : '');
      return codec;
    }
  }

  throw new Error('No supported video codec found. Your browser may not support video recording.');
}

/**
 * Force software encoding codec (for CI/headless environments)
 * Use this when GPU is disabled to avoid green screen issues
 * @returns {string} MIME type for VP8 software encoding
 */
export function getSoftwareCodec() {
  const softwareCodecs = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  for (const codec of softwareCodecs) {
    if (MediaRecorder.isTypeSupported(codec)) {
      logger.log('Software codec selected:', codec);
      return codec;
    }
  }

  logger.warn('No software codec found, using default');
  return 'video/webm';
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
    logger.log(
      `MediaRecorder stopped after ${duration}ms. Total chunks: ${chunkIndex}, size: ${totalSize} bytes`
    );

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
