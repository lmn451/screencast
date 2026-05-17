/**
 * esbuild configuration for CaptureCast.
 *
 * Bundles every script entry point referenced by the manifest or by an HTML
 * page into the `build/` directory. After running `pnpm run build`:
 *
 *   src/background.ts          → build/background.js     (service worker, ESM)
 *   src/entries/popup.js       → build/popup.js          (HTML page, ESM)
 *   src/entries/consent.js     → build/consent.js        (HTML page, ESM)
 *   src/entries/recorder.js    → build/recorder.js       (HTML page, ESM)
 *   src/entries/offscreen.js   → build/offscreen.js      (HTML page, ESM)
 *   src/entries/preview.js     → build/preview.js        (HTML page, ESM)
 *   src/entries/recordings.js  → build/recordings.js     (HTML page, ESM)
 *   src/entries/recovery.js    → build/recovery.js       (HTML page, ESM)
 *   src/entries/diagnostics.js → build/diagnostics.js    (HTML page, ESM)
 *   src/entries/overlay.js     → build/overlay.js        (content script, IIFE)
 *
 * The HTML pages live at the repo root and reference these bundles via
 * `build/<name>.js`. The manifest's service_worker and the chrome.scripting
 * overlay injection both use `build/<name>.js` paths as well.
 *
 * The `build/` directory is gitignored — bundles are build artifacts only.
 * Source lives exclusively under `src/`.
 */
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const OUT_DIR = 'build';

const baseConfig = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'es2022',
  logLevel: 'info',
};

// Service worker (background) — single entry, ESM.
const backgroundConfig = {
  ...baseConfig,
  entryPoints: ['src/background.ts'],
  format: 'esm',
  outfile: `${OUT_DIR}/background.js`,
};

// HTML-page modules (ESM). outbase flattens output names: src/entries/popup.js
// → build/popup.js, etc.
const pagesConfig = {
  ...baseConfig,
  entryPoints: [
    'src/entries/popup.js',
    'src/entries/consent.js',
    'src/entries/recorder.js',
    'src/entries/offscreen.js',
    'src/entries/preview.js',
    'src/entries/recordings.js',
    'src/entries/recovery.js',
    'src/entries/diagnostics.js',
  ],
  format: 'esm',
  outdir: OUT_DIR,
  outbase: 'src/entries',
};

// Overlay is injected by chrome.scripting.executeScript with
// `files: ['build/overlay.js']`. Content scripts injected by file cannot be
// ESM, so emit as a self-invoking IIFE.
const overlayConfig = {
  ...baseConfig,
  entryPoints: ['src/entries/overlay.js'],
  format: 'iife',
  outfile: `${OUT_DIR}/overlay.js`,
};

async function buildAll() {
  await Promise.all([
    esbuild.build(backgroundConfig),
    esbuild.build(pagesConfig),
    esbuild.build(overlayConfig),
  ]);
  console.log(`[esbuild] Build complete → ${OUT_DIR}/`);
}

async function watchAll() {
  const bg = await esbuild.context(backgroundConfig);
  const pages = await esbuild.context(pagesConfig);
  const overlay = await esbuild.context(overlayConfig);
  await Promise.all([bg.watch(), pages.watch(), overlay.watch()]);
  console.log(`[esbuild] Watching for changes → ${OUT_DIR}/`);
}

if (isWatch) {
  await watchAll();
} else {
  await buildAll();
}
