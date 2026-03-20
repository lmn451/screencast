import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

const isCI = !!process.env.CI;

/**
 * Prepare extension for testing by ensuring bundled version is ready.
 * The test bundle inlines all ES module imports for Service Worker compatibility.
 */
function prepareTestExtension() {
  const bgOriginal = path.join(rootDir, 'background.js');
  const bgBundled = path.join(rootDir, 'build', 'background-test.js');
  
  // Check if bundled version exists and is newer
  let needsBuild = true;
  if (fs.existsSync(bgBundled)) {
    const origStat = fs.statSync(bgOriginal);
    const bundledStat = fs.statSync(bgBundled);
    if (bundledStat.mtime > origStat) {
      needsBuild = false;
    }
  }
  
  if (needsBuild) {
    console.log('Test bundle not found or outdated. Run: pnpm build:test');
  }
  
  return { needsBuild, bgBundled };
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    prepareTestExtension();
    
    // For testing, we'll use the original background.js
    // The build step should be run separately: pnpm build:test
    const pathToExtension = rootDir;
    
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        // Extension loading
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        
        // Browser stability
        '--no-first-run',
        '--no-default-browser-check',
        '--noerrdialogs',
        '--disable-prompt-on-repost',
        
        // Disable background tab throttling (prevents green screen on inactive tabs)
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        
        // Media stream (for tabCapture - no picker needed)
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        
        // GPU acceleration - DISABLE to prevent green screen in recordings
        // Green screen = GPU encoder failure, fallback to software encoding
        '--disable-gpu',
        '--disable-accelerated-video-decode',
        '--disable-accelerated-video-encode',
        '--disable-software-rasterizer',
        
        // CI-specific flags
        ...(isCI
          ? [
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--disable-setuid-sandbox',
              '--disable-accelerated-2d-canvas',
              '--single-process', // Helps in Docker/CI environments
            ]
          : []),
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
});

export { expect } from '@playwright/test';
