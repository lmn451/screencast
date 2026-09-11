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

Automated Chrome Web Store publishing from CI

Chrome publishing can run without an interactive Google login. The
`publish-chrome.yml` workflow exchanges the GitHub Actions OIDC identity for a
short-lived Google Cloud access token for a service account, then calls the
Chrome Web Store API v2. No service-account key or OAuth refresh token is used.
The service account still has to be linked to the publisher once in the
Developer Dashboard; that is the one-time account access required by Google's
[service-account setup](https://developer.chrome.com/docs/webstore/service-accounts).

Dispatch the workflow from `master` and enter an existing published release tag,
such as `v0.2.3`. The script downloads the release's
`screensilo-mv3-<version>.zip` and `SHA256SUMS` assets from GitHub. Before it
contacts the store it checks all of the following:

1. The release is published, non-prerelease, and has exactly the expected package and checksum assets.
2. The tag resolves to a commit that is an ancestor of the current `master` branch.
3. The same commit has a successful completed `push` run of `.github/workflows/ci.yml` on `master`.
4. The package checksum and root `manifest.json` version match the tag.

The synchronous upload response must return a successful v2 upload state and a
`crxVersion` that matches the tag. If the API returns `UPLOAD_IN_PROGRESS`, the
script polls the documented `lastAsyncUploadState` for up to two minutes. An
acknowledged async upload is tied to the locally verified package; when the
state reaches `SUCCEEDED`, the local manifest version remains the version being
submitted. The status endpoint does not expose an uploaded-draft version, so an
incomplete initial upload response is handled differently: the script makes no
second upload POST, checks only for an already submitted or published matching
version, and otherwise stops with rerun guidance. Only a verified upload then
reaches v2 `:publish` with `blockOnWarnings: true`; a failed or ambiguous upload
never reaches the publish request. Network and transient HTTP failures have a
bounded retry budget, and the script never prints either token.

The workflow uses the `chrome-store` environment. Restrict that environment's
deployment branch policy to `master`, then add these environment secrets in the
repository settings:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: the full provider resource name, for example `projects/123456789/locations/global/workloadIdentityPools/github/providers/chrome-webstore-master`
- `CHROME_WEBSTORE_SERVICE_ACCOUNT`: the service-account email linked to the Chrome Web Store publisher

The built-in GitHub token is granted read-only `contents` and `actions` access
for release and CI provenance checks. Do not add a JSON service-account key or a
Chrome Web Store refresh token to the workflow.

One-time Google Cloud setup

Run the setup commands as a Google Cloud administrator from a machine with the
[Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed. This
local administrator login is used only to create the resources; it is separate
from the keyless GitHub Actions login. Authenticate the CLI with
`gcloud auth login`, select the project you will use, and verify that the
account can enable APIs, create a service account, create a Workload Identity
Pool/provider, and grant the service-account IAM binding.

The sequence below creates the service account exactly once, then creates the
identity pool/provider and prints the values needed by GitHub. The provider
condition admits only this repository, its numeric repository and owner IDs,
the `master` ref, and this workflow file. Numeric IDs prevent a later
repository rename or name reuse from broadening access. If any resource already
exists, skip its corresponding `create` command; do not create a second service
account because a publisher can have only one linked service account.

```sh
CWS_PROJECT_ID="your-google-cloud-project"
CWS_WIF_POOL_ID="github-actions"
CWS_WIF_PROVIDER_ID="chrome-webstore-master"
CWS_SERVICE_ACCOUNT_ID="chrome-webstore-publisher"
CWS_SERVICE_ACCOUNT="${CWS_SERVICE_ACCOUNT_ID}@${CWS_PROJECT_ID}.iam.gserviceaccount.com"

gcloud auth login
gcloud config set project "${CWS_PROJECT_ID}"

gcloud services enable \
  chromewebstore.googleapis.com \
  sts.googleapis.com \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${CWS_PROJECT_ID}"

gcloud iam service-accounts create "${CWS_SERVICE_ACCOUNT_ID}" \
  --project="${CWS_PROJECT_ID}"

gcloud iam workload-identity-pools create "${CWS_WIF_POOL_ID}" \
  --project="${CWS_PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions"

CWS_PROJECT_NUMBER="$(gcloud projects describe "${CWS_PROJECT_ID}" --format="value(projectNumber)")"
CWS_POOL_RESOURCE="projects/${CWS_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${CWS_WIF_POOL_ID}"

gcloud iam workload-identity-pools providers create-oidc "${CWS_WIF_PROVIDER_ID}" \
  --project="${CWS_PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${CWS_WIF_POOL_ID}" \
  --display-name="ScreenSilo Chrome publisher" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref" \
  --attribute-condition="assertion.repository_id == '1042139441' && assertion.repository_owner_id == '14910239' && assertion.repository == 'lmn451/screencast' && assertion.ref == 'refs/heads/master' && assertion.workflow_ref == 'lmn451/screencast/.github/workflows/publish-chrome.yml@refs/heads/master'"

gcloud iam service-accounts add-iam-policy-binding "${CWS_SERVICE_ACCOUNT}" \
  --project="${CWS_PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${CWS_POOL_RESOURCE}/attribute.repository_id/1042139441"

CWS_WORKLOAD_IDENTITY_PROVIDER="${CWS_POOL_RESOURCE}/providers/${CWS_WIF_PROVIDER_ID}"
printf 'CWS_WORKLOAD_IDENTITY_PROVIDER=%s\n' "${CWS_WORKLOAD_IDENTITY_PROVIDER}"
printf 'CWS_CHROME_WEBSTORE_SERVICE_ACCOUNT=%s\n' "${CWS_SERVICE_ACCOUNT}"
```

After the command completes, copy the printed service-account email into the
Chrome Web Store Developer Dashboard under **Account** to link it to this
publisher. Google currently allows one service account per publisher. The
commands above create no long-lived credential. Wait for Google IAM changes to
propagate, then store the printed provider resource as
`GCP_WORKLOAD_IDENTITY_PROVIDER` and the printed service-account email as
`CHROME_WEBSTORE_SERVICE_ACCOUNT` in the `chrome-store` environment. The action uses
`google-github-actions/auth@v3` with `token_format: access_token` and a bounded
`3600s` service-account access token lifetime. It requests the
`https://www.googleapis.com/auth/chromewebstore` scope. See Google's
[Workload Identity Federation action setup](https://github.com/google-github-actions/auth#workload-identity-federation)
for the provider and service-account relationship.

The workflow uses the v2 upload, status, and publish contracts documented in
[media.upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload),
[publishers.items.fetchStatus](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus),
and [publishers.items.publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish).

Manual Chrome Web Store steps

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
