// Centralized logging utility for CaptureCast
// In production, only warnings and errors are shown

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
