# Publishing ScreenSilo

This doc covers GitHub releases and manual Chrome, Edge, and Firefox store submissions.

Prereqs

- Developer accounts for Chrome Web Store, Microsoft Partner Center (Edge Add-ons), and Firefox Add-ons
- Final ZIP package with manifest.json at root
- Listing copy and images prepared
- Privacy policy URL: https://subagentura.tech/screencast/privacy/
- Support email: hello@subagentura.tech

Packaging

- Update manifest.json, manifest.firefox.json, and package.json versions
- Generate icons: ./scripts/gen-icons.sh path/to/source.png
- Package: pnpm run package:all
- Validate: Load unpacked in Chrome/Edge to smoke test
- Inspect the ZIP and confirm that it contains no source maps, tests, or development bundles

GitHub release steps

1. Complete code review and CI, then merge the approved changes to master.
2. Build the packages from the merged revision and verify their versions and contents.
3. Create a `v<version>` tag and GitHub release targeting that revision.
4. Attach the Chromium package, Firefox package, Firefox review-source archive, and SHA-256 checksums.
5. Use the changelog for release notes. Record store submissions separately from store approval or publication.

Chrome Web Store steps

1. https://chrome.google.com/webstore/devconsole
2. Select the existing ScreenSilo item (`higbocdfimfmcjckomeggbbigcglpdje`) -> Package -> Upload new package
3. Fill listing: title, short/long description, category, screenshots, contact, privacy policy URL
4. Privacy: paste the single-purpose, data-use, remote-code, and Limited Use answers from `store-assets/privacy-fields.md`
5. Permissions: justify `activeTab`, `scripting`, `offscreen`, `storage`, and `alarms`
6. Distribution: choose Public/Unlisted/Private, regions; optional staged rollout
7. Submit for review

Edge Add-ons steps

1. https://partner.microsoft.com/dashboard/microsoftedge
2. New Add-on (or update) -> Upload ZIP
3. Fill listing: title, descriptions, category, 300x300 logo, screenshots, contact, and privacy policy URL
4. Keep purpose, permission, remote-code, and data-use disclosures aligned with Chrome
5. Availability: regions and visibility
6. Submit for certification

Firefox Add-ons steps

1. https://addons.mozilla.org/developers/
2. Select the existing ScreenSilo add-on and upload `dist/screensilo-firefox-mv3-<version>.zip` as a new version.
3. Supply `dist/screensilo-firefox-source-<version>.zip` when asked for source code. The archive includes `SOURCE_BUILD.md` with reproduction instructions.
4. Review the automated validation results, release notes, and existing listing disclosures.
5. Submit for Mozilla review and signing. The local Firefox package remains unsigned until Mozilla signs it.

Common rejection checks

- No obfuscation or remote code execution
- Minimal permissions; host permissions scoped where possible
- Accurate data disclosure
- Screenshots reflect actual UI
- Icons present and sized correctly

Release notes & versioning

- Maintain CHANGELOG.md; paste into store release notes fields
- Bump version for every upload (Chrome/Edge/Firefox)
