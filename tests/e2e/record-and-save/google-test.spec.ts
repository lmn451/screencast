/**
 * E2E Test: Google.com - Type hello world
 * Uses getDisplayMedia to capture actual page content
 */
import { test, expect } from '../lib/fixtures';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, '../../..', 'recordings-output');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

test('google.com - type hello world', async ({ context }) => {
  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `google-${timestamp}.webm`);
  
  console.log(`
========================================
 Google.com Test - Type "hello world"
========================================
Output: ${outputPath}
========================================
`);

  const page = await context.newPage();
  
  console.log('[1/7] Navigating to google.com...');
  await page.goto('https://www.google.com');
  await page.waitForLoadState('networkidle');
  console.log('[2/7] Page loaded');

  // Inject recording with getDisplayMedia (captures actual viewport)
  console.log('[3/7] Starting getDisplayMedia recording...');
  
  const result = await page.evaluate(async () => {
    // Use getDisplayMedia to capture the actual browser viewport
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { 
        displaySurface: 'browser',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
    
    console.log('[Page] Got stream, tracks:', stream.getVideoTracks().length);
    console.log('[Page] Track settings:', stream.getVideoTracks()[0].getSettings());
    
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    
    window.__recorder = new MediaRecorder(stream, { mimeType });
    window.__recChunks = [];
    window.__recMimeType = mimeType;
    
    window.__recorder.ondataavailable = (e) => {
      if (e.data.size > 0) window.__recChunks.push(e.data);
      console.log('[Page] Chunk:', e.data.size, 'total chunks:', window.__recChunks.length);
    };
    
    window.__recorder.start(200);
    console.log('[Page] Recording started, mimeType:', mimeType);
    
    return { mimeType, tracks: stream.getVideoTracks().length };
  });

  console.log('[4/7] Recording started:', result);

  // Type hello world
  console.log('[5/7] Typing "hello world"...');
  
  try {
    const searchBox = page.locator('input[name="q"]').first();
    await searchBox.click({ timeout: 5000 });
    await searchBox.fill('hello world');
    console.log('[5/7] Typed in Google search box');
  } catch (e) {
    console.log('[5/7] Click failed, trying keyboard:', e.message);
    await page.keyboard.press('/');
    await page.waitForTimeout(500);
    await page.keyboard.type('hello world');
    console.log('[5/7] Typed using keyboard');
  }

  // Wait to see result
  console.log('[6/7] Waiting for page to update...');
  await page.waitForTimeout(3000);
  
  // Take screenshot
  const screenshotPath = path.join(OUTPUT_DIR, `google-${timestamp}.png`);
  await page.screenshot({ path: screenshotPath });
  console.log('[6/7] Screenshot:', screenshotPath);

  // Stop recording
  console.log('[7/7] Stopping recording...');
  
  const videoBase64 = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const recorder = window.__recorder;
      
      recorder.onstop = () => {
        const blob = new Blob(window.__recChunks, { type: window.__recMimeType });
        console.log('[Page] Blob size:', blob.size, 'chunks:', window.__recChunks.length);
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      };
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) window.__recChunks.push(e.data);
      };
      
      recorder.requestData();
      recorder.stop();
      
      // Stop all tracks
      recorder.stream.getTracks().forEach(t => t.stop());
    });
  });

  // Save video
  const base64Data = videoBase64.split(',')[1];
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(outputPath, buffer);
  
  expect(fs.existsSync(outputPath)).toBeTruthy();
  const stats = fs.statSync(outputPath);
  console.log('[7/7] Video size:', stats.size);
  expect(stats.size).toBeGreaterThan(1000);

  await page.close();

  console.log(`
========================================
✅ SUCCESS!
   
   Video: ${path.basename(outputPath)}
   Size: ${(buffer.length / 1024).toFixed(2)} KB
   
   Screenshot: ${path.basename(screenshotPath)}
   
   Play: open "${outputPath}"
========================================
`);
});
