import { test, expect } from '../lib/fixtures';

function extensionPageUrl(extensionId: string) {
  return `chrome-extension://${extensionId}/preview.html?test=1`;
}

test.beforeEach(async ({ context }) => {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
});

test.describe('CDP Recording - External Message API', () => {
  test('external message START starts recording', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    const startRes = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBe(true);

    const state = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)
        )
    );
    expect(state?.status).toBe('RECORDING');
    expect(state?.recordingId).toBeTruthy();

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
  });

  test('external message STOP stops recording', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );

    const stopRes = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
    expect(stopRes?.ok).toBe(true);
  });

  test('GET_STATE returns current recording state @manual-picker', async ({
    context,
    extensionId,
  }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'screen', mic: true, systemAudio: true },
            resolve
          )
        )
    );

    const state = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)
        )
    );
    expect(state?.status).toBe('RECORDING');
    expect(state?.mode).toBe('screen');
    expect(state?.includeMic).toBe(true);
    expect(state?.includeSystemAudio).toBe(true);
    expect(state?.recording).toBe(true);

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
  });

  test('GET_LAST_RECORDING_ID returns recording ID', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );

    const result = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_LAST_RECORDING_ID' }, resolve)
        )
    );
    expect(result?.ok).toBe(true);
    expect(result?.recordingId).toBeTruthy();

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
  });

  test('START with mode=tab uses offscreen strategy when no mic', async ({
    context,
    extensionId,
  }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );

    const state = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)
        )
    );
    expect(state?.status).toBe('RECORDING');
    expect(state?.strategy).toBe('offscreen');

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
  });

  test('START with mic=true uses page strategy', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: true, systemAudio: false },
            resolve
          )
        )
    );

    const state = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)
        )
    );
    expect(state?.status).toBe('RECORDING');
    expect(state?.strategy).toBe('page');

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
  });
});

test.describe('CDP Recording - Error Handling', () => {
  test('START fails when already recording', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );

    const result = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('Already recording or saving');

    await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
  });

  test('STOP fails when not recording', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    const result = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'STOP' }, resolve)
        )
    );
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('Not recording');
  });
});

test.describe('CDP Recording - Debugger API Presence', () => {
  test('extension exposes chrome.debugger API', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    const hasDebugger = await extPage.evaluate(() => {
      return (
        typeof chrome.debugger !== 'undefined' &&
        typeof chrome.debugger.attach === 'function' &&
        typeof chrome.debugger.sendCommand === 'function' &&
        typeof chrome.debugger.onEvent?.addListener === 'function'
      );
    });
    expect(hasDebugger).toBe(true);
  });

  test('debugger can attach to extension context', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    const attachResult = await extPage.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.debugger.attach({ tabId: undefined }, '1.3', () => {
            resolve({ ok: true, error: chrome.runtime.lastError?.message });
          });
        })
    );
    expect(attachResult?.ok).toBe(true);
  });

  test('debugger.getTargets returns array of targets', async ({ context, extensionId }) => {
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    const targets = await extPage.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.debugger.getTargets((targets) => {
            resolve(targets);
          });
        })
    );

    expect(Array.isArray(targets)).toBe(true);
    expect(targets.length).toBeGreaterThan(0);
  });
});
