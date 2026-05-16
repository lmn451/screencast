/**
 * esbuild configuration for bundling the XState v5 background service worker.
 * Bundles src/background.ts + dependencies → background.js (ESM, ES2022)
 */
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/background.ts'],
  bundle: true,
  minify: false,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'background.js',
  logLevel: 'info',
  // xstate is bundled inline (not external)
};

if (isWatch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('[esbuild] Watching for changes...');
} else {
  await esbuild.build(config);
  console.log('[esbuild] Build complete: background.js');
}