// Storage quota utilities for CaptureCast
// Helps prevent out-of-space errors during recording

import { createLogger } from './logger.js';
import { getAllRecordingIds, getChunks } from './chunkStorage.js';

const logger = createLogger('StorageUtils');

// Minimum free space required to start recording (in bytes)
// Conservative estimate: 100MB for a short recording
export const MIN_FREE_SPACE_BYTES = 100 * 1024 * 1024; // 100MB

// Estimated bytes per minute of recording (rough estimate)
// Actual usage varies by resolution, codec, content complexity
// 1080p VP9 with audio: ~5-15 MB/min
// 4K VP9 with audio: ~20-50 MB/min
// Conservative estimate: 20MB/min
export const ESTIMATED_BYTES_PER_MINUTE = 20 * 1024 * 1024; // 20MB

// Bitrate constants for different resolutions (in bits per second)
const BITRATES = {
  // 720p screen capture (lower end)
  '720p': {
    video: 2 * 1024 * 1024, // 2 Mbps
    audio: 128 * 1024, // 128 kbps
  },
  // 1080p screen capture (typical)
  '1080p': {
    video: 5 * 1024 * 1024, // 5 Mbps
    audio: 128 * 1024, // 128 kbps
  },
  // 1440p screen capture (higher)
  '1440p': {
    video: 10 * 1024 * 1024, // 10 Mbps
    audio: 192 * 1024, // 192 kbps
  },
  // 4K screen capture (highest)
  '4K': {
    video: 20 * 1024 * 1024, // 20 Mbps
    audio: 256 * 1024, // 256 kbps
  },
};

/**
 * Estimate the size of a recording based on duration and settings
 * @param {number} durationMs - Recording duration in milliseconds
 * @param {boolean} hasAudio - Whether audio is included
 * @param {string} [resolution='1080p'] - Resolution tier: '720p', '1080p', '1440p', '4K'
 * @returns {number} Estimated size in bytes
 */
export function estimateRecordingSize(durationMs, hasAudio, resolution = '1080p') {
  const durationMinutes = durationMs / (1000 * 60);
  const bitrate = BITRATES[resolution] || BITRATES['1080p'];

  let totalBitsPerSecond = bitrate.video;
  if (hasAudio) {
    totalBitsPerSecond += bitrate.audio;
  }

  const estimatedBytes = (totalBitsPerSecond / 8) * durationMinutes * 60;
  return Math.round(estimatedBytes);
}

/**
 * Estimate recording size using simplified MB/min values
 * @param {number} durationMs - Recording duration in milliseconds
 * @param {boolean} hasAudio - Whether audio is included
 * @returns {number} Estimated size in bytes
 */
export function estimateRecordingSizeSimple(durationMs, hasAudio) {
  const durationMinutes = durationMs / (1000 * 60);
  // Conservative: ~5 MB/min video + ~1 MB/min audio
  const videoMB = durationMinutes * 5;
  const audioMB = hasAudio ? durationMinutes * 1 : 0;
  return Math.round((videoMB + audioMB) * 1024 * 1024);
}

/**
 * Check if sufficient storage quota is available
 * @returns {Promise<{ok: boolean, usage?: number, quota?: number, available?: number, error?: string}>}
 */
export async function checkStorageQuota() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) {
      // StorageManager API not available (older browsers)
      // Assume sufficient space and let the recording proceed
      logger.warn('StorageManager API not available, cannot check quota');
      return { ok: true };
    }

    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    const available = quota - usage;

    logger.log('Storage quota check:', {
      usage: `${(usage / 1024 / 1024).toFixed(1)} MB`,
      quota: `${(quota / 1024 / 1024).toFixed(1)} MB`,
      available: `${(available / 1024 / 1024).toFixed(1)} MB`,
      usagePercent: `${((usage / quota) * 100).toFixed(1)}%`,
    });

    if (available < MIN_FREE_SPACE_BYTES) {
      const availableMB = (available / 1024 / 1024).toFixed(1);
      const requiredMB = (MIN_FREE_SPACE_BYTES / 1024 / 1024).toFixed(1);
      return {
        ok: false,
        usage,
        quota,
        available,
        error: `Insufficient storage space. Available: ${availableMB} MB, Required: ${requiredMB} MB. Please delete old recordings or free up space.`,
      };
    }

    return { ok: true, usage, quota, available };
  } catch (e) {
    logger.error('Failed to check storage quota:', e);
    // On error, assume sufficient space to avoid blocking legitimate recordings
    return { ok: true, error: 'Could not check storage quota: ' + e.message };
  }
}

/**
 * Check quota during recording to detect low space warnings
 * @param {number} [minFreeBytes=50*1024*1024] - Minimum free bytes warning threshold
 * @returns {Promise<{ok: boolean, warning?: boolean, available?: number, message?: string}>}
 */
export async function checkQuotaDuringRecording(minFreeBytes = 50 * 1024 * 1024) {
  try {
    if (!navigator.storage || !navigator.storage.estimate) {
      return { ok: true };
    }

    const estimate = await navigator.storage.estimate();
    const available = (estimate.quota || 0) - (estimate.usage || 0);

    if (available < minFreeBytes) {
      const availableMB = (available / 1024 / 1024).toFixed(1);
      logger.warn(`Low storage space during recording: ${availableMB} MB available`);
      return {
        ok: true,
        warning: true,
        available,
        message: `Storage space running low: ${availableMB} MB remaining`,
      };
    }

    return { ok: true, warning: false, available };
  } catch (e) {
    logger.warn('Failed to check quota during recording:', e);
    return { ok: true };
  }
}

/**
 * Check if existing partial recordings can be recovered
 * @returns {Promise<{recoverable: Array, canProceed: boolean}>}
 */
export async function checkExistingPartialRecordings() {
  try {
    // Import dynamically to avoid circular dependency issues
    const { getAllRecordings } = await import('./recordings.js');
    const recordings = await getAllRecordings();

    const partialRecordings = recordings.filter((r) => r.status === 'partial');
    const failedRecordings = recordings.filter((r) => r.status === 'failed');

    logger.log('Existing partial/failed recordings:', {
      partial: partialRecordings.length,
      failed: failedRecordings.length,
    });

    return {
      recoverable: partialRecordings,
      canProceed: true, // We can proceed even with partial recordings
    };
  } catch (e) {
    logger.warn('Failed to check existing partial recordings:', e);
    return { recoverable: [], canProceed: true };
  }
}

/**
 * Get a breakdown of storage usage by category
 * @returns {Promise<{recordings: number, chunks: number, diagnostics: number, total: number}>}
 */
export async function getStorageUsageBreakdown() {
  const breakdown = {
    recordings: 0,
    chunks: 0,
    total: 0,
  };

  try {
    // Get recordings store size estimate
    const { getAllRecordings } = await import('./recordings.js');
    const recordings = await getAllRecordings();

    let recordingsSize = 0;
    for (const recording of recordings) {
      recordingsSize += recording.size || 0;
      // Estimate metadata overhead (~500 bytes per recording)
      recordingsSize += 500;
    }
    breakdown.recordings = recordingsSize;

    // Get chunks store size estimate
    const recordingIds = await getAllRecordingIds();
    let chunksSize = 0;
    for (const id of recordingIds) {
      const chunks = await getChunks(id);
      for (const chunk of chunks) {
        chunksSize += chunk.chunk?.size || 0;
      }
    }
    breakdown.chunks = chunksSize;

    breakdown.total = breakdown.recordings + breakdown.chunks;

    logger.log('Storage usage breakdown:', {
      recordings: `${(breakdown.recordings / 1024 / 1024).toFixed(1)} MB`,
      chunks: `${(breakdown.chunks / 1024 / 1024).toFixed(1)} MB`,
      total: `${(breakdown.total / 1024 / 1024).toFixed(1)} MB`,
    });

    return breakdown;
  } catch (e) {
    logger.error('Failed to get storage usage breakdown:', e);
    return breakdown;
  }
}

/**
 * Estimate if there's enough space for a recording of specified duration
 * @param {number} estimatedMinutes - Expected recording duration in minutes
 * @returns {Promise<{ok: boolean, estimatedNeed?: number, available?: number, error?: string}>}
 */
export async function checkSpaceForDuration(estimatedMinutes) {
  try {
    if (!navigator.storage || !navigator.storage.estimate) {
      return { ok: true };
    }

    const estimate = await navigator.storage.estimate();
    const available = (estimate.quota || 0) - (estimate.usage || 0);
    const estimatedNeed = estimatedMinutes * ESTIMATED_BYTES_PER_MINUTE;

    logger.log('Space check for duration:', {
      minutes: estimatedMinutes,
      estimatedNeed: `${(estimatedNeed / 1024 / 1024).toFixed(1)} MB`,
      available: `${(available / 1024 / 1024).toFixed(1)} MB`,
    });

    if (available < estimatedNeed) {
      const availableMB = (available / 1024 / 1024).toFixed(1);
      const neededMB = (estimatedNeed / 1024 / 1024).toFixed(1);
      return {
        ok: false,
        estimatedNeed,
        available,
        error: `May not have enough space for ${estimatedMinutes} minute recording. Available: ${availableMB} MB, Estimated need: ${neededMB} MB.`,
      };
    }

    return { ok: true, estimatedNeed, available };
  } catch (e) {
    logger.error('Failed to estimate space for duration:', e);
    return { ok: true, error: 'Could not estimate space: ' + e.message };
  }
}

/**
 * Get current storage usage information
 * @returns {Promise<{usage: number, quota: number, usagePercent: number} | null>}
 */
export async function getStorageInfo() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) {
      return null;
    }

    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage || 0;
    const quota = estimate.quota || 0;
    const usagePercent = quota > 0 ? (usage / quota) * 100 : 0;

    return {
      usage,
      quota,
      usagePercent,
      usageMB: usage / 1024 / 1024,
      quotaMB: quota / 1024 / 1024,
      availableMB: (quota - usage) / 1024 / 1024,
    };
  } catch (e) {
    logger.error('Failed to get storage info:', e);
    return null;
  }
}

/**
 * Request persistent storage (prevents automatic eviction)
 * @returns {Promise<boolean>} True if persistent storage granted
 */
export async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) {
      logger.warn('Persistent storage API not available');
      return false;
    }

    const isPersisted = await navigator.storage.persisted();
    if (isPersisted) {
      logger.log('Storage is already persistent');
      return true;
    }

    const granted = await navigator.storage.persist();
    if (granted) {
      logger.log('Persistent storage granted');
    } else {
      logger.warn('Persistent storage denied');
    }
    return granted;
  } catch (e) {
    logger.error('Failed to request persistent storage:', e);
    return false;
  }
}
