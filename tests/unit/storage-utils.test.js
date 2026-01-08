// Unit tests for storage-utils.js

import { jest } from '@jest/globals';
import {
  checkStorageQuota,
  checkSpaceForDuration,
  getStorageInfo,
  requestPersistentStorage,
  MIN_FREE_SPACE_BYTES,
  ESTIMATED_BYTES_PER_MINUTE,
} from '../../storage-utils.js';

describe('storage-utils.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset navigator.storage mock
    delete global.navigator;
  });

  describe('checkStorageQuota', () => {
    it('should return ok: true when sufficient space available', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockResolvedValue({
            usage: 100 * 1024 * 1024, // 100MB used
            quota: 1000 * 1024 * 1024, // 1GB total
          }),
        },
      };

      const result = await checkStorageQuota();
      expect(result.ok).toBe(true);
      expect(result.available).toBe(900 * 1024 * 1024);
    });

    it('should return ok: false when insufficient space', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockResolvedValue({
            usage: 950 * 1024 * 1024, // 950MB used
            quota: 1000 * 1024 * 1024, // 1GB total
          }),
        },
      };

      const result = await checkStorageQuota();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Insufficient storage space');
      expect(result.available).toBeLessThan(MIN_FREE_SPACE_BYTES);
    });

    it('should return ok: true when StorageManager API not available', async () => {
      global.navigator = {};

      const result = await checkStorageQuota();
      expect(result.ok).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockRejectedValue(new Error('Storage error')),
        },
      };

      const result = await checkStorageQuota();
      expect(result.ok).toBe(true); // Fails open for safety
      expect(result.error).toContain('Could not check storage quota');
    });
  });

  describe('checkSpaceForDuration', () => {
    it('should return ok: true when enough space for duration', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockResolvedValue({
            usage: 100 * 1024 * 1024,
            quota: 1000 * 1024 * 1024,
          }),
        },
      };

      const result = await checkSpaceForDuration(10); // 10 minutes
      expect(result.ok).toBe(true);
      expect(result.estimatedNeed).toBe(10 * ESTIMATED_BYTES_PER_MINUTE);
    });

    it('should return ok: false when insufficient space for duration', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockResolvedValue({
            usage: 900 * 1024 * 1024,
            quota: 1000 * 1024 * 1024, // Only 100MB free
          }),
        },
      };

      const result = await checkSpaceForDuration(30); // 30 min = ~600MB
      expect(result.ok).toBe(false);
      expect(result.error).toContain('May not have enough space');
    });

    it('should return ok: true when API not available', async () => {
      global.navigator = {};

      const result = await checkSpaceForDuration(20);
      expect(result.ok).toBe(true);
    });
  });

  describe('getStorageInfo', () => {
    it('should return storage information', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockResolvedValue({
            usage: 250 * 1024 * 1024,
            quota: 1000 * 1024 * 1024,
          }),
        },
      };

      const result = await getStorageInfo();
      expect(result).not.toBeNull();
      expect(result.usage).toBe(250 * 1024 * 1024);
      expect(result.quota).toBe(1000 * 1024 * 1024);
      expect(result.usagePercent).toBe(25);
      expect(result.usageMB).toBeCloseTo(250, 0);
      expect(result.quotaMB).toBeCloseTo(1000, 0);
      expect(result.availableMB).toBeCloseTo(750, 0);
    });

    it('should return null when API not available', async () => {
      global.navigator = {};

      const result = await getStorageInfo();
      expect(result).toBeNull();
    });

    it('should handle errors and return null', async () => {
      global.navigator = {
        storage: {
          estimate: jest.fn().mockRejectedValue(new Error('Error')),
        },
      };

      const result = await getStorageInfo();
      expect(result).toBeNull();
    });
  });

  describe('requestPersistentStorage', () => {
    it('should return true when already persisted', async () => {
      global.navigator = {
        storage: {
          persisted: jest.fn().mockResolvedValue(true),
          persist: jest.fn(),
        },
      };

      const result = await requestPersistentStorage();
      expect(result).toBe(true);
      expect(global.navigator.storage.persist).not.toHaveBeenCalled();
    });

    it('should request persistence when not already persisted', async () => {
      global.navigator = {
        storage: {
          persisted: jest.fn().mockResolvedValue(false),
          persist: jest.fn().mockResolvedValue(true),
        },
      };

      const result = await requestPersistentStorage();
      expect(result).toBe(true);
      expect(global.navigator.storage.persist).toHaveBeenCalled();
    });

    it('should return false when persistence denied', async () => {
      global.navigator = {
        storage: {
          persisted: jest.fn().mockResolvedValue(false),
          persist: jest.fn().mockResolvedValue(false),
        },
      };

      const result = await requestPersistentStorage();
      expect(result).toBe(false);
    });

    it('should return false when API not available', async () => {
      global.navigator = {};

      const result = await requestPersistentStorage();
      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      global.navigator = {
        storage: {
          persisted: jest.fn().mockRejectedValue(new Error('Error')),
        },
      };

      const result = await requestPersistentStorage();
      expect(result).toBe(false);
    });
  });

  describe('constants', () => {
    it('should export MIN_FREE_SPACE_BYTES', () => {
      expect(MIN_FREE_SPACE_BYTES).toBe(100 * 1024 * 1024);
    });

    it('should export ESTIMATED_BYTES_PER_MINUTE', () => {
      expect(ESTIMATED_BYTES_PER_MINUTE).toBe(20 * 1024 * 1024);
    });
  });
});
