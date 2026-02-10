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

test.describe('Tab mode UI components', () => {
  test('preview page loads and displays video', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // Start recording
    const startRes = await controlPage.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START', mode: 'tab', mic: false, systemAudio: false }, resolve)));
    expect(startRes?.ok).toBeTruthy();

    // Get recording ID
    const state = await controlPage.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)));
    const recordingId = state.recordingId;

    // Generate and save data
    await controlPage.evaluate(async ({ recordingId }) => {
      while (!window.__TEST__?.saveChunk) await new Promise(r => setTimeout(r, 50));

      const blob = new Blob([new Uint8Array(1000)], { type: 'video/webm' });
      await window.__TEST__.saveChunk(recordingId, blob.slice(0, 500), 0);
      await window.__TEST__.finishRecording(recordingId, 'video/webm');
    }, { recordingId });

    // Trigger OFFSCREEN_DATA to open preview
    const sendDataRes = await controlPage.evaluate(({ recordingId }) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' }, resolve)), { recordingId });
    expect(sendDataRes?.ok).toBeTruthy();

    // Wait for preview tab
    const expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(recordingId)}`;
    const preview = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for preview tab')), 15000);
      const existing = context.pages().find(p => p.url().startsWith(expectedUrlPrefix));
      if (existing) { clearTimeout(timer); return resolve(existing); }
      context.on('page', p => {
        if (p.url().startsWith(expectedUrlPrefix)) { clearTimeout(timer); resolve(p); }
      });
    });

    // Verify preview elements
    await preview.waitForSelector('h1');
    expect(await preview.textContent('h1')).toBe('Recording Preview');

    await preview.waitForSelector('#video');
    const video = preview.locator('#video');
    await expect(video).toBeVisible();

    await preview.waitForSelector('#filename-input');
    const filenameInput = preview.locator('#filename-input');
    await expect(filenameInput).toBeVisible();

    await preview.waitForSelector('#btn-download');
    const downloadBtn = preview.locator('#btn-download');
    await expect(downloadBtn).toBeVisible();
    expect(await downloadBtn.textContent()).toBe('Download');
  });

  test('preview page video plays and can be controlled', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // Start and complete recording quickly
    const startRes = await controlPage.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START', mode: 'tab', mic: false, systemAudio: false }, resolve)));
    expect(startRes?.ok).toBeTruthy();

    const state = await controlPage.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)));
    const recordingId = state.recordingId;

    await controlPage.evaluate(async ({ recordingId }) => {
      while (!window.__TEST__?.saveChunk) await new Promise(r => setTimeout(r, 50));

      const blob = new Blob([new Uint8Array(1000)], { type: 'video/webm' });
      await window.__TEST__.saveChunk(recordingId, blob.slice(0, 500), 0);
      await window.__TEST__.finishRecording(recordingId, 'video/webm');
    }, { recordingId });

    const sendDataRes = await controlPage.evaluate(({ recordingId }) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' }, resolve)), { recordingId });
    expect(sendDataRes?.ok).toBeTruthy();

    const expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(recordingId)}`;
    const preview = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for preview tab')), 15000);
      const existing = context.pages().find(p => p.url().startsWith(expectedUrlPrefix));
      if (existing) { clearTimeout(timer); return resolve(existing); }
      context.on('page', p => {
        if (p.url().startsWith(expectedUrlPrefix)) { clearTimeout(timer); resolve(p); }
      });
    });

    await preview.waitForSelector('#video');
    await preview.waitForFunction(() => {
      const v = document.querySelector('video');
      return !!v && v.readyState >= 1;
    }, null, { timeout: 10000 });

    // Test video controls
    const video = preview.locator('#video');
    await video.click(); // Play
    await preview.waitForTimeout(500); // Wait a bit

    // Check if video has duration (indicating loaded)
    const duration = await video.evaluate(v => v.duration);
    expect(duration).toBeGreaterThan(0);

    // Test filename input
    const filenameInput = preview.locator('#filename-input');
    await filenameInput.fill('Test Recording');
    expect(await filenameInput.inputValue()).toBe('Test Recording');
  });
});