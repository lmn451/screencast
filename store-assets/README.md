# Chrome and Edge store assets

Place store listing images here.

Recommended assets:

Chrome Web Store:

- Extension icon: 128x128 PNG in the extension ZIP.
- Screenshots: 1280x800 (or 640x400), PNG/JPG. At least 1; provide up to 5.
- Small promotional tile: 440x280 PNG/JPG (required).
- Marquee promotional tile: 1400x560 PNG/JPG (optional).

Edge Add-ons:

- Store logo: square PNG, 300x300 recommended (128x128 minimum), required per language.
- Screenshots: 1280x800 or 640x480, up to 6 (optional but recommended).
- Small promotional tile: 440x280 (optional).
- Large promotional tile: 1400x560 PNG (optional).

Do not include these images in the package ZIP; they are only for listing uploads.

## Generated listing set

Run `pnpm run build && pnpm run store-assets` to recreate the image set from
the current extension UI.

- `screensilo-logo-300.png` — Edge store logo, 300x300.
- `screensilo-promo-440x280.png` — Chrome small promotional tile.
- `screensilo-marquee-1400x560.png` — optional Chrome/Edge marquee tile.
- `screenshots/01-choose-and-confirm.png` — popup and consent flow, 1280x800.
- `screenshots/02-stop-overlay.png` — on-page Stop control, 1280x800.
- `screenshots/03-preview-and-download.png` — preview/download UI, 1280x800.
- `screenshots/04-local-library.png` — on-device recordings library, 1280x800.
