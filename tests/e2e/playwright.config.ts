import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isCI = process.env.CI === 'true';

export default defineConfig({
  testDir: path.resolve(__dirname),
  timeout: 90_000,
  workers: 1,
  retries: isCI ? 2 : 0,
  outputDir: path.resolve(__dirname, '../../test-results/e2e'),
  use: {
    headless: false,
    // No extension flags here; tests create a persistent context with the extension loaded.
    trace: isCI ? 'on-first-retry' : 'off',
    screenshot: isCI ? 'only-on-failure' : 'off',
    video: isCI ? 'retain-on-failure' : 'off',
    launchOptions: {
      // Keep the browser headed for extension loading reliability (especially on Linux CI).
      headless: false,
    },
  },
  reporter: [
    ['list'],
    ...(isCI
      ? [['html', { outputFolder: path.resolve(__dirname, '../../test-results/e2e/html'), open: 'never' }]]
      : []),
  ],
  forbidOnly: isCI,
  preserveOutput: isCI ? 'failures-only' : 'never',
});
