import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const rootDir = process.cwd();
const bgOriginal = path.join(rootDir, 'background.js');
const bgBundled = path.join(rootDir, 'build', 'background-test.js');
const bgBackup = path.join(rootDir, 'background.js.backup');

console.log('Testing: Record google.com with "Hello World"...');

if (!fs.existsSync(bgBundled)) {
  console.error('❌ Bundle not found. Run "node build/background.js" first');
  process.exit(1);
}

fs.copyFileSync(bgOriginal, bgBackup);
fs.copyFileSync(bgBundled, bgOriginal);
console.log('✓ Using bundled background.js');

let context;
let testSuccess = false;

try {
  // NOTE: Using --use-fake-device-for-media-stream creates a virtual display
  // that shows BLACK, not real content. The recording will be all black/green.
  // For real content, you need:
  // 1. A real display attached to the machine
  // 2. Run with headless:false on a real display
  // 3. Use a different approach like VNC virtual display
  
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${rootDir}`,
      `--load-extension=${rootDir}`,
      
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      
      '--disable-gpu',
      '--disable-accelerated-video-encode',
      '--disable-accelerated-video-decode',
      '--disable-software-rasterizer',
      
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  console.log('✓ Context created');

  let sw;
  const existingSWs = context.serviceWorkers();
  sw = existingSWs[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('✓ Service worker ready');

  const extensionId = sw.url().split('/')[2];
  console.log(`✓ Extension ID: ${extensionId}`);

  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/preview.html?test=1`, {
    waitUntil: 'domcontentloaded'
  });
  console.log('✓ Extension page loaded');

  // Start recording
  console.log('\n--- Starting recording ---');
  const startResult = await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false }), 10000);
      chrome.runtime.sendMessage({
        type: 'START',
        mode: 'tab',
        mic: false,
        systemAudio: false
      }, (r) => {
        clearTimeout(t);
        resolve({ ok: !!r, response: r });
      });
    });
  });

  console.log('Start:', startResult.ok ? '✓' : '❌');

  if (!startResult.ok) {
    await context.close();
    process.exit(1);
  }

  const stateResult = await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({}), 3000);
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  });

  const recordingId = stateResult.recordingId;
  console.log(`✓ Recording ID: ${recordingId}`);
  console.log(`✓ Strategy: ${stateResult.strategy}`);

  console.log('\n--- Recording interaction ---');
  const recordPage = await context.newPage();
  
  await recordPage.setViewportSize({ width: 1920, height: 1080 });
  console.log('✓ Viewport set to 1920x1080');
  
  console.log('Navigating to google.com...');
  await recordPage.goto('https://www.google.com', { waitUntil: 'networkidle', timeout: 30000 });
  console.log('✓ Page loaded');
  
  await recordPage.bringToFront();
  console.log('✓ Page brought to front');
  
  await new Promise(r => setTimeout(r, 500));
  
  console.log('Typing "Hello World"...');
  const searchBox = recordPage.locator('textarea[name="q"], input[name="q"]').first();
  const isVisible = await searchBox.isVisible().catch(() => false);
  
  if (isVisible) {
    await searchBox.click();
    await searchBox.type('Hello World', { delay: 100 });
    console.log('✓ Typed "Hello World"');
    
    await new Promise(r => setTimeout(r, 1000));
    
    await recordPage.bringToFront();
    await recordPage.keyboard.press('Enter');
    console.log('✓ Pressed Enter');
    
    await new Promise(r => setTimeout(r, 2000));
    console.log('✓ Search results loaded');
  }

  console.log('\n--- Stopping recording ---');
  await extPage.evaluate(async () => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'STOP' }, (r) => resolve(r));
    });
  });
  console.log('Stop signal sent');

  console.log('Waiting for preview page...');
  await new Promise(r => setTimeout(r, 5000));

  const previewPage = context.pages().find(p => 
    p.url().includes('preview.html') && p.url().includes('id=')
  );
  
  if (!previewPage) {
    console.log('❌ Preview page not found');
    console.log('URLs:', context.pages().map(p => p.url().substring(0, 80)));
  } else {
    console.log('✓ Preview page found');

    const previewUrl = new URL(previewPage.url());
    const idFromUrl = previewUrl.searchParams.get('id');

    console.log('\n--- Extracting WebM ---');
    
    const result = await previewPage.evaluate(async (id) => {
      const DB_NAME = 'CaptureCastDB';
      
      const db = await new Promise((resolve) => {
        const r = indexedDB.open(DB_NAME, 3);
        r.onsuccess = () => resolve(r.result);
      });

      const allRecordings = await new Promise((resolve) => {
        const tx = db.transaction('recordings', 'readonly');
        const store = tx.objectStore('recordings');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
      });
      const meta = allRecordings.find(r => r.id === id);

      const chunks = await new Promise((resolve) => {
        const tx = db.transaction('chunks', 'readonly');
        const store = tx.objectStore('chunks');
        const index = store.index('recordingId');
        const req = index.getAll(IDBKeyRange.only(id));
        req.onsuccess = () => {
          const results = req.result;
          results.sort((a, b) => a.index - b.index);
          resolve(results.map(r => r.chunk));
        };
      });

      db.close();

      if (!meta || !chunks.length) {
        return { success: false, error: !meta ? 'No metadata' : 'No chunks' };
      }

      const blob = new Blob(chunks, { type: meta.mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      
      return {
        success: true,
        mimeType: meta.mimeType,
        duration: meta.duration,
        chunkCount: chunks.length,
        blobSize: blob.size,
        data: Array.from(new Uint8Array(arrayBuffer))
      };
    }, idFromUrl);

    if (result.success) {
      const outputPath = path.join(rootDir, `google-hello-world.webm`);
      fs.writeFileSync(outputPath, Buffer.from(result.data));
      
      console.log('\n' + '='.repeat(50));
      console.log('✅ RECORDING SAVED!');
      console.log('='.repeat(50));
      console.log(`File: ${outputPath}`);
      console.log(`Duration: ${(result.duration / 1000).toFixed(2)} seconds`);
      console.log(`Size: ${(result.blobSize / 1024).toFixed(2)} KB`);
      console.log(`Type: ${result.mimeType}`);
      console.log(`Codec: ${result.mimeType.includes('vp8') ? 'VP8' : result.mimeType.includes('av01') ? 'AV1' : 'Other'}`);
      console.log('='.repeat(50));
      
      testSuccess = true;
    } else {
      console.log('❌ Extraction failed:', result.error);
    }
  }

  await context.close();

} catch (e) {
  console.error('Error:', e.message);
  if (context) await context.close();
} finally {
  if (fs.existsSync(bgBackup)) {
    fs.copyFileSync(bgBackup, bgOriginal);
    fs.unlinkSync(bgBackup);
    console.log('\n✓ Restored original background.js');
  }
}

console.log('\n' + '='.repeat(50));
console.log(testSuccess ? '✅ TEST PASSED' : '❌ TEST FAILED');
console.log('='.repeat(50));

process.exit(testSuccess ? 0 : 1);
