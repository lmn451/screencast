import { test, expect } from '../lib/fixtures';

test('STOP reclaims and saves an offscreen recording when it wakes the worker', async ({
  context,
  extensionId,
}) => {
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/consent.html`);
  expect(
    await control.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'START', mode: 'tab', mic: false, systemAudio: false })
    )
  ).toMatchObject({ ok: true });
  await expect
    .poll(() => control.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' })))
    .toMatchObject({ status: 'recording' });
  const before = await control.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
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

  // Send STOP before any GET_STATE/heartbeat can deliberately restore the
  // session. A fresh idle worker must reclaim the live capture itself.
  expect(await control.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }))).toMatchObject({
    ok: true,
  });
  await expect
    .poll(() =>
      context.pages().some((page) => page.url().includes(`preview.html?id=${before.recordingId}`))
    )
    .toBe(true);
});
