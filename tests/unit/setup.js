// Jest setup file for unit tests

// Mock chrome APIs globally for tests
global.chrome = {
  runtime: {
    id: 'test-extension-id',
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
