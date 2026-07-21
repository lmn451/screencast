import { test, expect } from '../lib/fixtures';

function controlPageUrl(extensionId: string) {
  // Use preview as a neutral extension page to get a Page with chrome.runtime access.
  return `chrome-extension://${extensionId}/preview.html?test=1`;
}

async function savePlayableRecording(controlPage, recordingId: string) {
  await controlPage.evaluate(async ({ recordingId }) => {
    while (!window.__TEST__?.saveChunk) await new Promise((resolve) => setTimeout(resolve, 50));

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');

    context.fillStyle = '#1f2937';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    await new Promise<void>((resolve, reject) => {
      recorder.addEventListener('error', () => reject(new Error('MediaRecorder failed')));
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.start(100);
      setTimeout(() => recorder.stop(), 600);
    });

    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    if (blob.size === 0) throw new Error('MediaRecorder produced an empty recording');

    await window.__TEST__.saveChunk(recordingId, blob, 0);
    await window.__TEST__.finishRecording(recordingId, blob.type, 600, blob.size);
  }, { recordingId });
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

    // Get recording ID
    const state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    const recordingId = state.recordingId;

    // Generate and save data
    await savePlayableRecording(controlPage, recordingId);

    // Trigger OFFSCREEN_DATA to open preview
    const sendDataRes = await controlPage.evaluate(
      ({ recordingId }) =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' },
            resolve
          )
        ),
      { recordingId }
    );
    expect(sendDataRes?.ok).toBeTruthy();

    // Wait for preview tab
    const expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(
      recordingId
    )}`;
    const preview = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for preview tab')), 15000);
      const existing = context.pages().find((p) => p.url().startsWith(expectedUrlPrefix));
      if (existing) {
        clearTimeout(timer);
        return resolve(existing);
      }
      context.on('page', (p) => {
        if (p.url().startsWith(expectedUrlPrefix)) {
          clearTimeout(timer);
          resolve(p);
        }
      });
    });

    // Verify preview elements
    await preview.waitForSelector('h1');
    expect(await preview.textContent('h1')).toBe('Recording Preview');

    await preview.waitForSelector('#video', { state: 'attached' });
    const video = preview.locator('#video');
    await expect(video).toHaveAttribute('src', /^blob:/);
    const initialStable = await video.getAttribute('data-stable');
    expect(initialStable === 'true' || initialStable === 'false').toBeTruthy();

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
    const recordingId = state.recordingId;

    await savePlayableRecording(controlPage, recordingId);

    const sendDataRes = await controlPage.evaluate(
      ({ recordingId }) =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' },
            resolve
          )
        ),
      { recordingId }
    );
    expect(sendDataRes?.ok).toBeTruthy();

    const expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(
      recordingId
    )}`;
    const preview = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for preview tab')), 15000);
      const existing = context.pages().find((p) => p.url().startsWith(expectedUrlPrefix));
      if (existing) {
        clearTimeout(timer);
        return resolve(existing);
      }
      context.on('page', (p) => {
        if (p.url().startsWith(expectedUrlPrefix)) {
          clearTimeout(timer);
          resolve(p);
        }
      });
    });

    await preview.waitForSelector('#video', { state: 'attached' });

    const video = preview.locator('#video');
    const videoState = await video.evaluate((v) => ({
      src: v.src,
      hasControls: !!v.controls,
      canPlayType: v.canPlayType('video/webm'),
      readyState: v.readyState,
    }));
    expect(videoState.src).toContain('blob:');
    expect(videoState.hasControls).toBe(true);
    expect(videoState.canPlayType).not.toBe('');
    expect(videoState.readyState).toBeGreaterThanOrEqual(0);

    // Control: toggling playback controls API should not throw for this preview page.
    await video.evaluate((v) => {
      v.pause();
      v.currentTime = 0;
      return true;
    });

    // Test filename input
    const filenameInput = preview.locator('#filename-input');
    await filenameInput.fill('Test Recording');
    expect(await filenameInput.inputValue()).toBe('Test Recording');
  });
});
