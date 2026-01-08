// Storage quota utilities for CaptureCast
// Helps prevent out-of-space errors during recording

import { createLogger } from './logger.js';

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
      usagePercent: `${((usage / quota) * 100).toFixed(1)}%`
    });

    if (available < MIN_FREE_SPACE_BYTES) {
      const availableMB = (available / 1024 / 1024).toFixed(1);
      const requiredMB = (MIN_FREE_SPACE_BYTES / 1024 / 1024).toFixed(1);
      return {
        ok: false,
        usage,
        quota,
        available,
        error: `Insufficient storage space. Available: ${availableMB} MB, Required: ${requiredMB} MB. Please delete old recordings or free up space.`
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
      available: `${(available / 1024 / 1024).toFixed(1)} MB`
    });

    if (available < estimatedNeed) {
      const availableMB = (available / 1024 / 1024).toFixed(1);
      const neededMB = (estimatedNeed / 1024 / 1024).toFixed(1);
      return {
        ok: false,
        estimatedNeed,
        available,
        error: `May not have enough space for ${estimatedMinutes} minute recording. Available: ${availableMB} MB, Estimated need: ${neededMB} MB.`
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
      availableMB: (quota - usage) / 1024 / 1024
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
