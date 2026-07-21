import { test, expect } from '../lib/fixtures';

type RecordingState = {
  status?: string;
  recording?: boolean;
  recordingId?: string | null;
};

const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 10_000;

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function getState(page) {
  return page.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
  );
}

async function waitForStateCondition(
  controlPage,
  label,
  condition,
  timeoutMs = WAIT_TIMEOUT_MS
) {
  const end = Date.now() + timeoutMs;
  let lastState: unknown = null;

  while (Date.now() < end) {
    try {
      const state = await getState(controlPage);
      lastState = state;
      if (condition(state)) {
        return state;
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for ${label}. Last observed state: ${safeStringify(lastState)}`
  );
}

function previewUrl(extensionId: string, recordingId: string) {
  return `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(recordingId)}`;
}

async function waitForPreviewPage(context, extensionId, recordingId, timeoutMs = WAIT_TIMEOUT_MS) {
  const expectedUrlPrefix = previewUrl(extensionId, recordingId);
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    const existing = context.pages().find((page) => page.url().startsWith(expectedUrlPrefix));
    if (existing) {
      return existing;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for preview page: ${expectedUrlPrefix}`);
}

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
    const state = await waitForStateCondition(
      controlPage,
      'recording to enter recording lifecycle state',
      (state: RecordingState) =>
        state?.status === 'starting' || state?.status === 'recording',
      WAIT_TIMEOUT_MS + 5_000
    );
    expect(state?.recording).toBe(true);
    const recordingId = state.recordingId;
    if (!recordingId) {
      throw new Error('Expected recordingId to be set after START.');
    }

    // 3. Generate and save data
    await controlPage.evaluate(
      async ({ recordingId }) => {
        while (!window.__TEST__?.saveChunk) await new Promise((r) => setTimeout(r, 50));

        // Simulate multiple chunks
        const blob = new Blob([new Uint8Array(2000)], { type: 'video/webm' });
        const chunkSize = 500;
        for (let i = 0; i < 4; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, blob.size);
          const chunk = blob.slice(start, end);
          await window.__TEST__.saveChunk(recordingId, chunk, i);
        }
        await window.__TEST__.finishRecording(recordingId, 'video/webm', 2000, blob.size);
      },
      { recordingId }
    );

    // 4. Stop recording
    const stopRes = await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
    expect(stopRes?.ok).toBeTruthy();

    await waitForStateCondition(
      controlPage,
      'recording flow to finish and create saved state',
      (state: RecordingState) => state?.status === 'saved' || state?.status === 'idle'
    );

    // 5. Wait for preview
    const preview = await waitForPreviewPage(context, extensionId, recordingId, 15_000);

    // 6. Verify preview loads without waiting for metadata readiness.
    await preview.waitForSelector('#video', { state: 'attached' });
    await preview.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return !!v && typeof (v as HTMLVideoElement).src === 'string' && v.src.length > 0;
      },
      null,
      { timeout: 10000 }
    );

    // 7. Verify the saved recording can be reconstructed from persisted chunks.
    const persistedSize = await controlPage.evaluate(async ({ recordingId }) => {
      const recording = await window.__TEST__.getRecording(recordingId);
      return recording ? recording.blob.size : 0;
    }, { recordingId });
    expect(persistedSize).toBeGreaterThan(0);
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

    await waitForStateCondition(
      controlPage,
      'first recording to enter recording lifecycle state',
      (state: RecordingState) =>
        state?.status === 'starting' || state?.status === 'recording',
      WAIT_TIMEOUT_MS + 5_000
    );

    let state = await getState(controlPage);
    const recordingId1 = state.recordingId;

    if (!recordingId1) {
      throw new Error('Expected first recordingId after START.');
    }

    await controlPage.evaluate(
      async ({ recordingId }) => {
        while (!window.__TEST__?.saveChunk) await new Promise((r) => setTimeout(r, 50));
        const blob = new Blob([new Uint8Array(1000)], { type: 'video/webm' });
        await window.__TEST__.saveChunk(recordingId, blob.slice(0, 500), 0);
        await window.__TEST__.finishRecording(recordingId, 'video/webm');
      },
      { recordingId: recordingId1 }
    );

    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );

    await waitForStateCondition(
      controlPage,
      'first recording to finish and return to idle',
      (state: RecordingState) => state?.status === 'idle'
    );

    // Wait for first preview
    await waitForPreviewPage(context, extensionId, recordingId1, 15_000);

    // Second recording
    await waitForStateCondition(
      controlPage,
      'service to return to idle before second start',
      (state: RecordingState) => state?.status === 'idle'
    );

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

    await waitForStateCondition(
      controlPage,
      'second recording to enter recording lifecycle state',
      (state: RecordingState) =>
        state?.status === 'starting' || state?.status === 'recording',
      WAIT_TIMEOUT_MS + 5_000
    );

    state = await getState(controlPage);
    const recordingId2 = state.recordingId;
    expect(recordingId2).not.toBe(recordingId1); // Different ID

    await controlPage.evaluate(
      async ({ recordingId }) => {
        while (!window.__TEST__?.saveChunk) await new Promise((r) => setTimeout(r, 50));
        const blob = new Blob([new Uint8Array(1000)], { type: 'video/webm' });
        await window.__TEST__.saveChunk(recordingId, blob.slice(0, 500), 0);
        await window.__TEST__.finishRecording(recordingId, 'video/webm');
      },
      { recordingId: recordingId2 }
    );

    await controlPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );

    await waitForStateCondition(
      controlPage,
      'second recording to finish and return to idle',
      (state: RecordingState) => state?.status === 'idle'
    );

    // Wait for second preview
    const preview2 = await waitForPreviewPage(context, extensionId, recordingId2, 15_000);

    await preview2.waitForSelector('#video', { state: 'attached' });
    await expect(preview2.locator('#video')).toHaveAttribute('src', /^blob:/);
  });
});
