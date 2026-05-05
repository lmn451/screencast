import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const rootDir = process.cwd();
const bgOriginal = path.join(rootDir, 'background.js');
const bgBundled = path.join(rootDir, 'build', 'background-test.js');
const bgBackup = path.join(rootDir, 'background.js.backup');

console.log('Testing: Real desktop capture...');

fs.copyFileSync(bgOriginal, bgBackup);
fs.copyFileSync(bgBundled, bgOriginal);

let context;
let testSuccess = false;

try {
  // DON'T use fake device flags - use real desktop capture
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${rootDir}`,
      `--load-extension=${rootDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Auto-select desktop capture source (first available)
      '--auto-select-desktop-capture-source=Entire Screen',
      '--allow-running-insecure-content',
    ],
  });

  console.log('✓ Context created');

  let sw;
  const existingSWs = context.serviceWorkers();
  sw = existingSWs[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('✓ Service worker ready');

  const extensionId = sw.url().split('/')[2];

  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/preview.html?test=1`);

  // Start recording with display mode instead of tab
  console.log('\n--- Starting recording ---');
  const startResult = await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false }), 10000);
      chrome.runtime.sendMessage({
        type: 'START',
        mode: 'screen', // Use screen mode for real capture
        mic: false,
        systemAudio: false
      }, (r) => {
        clearTimeout(t);
        resolve({ ok: !!r, response: r });
      });
    });
  });

  console.log('Start:', startResult.ok ? '✓' : '❌', startResult.response);

  if (!startResult.ok) {
    await context.close();
    process.exit(1);
  }

  // Get recording ID
  const state = await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => resolve(r));
    });
  });
  console.log('Recording ID:', state.recordingId);
  console.log('Strategy:', state.strategy);

  // Wait for recording
  const recordPage = await context.newPage();
  await recordPage.setViewportSize({ width: 1920, height: 1080 });
  await recordPage.goto('https://www.google.com');
  await recordPage.bringToFront();
  await new Promise(r => setTimeout(r, 5000));

  // Stop recording
  await extPage.evaluate(async () => {
    chrome.runtime.sendMessage({ type: 'STOP' }, () => {});
  });

  await new Promise(r => setTimeout(r, 5000));

  const previewPage = context.pages().find(p => 
    p.url().includes('preview.html') && p.url().includes('id=')
  );

  if (previewPage) {
    const idFromUrl = new URL(previewPage.url()).searchParams.get('id');

    const result = await previewPage.evaluate(async (id) => {
      const DB_NAME = 'CaptureCastDB';
      const db = await new Promise((resolve) => {
        const r = indexedDB.open(DB_NAME, 3);
        r.onsuccess = () => resolve(r.result);
      });

      const allRecordings = await new Promise((resolve) => {
        const tx = db.transaction('recordings', 'readonly');
        tx.objectStore('recordings').getAll().onsuccess = () => resolve(tx.objectStore('recordings').result);
      });
      const meta = allRecordings.find(r => r.id === id);

      const chunks = await new Promise((resolve) => {
        const tx = db.transaction('chunks', 'readonly');
        const store = tx.objectStore('chunks');
        const index = store.index('recordingId');
        index.getAll(IDBKeyRange.only(id)).onsuccess = () => {
          const results = index.result;
          results.sort((a, b) => a.index - b.index);
          resolve(results.map(r => r.chunk));
        };
      });

      db.close();
      if (!meta || !chunks.length) return { success: false };

      const blob = new Blob(chunks, { type: meta.mimeType });
      return {
        success: true,
        mimeType: meta.mimeType,
        duration: meta.duration,
        blobSize: blob.size,
        data: Array.from(new Uint8Array(await blob.arrayBuffer()))
      };
    }, idFromUrl);

    if (result.success) {
      const outputPath = path.join(rootDir, 'real-capture.webm');
      fs.writeFileSync(outputPath, Buffer.from(result.data));
      console.log('\n✅ RECORDING SAVED!');
      console.log('File:', outputPath);
      console.log('Codec:', result.mimeType);
      console.log('Duration:', result.duration, 'ms');
      console.log('Size:', result.blobSize, 'bytes');
      testSuccess = true;
    }
  }

  await context.close();

} catch (e) {
  console.error('Error:', e.message);
  if (context) await context.close();
} finally {
  fs.copyFileSync(bgBackup, bgOriginal);
  fs.unlinkSync(bgBackup);
}

process.exit(testSuccess ? 0 : 1);
