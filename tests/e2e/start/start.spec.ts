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

test.describe('Tab mode start functionality', () => {
  test('start recording in tab mode without audio', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

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

    const state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    expect(state?.recordingId).toBeTruthy();

    // Clean up by stopping
    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
  });

  test('start recording in tab mode with mic only', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    const startRes = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: true, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBeTruthy();

    const state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    expect(state?.recordingId).toBeTruthy();
    expect(state?.mode).toBe('tab');
    expect(state?.mic).toBe(true);
    expect(state?.systemAudio).toBe(false);

    // Clean up
    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
  });

  test('start recording in tab mode with system audio only', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    const startRes = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: true },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBeTruthy();

    const state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    expect(state?.recordingId).toBeTruthy();
    expect(state?.mode).toBe('tab');
    expect(state?.mic).toBe(false);
    expect(state?.systemAudio).toBe(true);

    // Clean up
    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
  });

  test('start recording in tab mode with both mic and system audio', async ({
    context,
    extensionId,
  }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    const startRes = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: true, systemAudio: true },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBeTruthy();

    const state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    expect(state?.recordingId).toBeTruthy();
    expect(state?.mode).toBe('tab');
    expect(state?.mic).toBe(true);
    expect(state?.systemAudio).toBe(true);

    // Clean up
    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
  });
});
