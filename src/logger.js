// Centralized logging utility for CaptureCast
// In production, only warnings and errors are shown

import { saveDiagnostic, createDiagnosticEntry, DiagLevel, DiagEvent } from './diagnostics.js';

const DEBUG = true; // Set to true during development, false for production

export const log = DEBUG ? console.log.bind(console) : () => {};
export const warn = console.warn.bind(console);
export const error = console.error.bind(console);

// Helper to log with component prefix
export function createLogger(component) {
  return {
    log: (...args) => log(`[${component}]`, ...args),
    warn: (...args) => warn(`[${component}]`, ...args),
    error: (...args) => error(`[${component}]`, ...args),
  };
}

/**
 * Creates a logger that also persists diagnostics to IndexedDB.
 * @param {string} component - Component name for logging prefix
 * @param {object} [opts={}] - Additional options
 * @param {string} [opts.recordingId] - Recording ID for correlation
 * @param {string} [opts.correlationId] - Correlation ID
 * @returns {object} Logger with diagnostics integration
 */
export function createLoggerWithDiagnostics(component, opts = {}) {
  const logger = createLogger(component);

  const persist = (level, eventCode, userMessage, extra = {}) => {
    saveDiagnostic(
      createDiagnosticEntry(level, eventCode, userMessage, {
        technicalMessage: opts.technicalMessage,
        recordingId: opts.recordingId,
        correlationId: opts.correlationId,
        ...extra,
      })
    );
  };

  return {
    log: (...args) => {
      logger.log(...args);
      const msg = args.map(String).join(' ');
      persist(DiagLevel.DEBUG, DiagEvent.MESSAGE_RECEIVED, msg);
    },
    warn: (...args) => {
      logger.warn(...args);
      const msg = args.map(String).join(' ');
      persist(DiagLevel.WARN, DiagEvent.MESSAGE_RECEIVED, msg);
    },
    error: (...args) => {
      logger.error(...args);
      const msg = args.map(String).join(' ');
      persist(DiagLevel.ERROR, DiagEvent.OFFSCREEN_ERROR, msg, {
        stack: new Error().stack,
      });
    },
    /** Log recording start */
    logStart: (recordingId) => {
      logger.log('Recording started');
      persist(DiagLevel.INFO, DiagEvent.START_RECORDING, 'Recording started', {
        recordingId,
        correlationId: opts.correlationId,
      });
    },
    /** Log recording stop */
    logStop: (recordingId) => {
      logger.log('Recording stopped');
      persist(DiagLevel.INFO, DiagEvent.STOP_RECORDING, 'Recording stopped', {
        recordingId,
        correlationId: opts.correlationId,
      });
    },
    /** Log chunk save failure */
    logChunkError: (recordingId, err) => {
      logger.error('Chunk save failed:', err);
      persist(DiagLevel.ERROR, DiagEvent.SAVE_FAILED, 'Chunk save failed', {
        recordingId,
        technicalMessage: err?.message || String(err),
        stack: err?.stack,
        correlationId: opts.correlationId,
      });
    },
    /** Log state transition */
    logStateTransition: (from, to, recordingId) => {
      logger.log(`State: ${from} -> ${to}`);
      persist(DiagLevel.DEBUG, DiagEvent.STATE_TRANSITION, `State: ${from} → ${to}`, {
        recordingId,
        state: { from, to },
        correlationId: opts.correlationId,
      });
    },
  };
}
