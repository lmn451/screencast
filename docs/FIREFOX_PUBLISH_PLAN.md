# Firefox Add-on publishing plan

This plan publishes the reviewed Firefox package for the existing public
ScreenSilo listing. It does not create a second listing or change the AMO
account configuration.

## Target listing and release

- AMO add-on: ScreenSilo
- GUID: `screensilo@subagentura.tech`
- Numeric AMO ID reference: `3054016`
- Slug reference: `screensilo`
- Current public version: `0.2.2`
- Target release: GitHub tag `v0.2.3`, add-on version `0.2.3`
- Existing release commit: `d9536255495ca1077b5b8db97545d52531cae3f9`
- Green master push CI run for that commit: `34579352421`
- Submission channel: listed/public
- Update the existing add-on only. The publisher resolves the listing by the
  globally unique GUID and rejects a missing, mismatched, or disabled listing;
  the numeric ID and slug above are references, not independent identity
  checks.

The published `v0.2.3` GitHub release already points to commit
`d9536255495ca1077b5b8db97545d52531cae3f9`. Its successful master push CI
run is `34579352421`. Reuse that release and its exact assets after the
publishing automation is merged; do not rebuild or recreate `v0.2.3`.
The release must be non-prerelease and contain the Firefox package, the
Firefox review-source archive, and the `SHA256SUMS` file. The package and
source archive names are:

```text
screensilo-firefox-mv3-0.2.3.zip
screensilo-firefox-source-0.2.3.zip
SHA256SUMS
```

The checksums must match the downloaded assets and the manifest version must
match both the release tag and the requested AMO version.

## Provenance gates

Before an AMO request is made, the publisher verifies:

1. The release is the requested published tag and is not a prerelease.
2. The tag commit is an ancestor of the current `master` branch.
3. That same commit has a successful, completed `push` run of
   `.github/workflows/ci.yml` on `master`. For this release, the known run is
   `34579352421`.
4. The Firefox package and source archive are the expected version and match
   their entries in `SHA256SUMS`.

These checks bind the submitted ZIPs to the reviewed, green master revision.

## Workflow contract

`.github/workflows/publish-firefox.yml` is a manual `workflow_dispatch` with a
required string input named `release_tag`. It must be dispatched from
`refs/heads/master`; that check runs before checkout. The workflow then checks
out `master` with full history and without persisted credentials, uses Node.js
24 with package-manager caching disabled, and invokes:

```sh
node scripts/publish-firefox.mjs \
  --tag "$RELEASE_TAG" \
  --repo "$GITHUB_REPOSITORY"
```

The job runs in the existing `firefox-store` GitHub environment, whose
deployment branch policy is restricted to `master`. It receives only the
read-only `contents` and `actions` permissions. The environment supplies
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET`; the workflow also passes the built-in
`GITHUB_TOKEN` and `RELEASE_TAG` to the publisher. Concurrent Firefox
submissions are serialized under `firefox-addons-publish` and the job has a
15-minute timeout.

## AMO submission behavior

The publisher uses the AMO API v5. The `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET` values are long-lived environment credentials. For each
request it creates a short-lived 60-second JWT with those credentials, signs
it with HS256, and sends it as an `Authorization: JWT` header. The credentials
are never printed, and no Google service account is involved. See Mozilla's [external API
authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)
documentation for the claim and signing requirements.

The Firefox ZIP is uploaded for the `listed` channel and is allowed to finish
AMO validation before submission. Version creation targets the existing
listing and sends the `upload` UUID together with the review-source ZIP as
`source` in one multipart `POST` to the version-create endpoint. Attaching
the source in that request keeps the package and reproducibility archive
together. The publisher never calls the add-on-create route.

Upload and version-create requests have no unsafe automatic retry. If a
request outcome is ambiguous, the run stops and the operator checks AMO's
submitted version status before deciding whether a rerun is safe. Read-only
status polling may continue within the workflow timeout.

The API contracts, including version creation, upload validation, and the
multipart source field, are documented in Mozilla's [Add-ons API
reference](https://mozilla.github.io/addons-server/topics/api/addons.html).

## Execution sequence

- [x] Implement the publisher, workflow, and documentation.
- [x] Run the publisher tests on Node.js 24 (26 Chrome/Firefox publishing tests passed).
- [x] Lint the workflow with `actionlint`.
- [ ] Have an independent Luna reviewer inspect the complete diff at maximum
      effort, including the provenance gates and AMO request safety.
- [ ] Open the pull request, wait for CI, and merge the approved revision to
      `master`.
- [ ] Dispatch `Publish Firefox Add-on` from `master` with
      `release_tag=v0.2.3`, reusing the existing release and its verified
      assets.
- [ ] Verify that AMO reports version `0.2.3` for the existing ScreenSilo
      listing and record its submitted/review status separately from approval
      or publication.

The final dispatch and AMO status check happen only after the implementation,
review, CI/merge, and provenance gates above are complete; they reuse the
existing `v0.2.3` release.
