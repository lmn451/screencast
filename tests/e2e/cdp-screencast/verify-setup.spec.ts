/**
 * Quick verification test - Run this first to debug extension loading
 * Usage: pnpm playwright test tests/e2e/cdp-screencast/verify-setup.ts
 */

import { test, expect } from '../lib/fixtures';

test('extension loads and controller page is accessible', async ({ context, extensionId }) => {
  console.log('Extension ID:', extensionId);
  
  const page = await context.newPage();
  
  // Collect console messages
  const consoleLogs: string[] = [];
  page.on('console', msg => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  // Verify page loaded
  const title = await page.title();
  console.log('Page title:', title);
  expect(title).toBe('CaptureCast Controller');
  
  // Check status element exists
  const status = await page.locator('#status');
  await expect(status).toBeVisible();
  
  // Log any console errors
  const errors = consoleLogs.filter(l => l.startsWith('[error]'));
  if (errors.length > 0) {
    console.log('Console errors:', errors);
  }
  
  console.log('Extension verification successful!');
});

test('service worker is active', async ({ context, extensionId }) => {
  // Get the service worker
  const sw = context.serviceWorkers()[0];
  if (!sw) {
    throw new Error('Service worker not found');
  }
  
  console.log('Service worker URL:', sw.url());
  expect(sw.url()).toContain(extensionId);
  
  // Test service worker is responsive
  const response = await sw.evaluate(() => {
    return 'Service worker is running';
  });
  expect(response).toBe('Service worker is running');
});
