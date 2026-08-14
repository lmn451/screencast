# Publishing ScreenSilo (Chrome + Edge)

This doc covers manual submission steps and checklists for both stores.

Prereqs

- Developer accounts for Chrome Web Store and Microsoft Partner Center (Edge Add-ons)
- Final ZIP package with manifest.json at root
- Listing copy and images prepared
- Privacy policy URL: https://subagentura.tech/screencast/privacy/
- Support email: hello@subagentura.tech

Packaging

- Update both manifest.json and package.json versions
- Generate icons: ./scripts/gen-icons.sh path/to/source.png
- Package: pnpm run package
- Validate: Load unpacked in Chrome/Edge to smoke test
- Inspect the ZIP and confirm that it contains no source maps, tests, or development bundles

Chrome Web Store steps

1. https://chrome.google.com/webstore/devconsole
2. New item (or select existing) -> Upload ZIP
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

Common rejection checks

- No obfuscation or remote code execution
- Minimal permissions; host permissions scoped where possible
- Accurate data disclosure
- Screenshots reflect actual UI
- Icons present and sized correctly

Release notes & versioning

- Maintain CHANGELOG.md; paste into store release notes fields
- Bump version for every upload (Chrome/Edge)
