import { test, expect } from '../lib/fixtures';

function controlPageUrl(extensionId: string) {
  // Use preview as a neutral extension page to get a Page with chrome.runtime access.
  return `chrome-extension://${extensionId}/preview.html?test=1`;
}

test.beforeEach(async ({ context }) => {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  // chrome.storage.local.clear removed as permission is revoked
});

test.describe('Tab mode error handling', () => {
  test('start recording while already recording fails', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // Start first recording
    const startRes1 = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes1?.ok).toBeTruthy();

    // Try to start second recording
    const startRes2 = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes2?.ok).toBe(false);
    expect(startRes2?.error).toContain('Already recording');

    // Clean up
    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
  });

  test('stop recording when not recording fails', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // Try to stop without starting
    const stopRes = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
    expect(stopRes?.ok).toBe(false);
    expect(stopRes?.error).toContain('Not recording');
  });

  test('invalid message type returns error', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    const invalidRes = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'INVALID_TYPE' }, resolve))
    );
    expect(invalidRes?.ok).toBe(false);
    expect(invalidRes?.error).toContain('Unknown message');
  });
});
