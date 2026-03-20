// Centralized logging utility for CaptureCast
// In production, only warnings and errors are shown

// Detect debug mode from extension manifest or URL parameter
// Note: In MV3, content_security_policy is an object like { extension_pages: "..." }
const manifestCSP = chrome.runtime?.getManifest?.()?.content_security_policy;
const cspString = typeof manifestCSP === 'string' 
  ? manifestCSP 
  : typeof manifestCSP === 'object' && manifestCSP !== null
    ? manifestCSP['extension_pages'] || ''
    : '';
const isDev = cspString.includes('unsafe-eval') === true;

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
