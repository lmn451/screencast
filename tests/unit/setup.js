// Jest setup file for unit tests

// Mock chrome APIs globally for tests
global.chrome = {
  runtime: {
    id: "test-extension-id",
    getURL: (path) => `chrome-extension://test-extension-id/${path}`,
  },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  },
};

// Mock IndexedDB if needed
global.indexedDB = {
  open: () => ({}),
};

// Polyfill structuredClone for Node environments where it's not available.
// Keep it minimal for tests: pass-through for Blob and JSON-clone for plain objects.
if (typeof structuredClone === "undefined") {
  global.structuredClone = (value) => {
    // Deep-clone simple structures while preserving Blobs and ArrayBuffers
    const _clone = (v) => {
      if (v === null || typeof v !== "object") return v;
      if (typeof Blob !== "undefined" && v instanceof Blob) return v;
      if (v instanceof ArrayBuffer) return v.slice(0);
      if (Array.isArray(v)) return v.map(_clone);
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = _clone(v[k]);
      }
      return out;
    };
    try {
      return _clone(value);
    } catch (e) {
      return value;
    }
  };
}

// Suppress console logs during tests unless explicitly needed
const noop = () => {};
global.console = {
  ...console,
  log: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
