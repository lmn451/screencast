import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: path.resolve(__dirname),
  timeout: 90_000,
  workers: 1,
  use: {
    headless: false,
    // No extension flags here; tests create a persistent context with the extension loaded.
  },
  reporter: [['list']],
});
