import { test, expect } from '../lib/fixtures';
import type { BrowserContext, Page } from '@playwright/test';

async function installSyntheticCapture(context: BrowserContext) {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getDisplayMedia = async () => {
      const options = await chrome.storage.local.get(['reviewHoldPicker', 'reviewDenyPicker']);
      if (options.reviewDenyPicker) {
        throw new DOMException('Synthetic picker denial', 'NotAllowedError');
      }
      if (options.reviewHoldPicker) {
        await new Promise<void>((resolve) => {
          (window as any).resolveReviewPicker = resolve;
        });
      }
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 100;
      const drawing = canvas.getContext('2d')!;
      drawing.fillRect(0, 0, 200, 100);
      setInterval(() => drawing.fillRect(0, 0, 200, 100), 100);
      return canvas.captureStream(10);
    };
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  });
}

async function start(control: Page, mic = true) {
  return control.evaluate(
    (mic) => chrome.runtime.sendMessage({ type: 'START', mode: 'tab', mic, systemAudio: false }),
    mic
  );
}

async function state(control: Page) {
  return control.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
}

async function stopAndSave(control: Page) {
  expect(await control.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }))).toMatchObject({
    ok: true,
  });
  await expect.poll(async () => (await state(control)).status).toMatch(/^(saved|idle)$/);
}

test.beforeEach(async ({ context }) => {
  await installSyntheticCapture(context);
});

for (const restart of [false, true]) {
  test(`cancelling a pending picker ${
    restart ? 'after worker restart ' : ''
  }closes its recorder and permits a fresh recording`, async ({ context, extensionId }) => {
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/consent.html`);
    await control.evaluate(() => chrome.storage.local.set({ reviewHoldPicker: true }));
    const opened = context.waitForEvent('page');
    expect(await start(control)).toMatchObject({ ok: true });
    const recorder = await opened;
    await recorder.waitForFunction(() => typeof (window as any).resolveReviewPicker === 'function');
    expect((await state(control)).status).toBe('starting');

    if (restart) {
      const before = await state(control);
      await expect
        .poll(() =>
          control.evaluate(
            async () => (await chrome.storage.local.get('sessionSnapshot')).sessionSnapshot
          )
        )
        .toMatchObject({
          recordingId: before.recordingId,
          status: 'starting',
          recorderTabId: expect.any(Number),
        });
      const cdp = await context.newCDPSession(control);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await cdp.detach();
    }

    expect(
      await control.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }))
    ).toMatchObject({
      ok: true,
    });
    await expect.poll(() => recorder.isClosed()).toBe(true);
    expect((await state(control)).status).toBe('idle');

    await control.evaluate(() => chrome.storage.local.set({ reviewHoldPicker: false }));
    expect(await start(control)).toMatchObject({ ok: true });
    await expect.poll(async () => (await state(control)).status).toBe('recording');
    await stopAndSave(control);
  });
}

for (const mic of [true, false]) {
  test(`a GET_STATE wake restores a live ${
    mic ? 'page' : 'offscreen'
  } recording after worker termination`, async ({ context, extensionId }) => {
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/consent.html`);
    expect(await start(control, mic)).toMatchObject({ ok: true });
    await expect.poll(async () => (await state(control)).status).toBe('recording');
    const before = await state(control);
    await expect
      .poll(() =>
        control.evaluate(
          async () => (await chrome.storage.local.get('sessionSnapshot')).sessionSnapshot
        )
      )
      .toMatchObject({ recordingId: before.recordingId, status: 'recording' });

    const cdp = await context.newCDPSession(control);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();

    const restored = await state(control);
    expect(restored).toMatchObject({ status: 'recording', recordingId: before.recordingId });
    await stopAndSave(control);
  });
}

test('screen permission denial permits retry without restarting the extension', async ({
  context,
  extensionId,
}) => {
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/consent.html`);
  await control.evaluate(() => chrome.storage.local.set({ reviewDenyPicker: true }));
  await start(control);
  await expect.poll(async () => (await state(control)).status).toMatch(/^(idle|failed)$/);
  await control.evaluate(() => chrome.storage.local.set({ reviewDenyPicker: false }));
  expect(await start(control)).toMatchObject({ ok: true });
  await expect.poll(async () => (await state(control)).status).toBe('recording');
  await stopAndSave(control);
});
