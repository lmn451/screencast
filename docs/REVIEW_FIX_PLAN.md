# Review fixes and release plan

Target: ScreenSilo 0.2.3, based on the reviewed marketplace branch. The branch includes the two existing marketplace preparation commits that have not reached master.

## Implementation

1. **Cancel startup completely.** Tear down the recorder context and invalidate pending startup before acknowledging cancellation. Verify a pending picker cannot begin untracked capture and a subsequent recording can start normally.
2. **Restore sessions before idle cleanup.** Separate service initialization from a real transition to idle. Preserve existing snapshots and capture contexts until liveness checks decide whether to restore or recover. Test delayed heartbeats, GET_STATE/STOP wakeups, and orphan recovery.
3. **Mix microphone and system audio.** Use Web Audio to combine both sources into one recorded audio track. Keep single-source recording working, and release original tracks and the audio context on stop or startup failure. Verify two distinct tones survive a native MediaRecorder round trip.
4. **Allow retries after capture denial.** Provide a safe path from failed startup back to a new session without deleting recoverable data or accepting stale lifecycle messages. Test denial followed by successful retry.
5. **Keep diagnostics in time order.** Add timestamp ordering with a persisted insertion tie breaker through a data-preserving schema migration. Trim oldest entries and retrieve newest entries using that order. Test UUID/time disagreement, equal timestamps, existing database upgrades, committed writes, and bounded storage.
6. **Prepare Chrome publishing from CI.** Add a workflow that submits an approved GitHub release through Chrome Web Store API v2 using a linked service account and GitHub OIDC. Verify the release artifact before uploading. Document the one-time Google Cloud and publisher linkage setup; no store API credentials currently exist.

Luna agents at maximum effort implement the lifecycle, audio, and diagnostics work in separate file ownership groups. Each group supplies focused regression tests.

## Verification and review

- Run all unit/integration tests, type checking, lint, production builds, and package validation.
- Run native Chromium regression tests for cancellation and mixed audio, plus the existing E2E suite. Resolve test failures before merge.
- Have independent Luna agents at maximum effort review the completed diff against all five findings and the intended release behavior. Record approval or gaps. Fix gaps and repeat review until approved.
- Keep the release version consistent in both manifests, package metadata, source-build instructions, and changelog.

## Merge and release

- Open a PR against master with concrete validation evidence; wait for required CI checks and independent review approval.
- Merge to master only after approval. Verify the merged revision and publish a versioned GitHub release with Chromium, Firefox, and review-source archives unless a different release destination is specified.
- For browser store submissions, use the existing authenticated publishing route if available. Store review is separate from code review and cannot be represented as already approved.

## Progress

- Audio mixing implemented and independently approved after adding a three-second resume timeout and cleanup for browser-blocked audio initialization.
- Lifecycle fixes use per-recording storage, an atomic durable owner and snapshot, and a browser resource lock. Regression coverage verifies delayed writes/removals from older workers, marker-only cleanup, a missing Chrome storage snapshot, transient cleanup failures, unavailable metadata/liveness checks, and preserving recorder tabs that navigate away. Recorder ownership is checked through extension contexts without adding browsing permissions. Independent Luna review at maximum effort approved the completed lifecycle changes.
- Diagnostics migration independently approved after adding a transactionally allocated insertion sequence to resolve equal timestamps. Adversarial review verified concurrent writers, migration preservation, bounded retention, and recovery after aborted writes.
- Validation: all 392 unit/integration tests pass locally, including 79 recording-service tests and 12 Chrome publishing tests. All seven native lifecycle tests pass locally. CI passed the complete 23-test Chromium E2E suite on the final lifecycle commit. Typecheck, builds, and lint pass; lint reports two existing unused-variable warnings in feedback tests.
- Preliminary release archives pass version, production-file allowlist, and integrity checks. Firefox validation reports zero errors, warnings, or notices. The review-source archive rebuilds the same packaged code (esbuild dependency-path comments differ with checkout location). Final release archives will come from merged-master CI and be checked against the merged source before upload.
- Version 0.2.3 prepared in both manifests, package metadata, changelog, and Firefox source-build instructions.
- GitHub publishing is available. Chrome has an existing public ScreenSilo 0.2.2 listing (`higbocdfimfmcjckomeggbbigcglpdje`). The user selected service-account CI setup instead of repeated browser sign-in; the one-time publisher linkage and Google Cloud identity setup are still required. Firefox and Edge publisher dashboards still require local user sign-in.
- The GitHub `chrome-store` environment is prepared and permits deployments from `master` only. Google Cloud service-account/provider configuration is not yet set. The publishing workflow, script, and setup guide are independently approved after corrections to asynchronous upload handling, response-loss recovery, and token lifetime. No store submission has been performed.
- Beads is unavailable in the current environment (`bd` is not installed); this document records the work plan and review outcome.
