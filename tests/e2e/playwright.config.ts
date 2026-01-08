import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
