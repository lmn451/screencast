# Chrome and Edge store assets

The checked-in files in this directory are listing assets only; they are not included in the extension ZIP.

Generated assets:

- `capturecast-01-consent-1280x800.png`
- `capturecast-02-popup-1280x800.png`
- `capturecast-03-recordings-1280x800.png`
- `capturecast-04-recovery-1280x800.png`
- `capturecast-05-preview-1280x800.png`
- `edge-logo-300.png`

The screenshots are captured from the real extension pages at 1280×800. The Edge logo is a 300×300 PNG derived from `icons/icon-256.png`.

To regenerate the screenshots after UI changes:

```bash
pnpm run build
node scripts/capture-store-assets.mjs
```

Recommended store assets:

Chrome Web Store:

- Screenshots: 1280x800 (or 640x400), PNG/JPG. Provide 3–5.
- Small tile: 440x280 (optional)
- Hero: 1400x560 (optional)

Edge Add-ons:

- Store logo: 300x300 PNG (`edge-logo-300.png`)
- Screenshots: 1280x800, 3–8 images
