# Load This Extension Unpacked (Chromium Browsers)

These instructions show how to load this project as an unpacked browser extension in Chromium-based browsers (Chrome, Edge, Brave, Opera, Vivaldi).

The folder you will select is the one that contains `manifest.json` — the **root of this repository**.

## Build Prerequisite

All JavaScript that ships with the extension is bundled by [esbuild](https://esbuild.github.io/) from sources under `src/` into the `build/` directory. You must build before loading unpacked, and re-build after any change in `src/`.

```bash
pnpm install
pnpm run build       # bundles into build/
# or, for active development:
pnpm run dev         # watch mode
```

For a release zip, run `pnpm run build && ./scripts/package.sh`. The packager only includes `manifest.json`, the HTML pages at the root, `icons/`, and `build/*.js` (no sourcemaps, no source).

## Repository Layout

```
manifest.json              # Extension manifest
*.html                     # 8 page entry points (popup, consent, recorder,
                           #   offscreen, preview, recordings, recovery,
                           #   diagnostics) — must live at root so chrome-
                           #   extension:// URLs resolve.
icons/                     # Extension icons
build/                     # esbuild output (gitignored). Referenced from
                           #   manifest.service_worker, the <script> tags in
                           #   each HTML page, and chrome.scripting for
                           #   overlay injection.
src/
  background.ts            # Service worker entry
  ChromeAPI.ts             # Thin Chrome-API wrapper used by services
  messages.js              # Shared message schemas + validation
  error-codes.js           # Canonical error codes + createError helper
  logger.js                # Logger (diagnostics-aware)
  diagnostics.js           # IndexedDB-backed diagnostics store
  feedback.js              # User-facing alert/toast helpers
  entries/                 # Bundle entry points (one per HTML page +
                           #   overlay content script)
  lib/                     # Shared utilities (db, chunkStorage, recording,
                           #   cleanup, storage-utils, media-recorder-utils,
                           #   constants, db-shared)
  machines/                # XState v5 state machines
  services/                # Service classes (RecordingService, …)
tests/
  unit/                    # Jest unit tests (jsdom)
  e2e/                     # Playwright end-to-end tests
docs/                      # Long-form docs (architecture deep-dives,
                           #   migration guides, permissions rationale)
scripts/                   # Build/release scripts
store-assets/              # Screenshots etc. for the web store listing
```

## Quick Start (All Chromium Browsers)

1. Open your browser’s extensions page:

   - Google Chrome: `chrome://extensions`
   - Microsoft Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Opera: `opera://extensions`
   - Vivaldi: `vivaldi://extensions`

2. Enable Developer Mode.

   - There will be a toggle or switch labeled "Developer mode" on the extensions page.

3. Click "Load unpacked".

4. In the folder picker, select the folder that contains `manifest.json`

5. Verify the extension appears in the list and is enabled.

6. Optional: Pin the extension to the toolbar via the puzzle/extension icon so it’s easy to access.

## Browser-specific Notes

- Chrome & Brave

  - Use `chrome://extensions` or `brave://extensions`.
  - With Developer Mode on, you’ll also see an "Update" button that reloads all unpacked extensions at once.

- Microsoft Edge

  - Use `edge://extensions`.
  - Toggle "Developer Mode" at the bottom-left of the page to reveal "Load unpacked".

- Opera

  - Use `opera://extensions`.
  - Enable Developer Mode at the top-right, then click "Load unpacked".

- Vivaldi
  - Use `vivaldi://extensions`.
  - Enable Developer Mode, then click "Load unpacked".

## During Development

- Reload after changes

  - After editing files, click the reload icon next to the extension, or use the "Update" button on the extensions page (visible in Developer Mode) to reload all unpacked extensions.

- Viewing logs

  - Popup/options pages: right-click the page and choose "Inspect" to open DevTools and see console logs.
  - Content scripts: open the target page’s DevTools (Right-click → Inspect) and check the Console; content script logs appear there.
  - Background (Manifest V3) service worker: on the extensions page, click "Details" → "Service worker" → "Inspect" to view logs.
  - Background (Manifest V2) page (if applicable): click "background page" or similar link to inspect.

- Site access/permissions
  - If your extension needs to run on specific sites, use the extension’s "Details" page to grant site access as needed.
  - For access to local files (`file://` URLs), enable "Allow access to file URLs" on the extension’s Details page.

## Troubleshooting

- "Manifest is not valid JSON"

  - Ensure your `manifest.json` is valid JSON (no trailing commas, correct quoting, etc.).

- "Could not load icon" or missing icons

  - Check that icon paths in `manifest.json` point to files that exist, using paths relative to the extension root.

- Background script/service worker not running

  - Manifest V3: ensure `background.service_worker` points to `build/background.js` and that you have run `pnpm run build`.
  - If you see a service-worker registration failure, check the DevTools console under chrome://extensions → "Service worker" → "Inspect".

- Changes aren’t taking effect

  - Make sure you reload the extension after edits. For MV3 background code, also check the Service Worker DevTools and reload if needed.

- Wrong folder selected

  - You must select the folder that contains `manifest.json` (or your build output folder that includes `manifest.json`).

- Host permissions
  - If network requests are blocked or content scripts don’t run, verify that required host permissions are declared in `manifest.json` and that you’ve granted site access in the browser.

## Uninstall / Reinstall

- To remove: go to the extensions page and click "Remove" on the extension.
- To reinstall: follow the Quick Start steps again and select the correct folder.

## Packaging (Optional)

For distribution, Chromium can pack your extension into a `.crx` plus a private key:

- Chrome: on `chrome://extensions`, click "Pack extension" (visible in Developer Mode) and follow the prompts.
- Most dev workflows prefer unpacked during development and packed only for releases.
