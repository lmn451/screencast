export default {
  testEnvironment: 'jsdom',
  transform: {},
  testMatch: ['**/tests/unit/**/*.test.js'],
  collectCoverageFrom: [
    '*.js',
    '!background.js', // Requires chrome APIs
    '!popup.js', // Requires chrome APIs
    '!recorder.js', // Requires chrome APIs
    '!offscreen.js', // Requires chrome APIs
    '!recordings.js', // Requires chrome APIs
    '!preview.js', // Requires chrome APIs and DOM setup
    '!overlay.js', // Requires chrome APIs
    '!jest.config.js',
    '!*.config.js',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
    '/scripts/',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/unit/setup.js'],
};
