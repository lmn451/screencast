# Open Questions - CaptureCast Critical Issues Fix

## Meta

- **Date**: 2026-05-07
- **Source**: Requirements Analysis (ralplan analyst subagent)
- **Status**: Open - Awaiting Resolution

---

## Consent Tracking

- [ ] **What is the exact data structure for consent records?** — Needed for fix implementation
- [ ] **Should consent records be versioned for migration?** — Affects backward compatibility
- [ ] **Are there compliance requirements (GDPR, CCPA) for consent retention?** — Legal risk

## Session Recovery

- [ ] **Should recovery be automatic or user-initiated?** — UX design decision
- [ ] **What is the maximum acceptable recovery window? (How old can a session be?)** — Storage vs. UX tradeoff
- [ ] **Should we delete unrecoverable sessions after N days?** — Storage management

## Checkpoint Strategy

- [ ] **What is the optimal checkpoint interval? (30s default?)** — Performance vs. data loss tradeoff
- [ ] **Should checkpoints be triggered by chunk boundaries?** — Implementation approach
- [ ] **Can we use Background Sync API as fallback?** — MV3 workaround

## Tab Strategy

- [ ] **How should we handle recording across multiple tabs?** — Required for completeness
- [ ] **Should content script injection retry on protected pages?** — Current vs. improved behavior

## Testing

- [ ] **Is there a test environment for SW lifecycle simulation?** — Affects testing approach
- [ ] **What browsers/versions must be supported?** — Chrome only? Edge?

---

## Resolution Tracking

| Question            | Resolution | Resolved By | Date |
| ------------------- | ---------- | ----------- | ---- |
| (none resolved yet) |            |             |      |
