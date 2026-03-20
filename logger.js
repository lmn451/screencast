// Centralized logging utility for CaptureCast
// In production, only warnings and errors are shown

// Detect debug mode from extension manifest or URL parameter
const isDev =
  typeof chrome !== 'undefined' &&
  chrome.runtime?.getManifest?.()?.content_security_policy?.includes('unsafe-eval') === true;

const DEBUG = isDev || new URLSearchParams(globalThis.location?.search).get('debug') === '1';

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
