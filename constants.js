// Shared constants for CaptureCast extension

// Timeout durations (in milliseconds)
export const STOP_TIMEOUT_MS = 60_000; // 60 seconds safety timeout for stop operations
export const DURATION_FIX_TIMEOUT_MS = 2000; // Time to wait for video duration normalization

// Database
export const AUTO_DELETE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// MediaRecorder chunk interval
export const CHUNK_INTERVAL_MS = 1000; // 1 second chunks for balance of memory/recovery

// Video playback
export const SEEK_POSITION_LARGE = Number.MAX_SAFE_INTEGER / 2; // Large seek value to force duration calculation (avoid overflow)

// UI feedback
export const ERROR_DISPLAY_DURATION_MS = 2000; // How long to show error state in UI
