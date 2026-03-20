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
async function prepareTestExtension() {
  const bgOriginal = path.join(rootDir, 'background.js');
  const bgBundled = path.join(rootDir, 'build', 'background-test.js');
  const bgBackup = path.join(rootDir, 'background.js.backup');
  
  // Build if needed
  if (!fs.existsSync(bgBundled)) {
    console.log('📦 Building test bundle...');
    const { execSync } = await import('child_process');
    try {
      execSync('node build/background.js', { cwd: rootDir, stdio: 'inherit' });
    } catch (e) {
      console.error('❌ Build failed:', e);
      throw new Error('Run "pnpm build:test" first');
    }
  }
  
  // ALWAYS backup original and copy bundled version for testing
  // This ensures each test run uses the bundle, not the original
  fs.copyFileSync(bgOriginal, bgBackup);
  fs.copyFileSync(bgBundled, bgOriginal);
  console.log('🔧 Using bundled background.js for testing');
  
  return { bgBackup, bgOriginal };
}

/**
 * Restore original background.js after tests
 */
function restoreExtension(bgBackup: string, bgOriginal: string) {
  if (fs.existsSync(bgBackup)) {
    fs.copyFileSync(bgBackup, bgOriginal);
    fs.unlinkSync(bgBackup);
    console.log('🔄 Restored original background.js');
  }
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: [
    async ({}, use) => {
      // Prepare extension for testing
      const { bgBackup, bgOriginal } = await prepareTestExtension();
      
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
                '--single-process',
              ]
            : []),
        ],
      });
      
      await use(context);
      
      // Restore original background.js
      restoreExtension(bgBackup, bgOriginal);
      
      await context.close();
    },
    { timeout: 60000 },
  ],
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
