export default {
  testEnvironment: 'jsdom',
  transform: {
    // Transform TS sources imported from .test.js files so we can unit-test
    // src/machines/recordingMachine.ts and src/services/recordingService.ts
    // directly. .js files are passed through unmodified (no transform).
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: false },
          target: 'es2022',
        },
        module: { type: 'es6' },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // XState v5 source files import sibling .ts files via "./foo.js" specifiers.
    // Strip the .js so swc-jest can resolve them to .ts on disk.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/tests/unit/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    '!src/entries/**', // Entry points require chrome APIs / DOM
    '!src/background.ts', // Service worker; covered by E2E
    '!**/*.d.ts',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/', '/scripts/', '/dist/', '/.specstory/'],
  setupFilesAfterEnv: ['<rootDir>/tests/unit/setup.js'],
};
