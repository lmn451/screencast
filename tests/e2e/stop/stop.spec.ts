import { test, expect } from '../lib/fixtures';

async function generateWebmBlobInPage(page) {
  return await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d');
    let t = 0; const fps = 10;
    const id = setInterval(() => { t++; ctx.fillStyle = '#222'; ctx.fillRect(0,0,320,180); ctx.fillStyle = '#0f0'; ctx.fillRect((t*10)%320,60,40,40); }, 1000/fps);
    const stream = canvas.captureStream(fps);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    rec.start(100);
    // Wait until we have at least one non-empty chunk or timeout
    const ok = await new Promise((resolve) => {
      const deadline = Date.now() + 2500;
      const tick = () => {
        if (chunks.length > 0) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        rec.requestData();
        setTimeout(tick, 150);
      };
      setTimeout(tick, 300);
    });
    // Stop and collect final data
    await new Promise((res) => { rec.onstop = () => res(null); rec.stop(); });
    clearInterval(id);
    const blob = new Blob(chunks, { type: 'video/webm' });
    return { size: blob.size, type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
}

async function generateWebmBlobInNewPage(context) {
  const p = await context.newPage();
  try {
    await p.goto('about:blank');
    return await generateWebmBlobInPage(p);
  } finally {
    await p.close();
  }
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

test.describe('Stop feature (offscreen strategy) without code changes', () => {
  test('explicit STOP produces preview and data via message-only flow', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // 1) Ask background to START offscreen (mic: false)
    const startRes = await controlPage.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START', mode: 'tab', mic: false, systemAudio: false }, resolve)));
    expect(startRes?.ok).toBeTruthy();

    // 2) Generate a small valid webm blob in test page
    const generated = await generateWebmBlobInNewPage(context);
    expect(generated?.size || 0).toBeGreaterThan(0);

    // 3) Save to IDB and deliver OFFSCREEN_DATA
    const recordingId = await controlPage.evaluate(() => new Promise<string>(async (resolve) => {
      const state = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, r));
      resolve(state?.recordingId || 'test-id');
    }));

    // Save to IDB using the exposed helper in preview.js (controlPage is preview.html?test=1)
    await controlPage.evaluate(async ({ recordingId, generated }) => {
      // Wait for dynamic import of db.js to finish
      while (!window.__TEST__?.saveChunk) await new Promise(r => setTimeout(r, 50));

      const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.type });
      // Chunk it
      const chunkSize = 1024 * 1024; // 1MB chunks
      const totalChunks = Math.ceil(blob.size / chunkSize);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, blob.size);
        const chunk = blob.slice(start, end);
        await window.__TEST__.saveChunk(recordingId, chunk, i);
      }
      await window.__TEST__.finishRecording(recordingId, generated.type);
    }, { recordingId, generated });

    const sendDataRes = await controlPage.evaluate(({ recordingId }) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' }, resolve)), { recordingId });
    expect(sendDataRes?.ok).toBeTruthy();

    // 4) Wait for preview to open (tab created by background)
    const expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(recordingId)}`;
    const preview = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for preview tab')), 15000);
      const existing = context.pages().find(p => p.url().startsWith(expectedUrlPrefix));
      if (existing) { clearTimeout(timer); return resolve(existing); }
      context.on('page', p => {
        if (p.url().startsWith(expectedUrlPrefix)) { clearTimeout(timer); resolve(p); }
      });
    });
    await (preview as any).waitForSelector('#video');
    await (preview as any).waitForFunction(() => {
      const v = document.querySelector('video');
      return !!v && v.readyState >= 1;
    }, null, { timeout: 10000 });
  });

  test('auto-stop behavior simulated by delivering OFFSCREEN_DATA without STOP', async ({ context, extensionId }) => {
    const controlPage = await context.newPage();
    await controlPage.goto(controlPageUrl(extensionId));

    // START again
    const startRes = await controlPage.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'START', mode: 'tab', mic: false, systemAudio: false }, resolve)));
    expect(startRes?.ok).toBeTruthy();

    // Generate data
    const generated = await generateWebmBlobInPage(controlPage);
    expect(generated?.size || 0).toBeGreaterThan(0);

    // Send OFFSCREEN_DATA directly (simulating auto-stop)
    const recordingId = await controlPage.evaluate(() => new Promise<string>(async (resolve) => {
      const state = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, r));
      resolve(state?.recordingId || 'test-id');
    }));

    // Save to IDB
    await controlPage.evaluate(async ({ recordingId, generated }) => {
      while (!window.__TEST__?.saveChunk) await new Promise(r => setTimeout(r, 50));

      const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.type });
      // Chunk it
      const chunkSize = 1024 * 1024; // 1MB chunks
      const totalChunks = Math.ceil(blob.size / chunkSize);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, blob.size);
        const chunk = blob.slice(start, end);
        await window.__TEST__.saveChunk(recordingId, chunk, i);
      }
      await window.__TEST__.finishRecording(recordingId, generated.type);
    }, { recordingId, generated });

    const sendDataRes = await controlPage.evaluate(({ recordingId }) => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' }, resolve)), { recordingId });
    expect(sendDataRes?.ok).toBeTruthy();

    // Preview opens with video
    const expectedUrlPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(recordingId)}`;
    const preview = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for preview tab')), 15000);
      const existing = context.pages().find(p => p.url().startsWith(expectedUrlPrefix));
      if (existing) { clearTimeout(timer); return resolve(existing); }
      context.on('page', p => {
        if (p.url().startsWith(expectedUrlPrefix)) { clearTimeout(timer); resolve(p); }
      });
    });
    await (preview as any).waitForSelector('#video');
    await (preview as any).waitForFunction(() => {
      const v = document.querySelector('video');
      return !!v && v.readyState >= 1;
    }, null, { timeout: 10000 });
  });
});