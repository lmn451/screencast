import { test, expect, generateWebmBlobInPage } from '../lib/fixtures';

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

test.describe('Tab mode data management', () => {
  test('full recording lifecycle: start, record, stop, preview', async ({
    context,
    extensionId,
  }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // 1. Start recording
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

    // 2. Verify recording state
    let state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    expect(state?.recording).toBe(true);
    const recordingId = state.recordingId;

    // 3. Generate and save data
    const generated = await generateWebmBlobInPage(controlPage);
    await controlPage.evaluate(
      async ({ recordingId, generated }) => {
        while (!window.__TEST__?.saveChunk) await new Promise((r) => setTimeout(r, 50));

        // Simulate multiple chunks from a valid WebM recording
        const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.type });
        const chunkSize = Math.ceil(blob.size / 4);
        for (let i = 0; i < 4; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, blob.size);
          const chunk = blob.slice(start, end);
          await window.__TEST__.saveChunk(recordingId, chunk, i);
        }
        await window.__TEST__.finishRecording(recordingId, 'video/webm', 700, blob.size);
      },
      { recordingId, generated }
    );

    // 4. Stop recording
    const stopRes = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
    expect(stopRes?.ok).toBeTruthy();

    // 5. Wait for preview
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

    // 6. Verify preview loads
    await preview.waitForSelector('#video');
    await preview.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return !!v && v.readyState >= 1;
      },
      null,
      { timeout: 10000 }
    );

    // 7. Verify video duration (from metadata)
    const duration = await preview.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.duration : 0;
    });
    expect(duration).toBeGreaterThan(0);
  });

  test('multiple recordings in sequence', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // First recording
    let startRes = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBeTruthy();

    let state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    const recordingId1 = state.recordingId;

    const generated1 = await generateWebmBlobInPage(controlPage);
    await controlPage.evaluate(
      async ({ recordingId, generated }) => {
        while (!window.__TEST__?.saveChunk) await new Promise((r) => setTimeout(r, 50));
        const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.type });
        await window.__TEST__.saveChunk(recordingId, blob, 0);
        await window.__TEST__.finishRecording(recordingId, 'video/webm');
      },
      { recordingId: recordingId1, generated: generated1 }
    );

    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );

    // Wait for first preview
    let expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(
      recordingId1
    )}`;
    await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for first preview')),
        15000
      );
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

    await expect
      .poll(async () => {
        const current = await controlPage.evaluate(
          () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
        );
        return current?.status;
      })
      .toBe('idle');

    // Second recording
    startRes = await controlPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage(
            { type: 'START', mode: 'tab', mic: false, systemAudio: false },
            resolve
          )
        )
    );
    expect(startRes?.ok).toBeTruthy();

    state = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    const recordingId2 = state.recordingId;
    expect(recordingId2).not.toBe(recordingId1); // Different ID

    const generated2 = await generateWebmBlobInPage(controlPage);
    await controlPage.evaluate(
      async ({ recordingId, generated }) => {
        while (!window.__TEST__?.saveChunk) await new Promise((r) => setTimeout(r, 50));
        const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.type });
        await window.__TEST__.saveChunk(recordingId, blob, 0);
        await window.__TEST__.finishRecording(recordingId, 'video/webm');
      },
      { recordingId: recordingId2, generated: generated2 }
    );

    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );

    // Wait for second preview
    expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(
      recordingId2
    )}`;
    const preview2 = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for second preview')),
        15000
      );
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

    await preview2.waitForSelector('#video');
  });
});
