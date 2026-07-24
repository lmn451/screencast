import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const outfile = path.join(rootDir, 'build', 'background-test.js');

async function buildTestBackground() {
  await fs.promises.mkdir(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'background.js')],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
    define: {
      'import.meta.url': '"self.location.href"',
    },
  });

  const stats = await fs.promises.stat(outfile);
  console.log(`Built test background (${(stats.size / 1024).toFixed(2)} KB)`);
}

buildTestBackground().catch((error) => {
  console.error('Failed to build test background:', error);
  process.exitCode = 1;
});
