# Publishing CaptureCast (Chrome + Edge)

This doc covers manual submission steps and checklists for both stores.

Prereqs
- Developer accounts for Chrome Web Store and Microsoft Partner Center (Edge Add-ons)
- Final ZIP package with manifest.json at root
- Listing copy and images prepared
- Privacy policy URL and support email

Packaging
- Update manifest.json version
- Generate icons: ./scripts/gen-icons.sh path/to/source.png
- Package: ./scripts/package.sh
- Validate: Load unpacked in Chrome/Edge to smoke test

Chrome Web Store steps
1) https://chrome.google.com/webstore/devconsole
2) New item (or select existing) -> Upload ZIP
3) Fill listing: title, short/long description, category, screenshots, contact, privacy policy URL
4) Data disclosure: declare data collection (None if accurate)
5) Permissions justification: explain each permission
6) Distribution: choose Public/Unlisted/Private, regions; optional staged rollout
7) Submit for review

Edge Add-ons steps
1) https://partner.microsoft.com/dashboard/microsoftedge
2) New Add-on (or update) -> Upload ZIP
3) Fill listing: title, descriptions, categories, images (logo 300x300 + screenshots), contact, privacy policy URL
4) Data/disclosure aligned with Chrome submission
5) Availability: regions and visibility
6) Submit for certification

Common rejection checks
- No obfuscation or remote code execution
- Minimal permissions; host permissions scoped where possible
- Accurate data disclosure
- Screenshots reflect actual UI
- Icons present and sized correctly

Release notes & versioning
- Maintain CHANGELOG.md; paste into store release notes fields
- Bump version for every upload (Chrome/Edge)

