# Load This Extension Unpacked (Chromium Browsers)

These instructions show how to load this project as an unpacked browser extension in Chromium-based browsers (Chrome, Edge, Brave, Opera, Vivaldi).

The folder you will select is the one that contains `manifest.json`.

For this repository, that folder is the root directory containing `manifest.json`

If your build process outputs a different folder (e.g., `dist/` or `build/`), select that output folder instead.

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

  - Manifest V3: ensure `background.service_worker` points to a valid path and that the file exists.
  - Manifest V2: ensure the background page/script paths are correct (if you are using MV2).

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
