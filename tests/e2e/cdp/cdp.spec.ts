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

test.describe('CDP Recording - Video Capture', () => {
  test('can extract recorded video from IndexedDB @manual-picker', async ({
    context,
    extensionId,
  }) => {
    // Uses popup UI which requires user gesture for tabCapture
    // tabCapture requires isTrusted: true which Playwright cannot provide
    // 1. Create a content page to record
    const contentPage = await context.newPage();
    await contentPage.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="background: linear-gradient(135deg, #667eea, #764ba2); padding: 40px;">
          <h1 style="color: white;">Recording Test</h1>
          <input id="testInput" placeholder="Type here..." />
          <button id="btn">Click me</button>
        </body>
      </html>
    `);

    // 2. Open extension popup and click Record
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

    // Get extension page for state checks
    const extPage = await context.newPage();
    await extPage.goto(extensionPageUrl(extensionId));

    // Check state before
    const stateBefore = await extPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    console.log('State BEFORE click:', JSON.stringify(stateBefore));

    // Click record button
    await popupPage.locator('#btn-tab').click();
    await popupPage.waitForTimeout(2000);

    // Check state after
    const stateAfter = await extPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
    );
    console.log('State AFTER click:', JSON.stringify(stateAfter));
    console.log('Strategy:', stateAfter?.strategy, 'Status:', stateAfter?.status);

    // 3. Perform actions on content page
    await contentPage.bringToFront();
    await contentPage.locator('#testInput').fill('Hello World');
    await contentPage.locator('#btn').click();
    await contentPage.waitForTimeout(2000);

    // 4. Stop recording
    await extPage.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'STOP' }, resolve))
    );
    await extPage.waitForTimeout(1000);

    // 5. Get recording ID
    const result = await extPage.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'GET_LAST_RECORDING_ID' }, resolve)
        )
    );

    console.log('Recording ID:', result?.recordingId);

    // Check chunks
    if (result?.recordingId) {
      const chunkCount = await extPage.evaluate(async (id) => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('CaptureCastDB', 3);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['chunks'], 'readonly');
            const store = tx.objectStore('chunks');
            const index = store.index('recordingId');
            const getReq = index.getAll(id);
            getReq.onsuccess = () => resolve(getReq.result?.length || 0);
            getReq.onerror = () => reject(new Error('Failed'));
          };
          request.onerror = () => reject(new Error('Failed to open DB'));
        });
      }, result.recordingId);

      console.log('Chunk count:', chunkCount);
      expect(chunkCount).toBeGreaterThan(0);
    }

    expect(result?.ok).toBe(true);
  });
});
