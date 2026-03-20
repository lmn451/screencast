/**
 * E2E Test: Canvas-based recording (no GPU encoding issues)
 * Uses canvas.captureStream() - proven reliable method
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

test('canvas capture recording (reliable)', async ({ context }) => {
  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `canvas-${timestamp}.webm`);
  
  console.log(`
========================================
 Canvas Capture Recording (PROVEN)
========================================
Output: ${outputPath}
========================================
`);

  const page = await context.newPage();
  
  // Use canvas.captureStream - no GPU encoding involved
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 20px; background: #1a1a2e; color: white; font-family: sans-serif; }
  </style>
</head>
<body>
  <canvas id="canvas" width="640" height="480"></canvas>
  <script>
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let frame = 0;
    
    function draw() {
      frame++;
      
      // Clear with gradient background
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, '#1a1a2e');
      gradient.addColorStop(1, '#16213e');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Draw bouncing ball
      const ballY = 240 + Math.sin(frame * 0.05) * 100;
      ctx.beginPath();
      ctx.arc(320, ballY, 40, 0, Math.PI * 2);
      ctx.fillStyle = '#e94560';
      ctx.fill();
      
      // Draw rotating square
      ctx.save();
      ctx.translate(160, 240);
      ctx.rotate(frame * 0.02);
      ctx.fillStyle = '#4ecdc4';
      ctx.fillRect(-30, -30, 60, 60);
      ctx.restore();
      
      // Draw counter text
      ctx.fillStyle = 'white';
      ctx.font = '48px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Frame: ' + frame, 320, 400);
      
      // Draw colored rectangles that change
      for (let i = 0; i < 5; i++) {
        const hue = (frame + i * 30) % 360;
        ctx.fillStyle = \`hsl(\${hue}, 70%, 50%)\`;
        ctx.fillRect(420 + i * 25, 80, 20, 100);
      }
      
      requestAnimationFrame(draw);
    }
    
    draw();
    
    // Expose canvas for recording
    window.canvas = canvas;
  </script>
</body>
</html>
`;
  
  console.log('[1/6] Loading page...');
  await page.goto('https://example.com');
  await page.setContent(htmlContent);
  console.log('[2/6] Canvas content loaded');

  // Check capabilities
  const check = await page.evaluate(() => ({
    hasCanvas: !!document.getElementById('canvas'),
    hasCaptureStream: !!HTMLCanvasElement.prototype.captureStream,
  }));
  console.log('[2/6] Check:', check);

  console.log('[3/6] Starting canvas.captureStream recording...');
  
  const result = await page.evaluate(async () => {
    const canvas = document.getElementById('canvas');
    
    // captureStream - this is the proven method that doesn't have GPU issues
    const stream = canvas.captureStream(30);
    console.log('[Page] Stream tracks:', stream.getVideoTracks().length);
    
    // Use VP8 for maximum compatibility
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    
    recorder.start(100);
    console.log('[Page] Recording started, mimeType:', mimeType);
    
    // Wait for recording
    await new Promise(r => setTimeout(r, 3000));
    
    console.log('[Page] Stopping...');
    
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve({
            base64: reader.result,
            mimeType,
            chunks: chunks.length,
            blobSize: blob.size
          });
        };
        reader.readAsDataURL(blob);
      };
      recorder.stop();
    });
  });

  console.log('[4/6] Recording complete:', result);

  // Save
  const base64Data = result.base64.split(',')[1];
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(outputPath, buffer);
  
  console.log('[5/6] Video saved');
  
  expect(fs.existsSync(outputPath)).toBeTruthy();
  expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);

  await page.close();
  
  console.log('[6/6] Done');

  console.log(`
========================================
✅ SUCCESS! (Canvas Capture - PROVEN METHOD)
   
   File: ${path.basename(outputPath)}
   Size: ${(buffer.length / 1024).toFixed(2)} KB
   Codec: ${result.mimeType}
   Chunks: ${result.chunks}
   
   Play: open "${outputPath}"
========================================
`);
});
