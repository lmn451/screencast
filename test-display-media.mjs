/**
 * E2E Test: Record browser content using getDisplayMedia
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const rootDir = process.cwd();
const OUTPUT_DIR = path.join(rootDir, 'recordings-output');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function runTest() {
  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `google-${timestamp}.webm`);
  const screenshotPath = path.join(OUTPUT_DIR, `google-${timestamp}.png`);

  console.log(`Output: ${outputPath}`);

  let context;
  try {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Auto-grant getDisplayMedia permission
        '--auto-select-desktop-capture-source=Entire Screen',
        '--use-fake-ui-for-media-stream',
      ],
    });

    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    console.log('[1] Navigating to google.com...');
    await page.goto('https://www.google.com');
    await page.waitForLoadState('networkidle');

    // Start getDisplayMedia
    console.log('[2] Starting getDisplayMedia...');
    
    let displaySurface = 'unknown';
    
    // Set up recorder and store on window
    console.log('[2] Setting up recorder...');
    
    try {
      await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: 'browser',
          },
          audio: false,
        });
        
        console.log('[Page] Stream started');
        
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
          ? 'video/webm;codecs=vp8'
          : 'video/webm';
        
        // Store on window for later access
        window.__recStream = stream;
        window.__recMimeType = mimeType;
        window.__recChunks = [];
        window.__recorder = new MediaRecorder(stream, { mimeType });
        
        window.__recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            window.__recChunks.push(e.data);
          }
        };
        
        window.__recorder.start(100);
        console.log('[Page] Recording started');
      });
      
      displaySurface = await page.evaluate(() => {
        return window.__recStream?.getVideoTracks()[0]?.getSettings()?.displaySurface || 'unknown';
      });
      
    } catch (e) {
      console.error('[2] getDisplayMedia failed:', e.message);
      return false;
    }

    console.log(`[3] Recording (${displaySurface})...`);

    // Type hello world
    console.log('[4] Typing "hello world"...');
    try {
      await page.locator('input[name="q"]').first().fill('hello world');
    } catch (e) {
      await page.keyboard.type('hello world');
    }
    await page.waitForTimeout(2000);

    // Screenshot
    await page.screenshot({ path: screenshotPath });
    console.log('[5] Screenshot saved');

    // Stop recording
    console.log('[6] Stopping recording...');
    
    const videoResult = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const recorder = window.__recorder;
        const chunks = window.__recChunks;
        const mimeType = window.__recMimeType;
        const stream = window.__recStream;
        
        if (!recorder) {
          resolve({ success: false, error: 'No recorder' });
          return;
        }
        
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'Stop timeout' });
        }, 5000);
        
        recorder.onstop = () => {
          clearTimeout(timeout);
          const blob = new Blob(chunks, { type: mimeType });
          console.log('[Page] Blob:', blob.size, 'bytes,', chunks.length, 'chunks');
          
          // Convert to base64
          const reader = new FileReader();
          reader.onloadend = () => {
            // Stop tracks
            if (stream) {
              stream.getTracks().forEach(t => t.stop());
            }
            resolve({ 
              success: true, 
              base64: reader.result,
              mimeType,
              size: blob.size,
              chunks: chunks.length
            });
          };
          reader.readAsDataURL(blob);
        };
        
        if (recorder.state !== 'inactive') {
          recorder.requestData();
          setTimeout(() => {
            if (recorder.state !== 'inactive') {
              recorder.stop();
            }
          }, 100);
        } else {
          clearTimeout(timeout);
          resolve({ success: false, error: 'Recorder already inactive' });
        }
      });
    });

    if (!videoResult.success) {
      console.error('[6] Stop failed:', videoResult.error);
      return false;
    }

    // Save
    const base64Data = videoResult.base64.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(outputPath, buffer);

    console.log(`
========================================
✅ SUCCESS!

   Video: ${path.basename(outputPath)}
   Size: ${(buffer.length / 1024).toFixed(2)} KB
   Codec: ${videoResult.mimeType}
   Display: ${displaySurface}

   Screenshot: ${path.basename(screenshotPath)}

   Play: open "${outputPath}"
========================================
`);
    
    return true;

  } catch (e) {
    console.error('Error:', e.message);
    return false;
  } finally {
    if (context) await context.close();
  }
}

runTest().then(success => {
  process.exit(success ? 0 : 1);
});
