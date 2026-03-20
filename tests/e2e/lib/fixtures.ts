import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isCI = !!process.env.CI;

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const pathToExtension = path.resolve(__dirname, '../../..');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--noerrdialogs',
        '--disable-prompt-on-repost',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        // Stabilize mic/camera permission prompts in automation. These flags do
        // not bypass the native getDisplayMedia picker for screen/window capture.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', // Required for tabCapture in tests (may cause green screen in some scenarios)
        ...(isCI
          ? [
              '--disable-gpu',
              '--no-sandbox',
              '--disable-dev-shm-usage',
              '--disable-setuid-sandbox',
              '--disable-accelerated-2d-canvas',
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
