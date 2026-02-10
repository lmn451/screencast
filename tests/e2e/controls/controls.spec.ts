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

test.describe('Tab mode recording controls', () => {
  test('stop recording via STOP message after short delay', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // Start recording
    const startRes = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBeTruthy();

    // Wait a bit
    await new Promise((r) => setTimeout(r, 2000));

    // Stop via message
    const stopRes = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
    expect(stopRes?.ok).toBeTruthy();

    // Verify state is idle
    const state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    expect(state?.recording).toBe(false);
  });
});
