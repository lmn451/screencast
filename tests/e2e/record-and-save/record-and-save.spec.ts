/**
 * E2E Test: Generate canvas animation and save as WebM
 * 
 * Run with: pnpm e2e:record
 */
import { test, expect } from '../lib/fixtures';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, '../../..', 'recordings-output');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

test.beforeEach(async ({ context }) => {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
});

test('extension loads', async ({ context, extensionId }) => {
  console.log(`[Test] Extension ID: ${extensionId}`);
  
  const sw = context.serviceWorkers()[0];
  expect(sw).toBeTruthy();
  
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/preview.html`);
  
  const title = await page.title();
  console.log(`[Test] Page title: ${title}`);
  expect(title).toBeTruthy();
  
  await page.waitForTimeout(500);
  
  const videoExists = await page.$('#video');
  console.log(`[Test] Video element exists: ${!!videoExists}`);
  
  await page.close();
});

test('generate 3-second canvas animation and save as WebM', async ({ context, extensionId }) => {
  const testName = 'canvas-animation-' + Date.now();
  const outputPath = path.join(OUTPUT_DIR, `${testName}.webm`);
  
  console.log(`
========================================
 Canvas Animation Recording Test
========================================
Output: ${outputPath}
========================================
`);
  
  const page = await context.newPage();
  
  // Generate WebM with canvas animation
  console.log('[1/3] Generating 3-second canvas animation...');
  
  const result = await page.evaluate(async () => {
    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.style.backgroundColor = '#1a1a2e';
    document.body.appendChild(canvas);
    
    const ctx = canvas.getContext('2d')!;
    
    // Animation state
    let frame = 0;
    const fps = 30;
    const duration = 3000; // 3 seconds
    const totalFrames = Math.floor((duration / 1000) * fps);
    
    // Colors for a nice gradient
    const colors = ['#e94560', '#0f3460', '#16213e', '#1a1a2e'];
    
    // Animate
    const intervalId = setInterval(() => {
      // Background
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, 640, 360);
      
      // Moving colored circle with trail effect
      const x = (frame * 3) % 700 - 30;
      const y = 180 + Math.sin(frame * 0.08) * 80;
      ctx.beginPath();
      ctx.arc(x, y, 30, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${(frame * 2) % 360}, 75%, 55%)`;
      ctx.fill();
      
      // Secondary smaller circle
      ctx.beginPath();
      ctx.arc(x + 50, y - 30, 15, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${(frame * 2 + 120) % 360}, 70%, 60%)`;
      ctx.fill();
      
      // Timer text
      const elapsed = Math.floor(frame / fps);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 18px monospace';
      ctx.fillText(`Canvas Animation: ${elapsed}s / ${duration/1000}s`, 20, 30);
      
      // Frame counter
      ctx.font = '14px monospace';
      ctx.fillText(`Frame: ${frame}/${totalFrames}`, 20, 55);
      
      // Recording indicator
      ctx.fillStyle = '#e94560';
      ctx.beginPath();
      ctx.arc(610, 30, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '12px sans-serif';
      ctx.fillText('REC', 580, 35);
      
      frame++;
      if (frame >= totalFrames) {
        clearInterval(intervalId);
      }
    }, 1000 / fps);
    
    // Capture stream
    const stream = canvas.captureStream(fps);
    
    // Find best codec
    let mimeType = 'video/webm';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
      mimeType = 'video/webm;codecs=vp9';
      console.log('Using VP9 codec');
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      mimeType = 'video/webm;codecs=vp8';
      console.log('Using VP8 codec');
    }
    
    // Record
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    
    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunks.push(e.data);
    };
    
    return new Promise<{ size: number; type: string; data: Uint8Array }>((resolve, reject) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType });
        const buffer = await blob.arrayBuffer();
        console.log(`Generated blob: ${blob.size} bytes`);
        resolve({
          size: blob.size,
          type: blob.type,
          data: new Uint8Array(buffer)
        });
      };
      
      recorder.onerror = (e) => {
        reject(new Error('MediaRecorder error: ' + e));
      };
      
      recorder.start(100);
      console.log('Recording started...');
      
      // Wait for duration
      setTimeout(() => {
        recorder.stop();
      }, duration + 500);
    });
  });
  
  console.log(`[2/3] Generated: ${result.size} bytes, type: ${result.type}`);
  
  // Save to file
  const buffer = Buffer.from(result.data);
  fs.writeFileSync(outputPath, buffer);
  
  console.log(`[3/3] Saved to: ${outputPath}`);
  
  console.log(`
========================================
✅ SUCCESS!
   
   File: ${path.basename(outputPath)}
   Size: ${(buffer.length / 1024).toFixed(2)} KB
   Duration: 3 seconds
   Resolution: 640x360
   Codec: ${result.type}
   
   Open with:
   open "${outputPath}"
========================================
`);
  
  // Verify
  expect(fs.existsSync(outputPath)).toBeTruthy();
  expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
  
  await page.close();
});
