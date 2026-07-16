import { jest } from '@jest/globals';

let capturedListener;

beforeEach(() => {
  jest.resetModules();
  capturedListener = null;
  global.chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: jest.fn(async () => undefined),
      onMessage: {
        addListener: jest.fn((listener) => {
          capturedListener = listener;
        }),
      },
    },
  };
});

afterEach(() => {
  delete global.chrome;
});

it('rejects recorder commands from an unauthorized sender', async () => {
  await import('../../src/entries/recorder.js');

  const sendResponse = jest.fn();
  const result = capturedListener(
    { type: 'RECORDER_STOP' },
    { id: 'rogue-extension' },
    sendResponse
  );

  expect(result).toBe(false);
  expect(sendResponse).not.toHaveBeenCalled();
});
