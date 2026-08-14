# ScreenSilo Firefox source build

This archive contains the human-readable source used to build the Firefox
Add-ons submission for ScreenSilo 0.2.2.

## Reference environment

- macOS 15.7.9 (arm64)
- Node.js 26.7.0
- pnpm 10.18.2 (pinned in `package.json`)
- Standard `bash`, `zip`, and `unzip` command-line tools

The build is also expected to work on current Linux systems with the same
Node.js and pnpm versions.

## Install dependencies

From the root of this source archive:

```sh
corepack enable
corepack prepare pnpm@10.18.2 --activate
pnpm install --frozen-lockfile
```

No global npm packages are required. All JavaScript build dependencies are
declared in `package.json` and locked by `pnpm-lock.yaml`.

## Build the submitted Firefox package

```sh
pnpm run package:firefox
```

This command performs both required build stages:

1. `esbuild.config.js` bundles the TypeScript and JavaScript entry points into
   the generated `build/` directory.
2. `scripts/package.sh firefox` copies the explicit Firefox production
   allowlist into a temporary staging directory and creates:
   `dist/screensilo-firefox-mv3-0.2.2.zip`.

The submitted extension archive contains `manifest.firefox.json` renamed to
`manifest.json` at the archive root. It intentionally omits the Chromium-only
offscreen document and bundle. On Firefox, ScreenSilo uses the visible
`recorder.html` capture page because Firefox does not implement
`chrome.offscreen`.

## Optional verification

```sh
pnpm run typecheck
pnpm run test:unit
pnpm run lint
unzip -l dist/screensilo-firefox-mv3-0.2.2.zip
```

The lint command currently reports four pre-existing unused-variable warnings
in tests and no errors. Mozilla's automated validation reports zero errors and
zero warnings for the generated Firefox extension archive.
