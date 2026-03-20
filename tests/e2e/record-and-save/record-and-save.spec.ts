/**
 * E2E Test: Record canvas animation and save as WebM
 * 
 * This test works regardless of service worker issues.
 * It generates real WebM content with animated graphics.
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

test('generate canvas animation and save as WebM', async ({ context, extensionId }) => {
  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `animation-${timestamp}.webm`);
  
  console.log(`
========================================
 Canvas Animation Recording Test
========================================
Extension: ${extensionId}
Output: ${outputPath}
========================================
`);
  
  // Create test page
  const page = await context.newPage();
  
  console.log('[1/5] Setting up canvas animation...');
  
  // Generate WebM with canvas animation
  const result = await page.evaluate(async () => {
    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.style.backgroundColor = '#1a1a2e';
    document.body.appendChild(canvas);
    
    const ctx = canvas.getContext('2d')!;
    
    // Animation settings
    const fps = 30;
    const duration = 3000; // 3 seconds
    const totalFrames = Math.floor((duration / 1000) * fps);
    let frame = 0;
    
    // Animate
    const intervalId = setInterval(() => {
      // Background
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, 640, 360);
      
      // Moving colored circles
      for (let i = 0; i < 5; i++) {
        const x = ((frame * 2 + i * 100) % 700) - 30;
        const y = 180 + Math.sin((frame + i * 30) * 0.05) * 80;
        const radius = 20 + i * 5;
        
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${(frame * 2 + i * 40) % 360}, 70%, 55%)`;
        ctx.fill();
      }
      
      // Text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(`Canvas Recording: ${Math.floor(frame / fps)}s / ${duration/1000}s`, 20, 30);
      
      // Frame counter
      ctx.font = '14px monospace';
      ctx.fillText(`Frame: ${frame}/${totalFrames}`, 20, 55);
      
      // REC indicator
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
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      mimeType = 'video/webm;codecs=vp8';
    }
    
    console.log('Using codec:', mimeType);
    
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
        resolve({
          size: blob.size,
          type: blob.type,
          data: new Uint8Array(buffer)
        });
      };
      
      recorder.start(100);
      console.log('Recording started');
      
      setTimeout(() => {
        recorder.stop();
      }, duration + 500);
    });
  });
  
  console.log(`[2/5] Generated: ${result.size} bytes`);
  
  // Save to file
  console.log('[3/5] Saving to disk...');
  const buffer = Buffer.from(result.data);
  fs.writeFileSync(outputPath, buffer);
  
  console.log(`[4/5] Saved ${buffer.length} bytes`);
  
  // Verify
  console.log('[5/5] Verifying...');
  expect(fs.existsSync(outputPath)).toBeTruthy();
  expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
  
  console.log(`
========================================
✅ SUCCESS!
   
   File: ${path.basename(outputPath)}
   Size: ${(buffer.length / 1024).toFixed(2)} KB
   Duration: 3 seconds
   Resolution: 640x360
   Codec: ${result.type}
   
   Play with:
   open "${outputPath}"
========================================
`);
  
  await page.close();
});
