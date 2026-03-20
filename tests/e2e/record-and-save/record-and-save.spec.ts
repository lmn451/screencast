/**
 * E2E Test: Native getDisplayMedia from file:// page
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

test('native screen capture from file page', async ({ context }) => {
  const timestamp = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `native-capture-${timestamp}.webm`);
  
  console.log(`
========================================
 Native getDisplayMedia (file://)
========================================
Output: ${outputPath}
========================================
`);
  
  const page = await context.newPage();
  
  // Create a test HTML file
  const testHtmlPath = path.join(OUTPUT_DIR, 'test-page.html');
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: sans-serif;
      background: linear-gradient(135deg, #1a1a2e, #16213e);
      color: white;
      padding: 40px;
    }
    h1 { color: #e94560; }
    .counter {
      font-size: 3rem;
      font-weight: bold;
      background: white;
      color: #0f3460;
      padding: 20px;
      border-radius: 10px;
      display: inline-block;
    }
    .ball {
      width: 40px;
      height: 40px;
      background: #e94560;
      border-radius: 50%;
      animation: bounce 1s infinite ease-in-out;
    }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-50px); }
    }
    .box {
      width: 80px;
      height: 80px;
      background: #0f3460;
      border-radius: 10px;
      animation: spin 2s infinite linear;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <h1>🎬 Screen Recording Test</h1>
  <div class="counter" id="counter">0</div>
  <div class="ball"></div>
  <div class="box"></div>
  <div id="log" style="margin-top:20px;font-family:monospace;"></div>
  <script>
    let count = 0;
    setInterval(() => {
      count++;
      document.getElementById('counter').textContent = count;
      document.getElementById('log').innerHTML = 'Tick ' + count;
    }, 500);
  </script>
</body>
</html>
`;
  fs.writeFileSync(testHtmlPath, htmlContent);
  console.log('[1/6] Created test page:', testHtmlPath);
  
  // Navigate to the file
  console.log('[2/6] Navigating to file:// page...');
  await page.goto(`file://${testHtmlPath}`);
  
  // Check mediaDevices
  const checkResult = await page.evaluate(() => ({
    hasMediaDevices: typeof navigator?.mediaDevices !== 'undefined',
    hasGetDisplayMedia: typeof navigator?.mediaDevices?.getDisplayMedia !== 'undefined',
    origin: location.origin,
    protocol: location.protocol
  }));
  console.log('[2/6] Media check:', JSON.stringify(checkResult));
  
  if (!checkResult.hasGetDisplayMedia) {
    console.log('[2/6] getDisplayMedia not available, trying HTTPS page...');
    await page.goto('https://www.example.com');
    
    const check2 = await page.evaluate(() => ({
      hasMediaDevices: typeof navigator?.mediaDevices !== 'undefined',
      hasGetDisplayMedia: typeof navigator?.mediaDevices?.getDisplayMedia !== 'undefined',
      origin: location.origin
    }));
    console.log('[2/6] HTTPS check:', JSON.stringify(check2));
  }
  
  await page.waitForTimeout(500);
  
  // Start recording
  console.log('[3/6] Starting getDisplayMedia...');
  
  const recordingResult = await page.evaluate(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('getDisplayMedia not available');
    }
    
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false
    });
    
    console.log('[Page] Got stream, tracks:', stream.getVideoTracks().length);
    
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    
    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunks.push(e.data);
    };
    
    recorder.start(100);
    console.log('[Page] Recording...');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    recorder.stop();
    stream.getTracks().forEach(t => t.stop());
    
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const blob = new Blob(chunks, { type: mimeType });
    const buffer = await blob.arrayBuffer();
    
    return {
      size: blob.size,
      type: blob.type,
      data: Array.from(new Uint8Array(buffer))
    };
  });
  
  console.log(`[4/6] Got ${recordingResult.size} bytes`);
  
  // Save
  console.log('[5/6] Saving...');
  const buffer = Buffer.from(recordingResult.data);
  fs.writeFileSync(outputPath, buffer);
  
  // Verify
  console.log('[6/6] Verifying...');
  expect(fs.existsSync(outputPath)).toBeTruthy();
  expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
  
  await page.close();
  
  console.log(`
========================================
✅ SUCCESS!
   
   File: ${path.basename(outputPath)}
   Size: ${(buffer.length / 1024).toFixed(2)} KB
   Codec: ${recordingResult.type}
   
   Play: open "${outputPath}"
========================================
`);
});
