import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

const isCI = !!process.env.CI;

/**
 * Build the extension bundle using esbuild with Clean Entry Point pattern.
 * 
 * Why this works:
 * 1. sw-entry.js has NO exports - esbuild won't generate `var self = ...` 
 * 2. No globalName means global `self` (Service Worker's context) stays intact
 * 3. Single IIFE bundle bypasses ESM CORS/MIME issues in --load-extension mode
 * 
 * @see https://esbuild.github.io/api/#bundle
 */
function buildExtensionBundle() {
  const distDir = path.join(rootDir, 'dist');
  const bundlePath = path.join(distDir, 'background.bundle.js');
  
  // Ensure dist directory exists
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }
  
  // Run esbuild with clean entry point (no exports = no self override)
  console.log('[Build] Creating extension bundle via esbuild...');
  execSync(
    `cd "${rootDir}" && npx esbuild sw-entry.js --bundle --outfile=dist/background.bundle.js`,
    { stdio: 'inherit' }
  );
  
  console.log(`[Build] Bundle created: ${bundlePath}`);
  return bundlePath;
}

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    // CRITICAL: Build BEFORE chromium.launchPersistentContext
    // Playwright caches the extension at launch time - too late to modify files
    buildExtensionBundle();
    
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
        
        // GPU settings - use SwiftShader (software GPU) for reliable rendering
        // This allows proper frame capture while using software encoding
        '--use-gl=swiftshader',
        '--enable-gpu-rasterization',
        '--ignore-gpu-blocklist',
        '--enable-accelerated-video-decode',
        '--enable-zero-copy',
        
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
    // MV2 uses background page, MV3 uses service worker
    let extensionId = 'unknown';
    
    // Try background page first (MV2)
    const bgPages = context.backgroundPages();
    if (bgPages.length > 0) {
      extensionId = bgPages[0].url().split('/')[2];
    } else {
      // Try service worker (MV3)
      const sws = context.serviceWorkers();
      if (sws.length > 0) {
        extensionId = sws[0].url().split('/')[2];
      } else {
        // Wait for service worker (MV3 fallback)
        try {
          const sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
          extensionId = sw.url().split('/')[2];
        } catch (e) {
          // Try background page (MV2 fallback)
          const bgPage = await context.waitForEvent('backgroundpage', { timeout: 5000 });
          extensionId = bgPage.url().split('/')[2];
        }
      }
    }
    
    await use(extensionId);
  },
});

export { expect } from '@playwright/test';
