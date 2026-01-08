// Unit tests for constants.js

import {
  STOP_TIMEOUT_MS,
  DURATION_FIX_TIMEOUT_MS,
  AUTO_DELETE_AGE_MS,
  SEEK_POSITION_LARGE,
  ERROR_DISPLAY_DURATION_MS,
} from '../../constants.js';

describe('constants.js', () => {
  describe('timeout constants', () => {
    it('should define STOP_TIMEOUT_MS as 60 seconds', () => {
      expect(STOP_TIMEOUT_MS).toBe(60_000);
    });

    it('should define DURATION_FIX_TIMEOUT_MS as 2 seconds', () => {
      expect(DURATION_FIX_TIMEOUT_MS).toBe(2000);
    });

    it('should define ERROR_DISPLAY_DURATION_MS as 2 seconds', () => {
      expect(ERROR_DISPLAY_DURATION_MS).toBe(2000);
    });
  });

  describe('database constants', () => {
    it('should define AUTO_DELETE_AGE_MS as 24 hours', () => {
      expect(AUTO_DELETE_AGE_MS).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('video playback constants', () => {
    it('should define SEEK_POSITION_LARGE', () => {
      expect(SEEK_POSITION_LARGE).toBe(Number.MAX_SAFE_INTEGER / 2);
    });

    it('should be a large finite number for seeking', () => {
      expect(Number.isFinite(SEEK_POSITION_LARGE)).toBe(true);
      expect(SEEK_POSITION_LARGE).toBeGreaterThan(0);
    });
  });
});
