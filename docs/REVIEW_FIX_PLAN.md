# Review fixes and release plan

Target: ScreenSilo 0.2.3, based on the reviewed marketplace branch. The branch includes the two existing marketplace preparation commits that have not reached master.

## Implementation

1. **Cancel startup completely.** Tear down the recorder context and invalidate pending startup before acknowledging cancellation. Verify a pending picker cannot begin untracked capture and a subsequent recording can start normally.
2. **Restore sessions before idle cleanup.** Separate service initialization from a real transition to idle. Preserve existing snapshots and capture contexts until liveness checks decide whether to restore or recover. Test delayed heartbeats, GET_STATE/STOP wakeups, and orphan recovery.
3. **Mix microphone and system audio.** Use Web Audio to combine both sources into one recorded audio track. Keep single-source recording working, and release original tracks and the audio context on stop or startup failure. Verify two distinct tones survive a native MediaRecorder round trip.
4. **Allow retries after capture denial.** Provide a safe path from failed startup back to a new session without deleting recoverable data or accepting stale lifecycle messages. Test denial followed by successful retry.
5. **Keep diagnostics in time order.** Add a timestamp index through a data-preserving schema migration. Trim oldest entries and retrieve newest entries using that index. Test UUID/time disagreement, existing database upgrades, committed writes, and bounded storage.

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

- Plan created; implementation pending.
- Beads is unavailable in the current environment (`bd` is not installed); this document records the work plan and review outcome.
