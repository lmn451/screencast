# CaptureCast Critical Issues Fix - Specification

**Version:** 1.0  
**Date:** 2026-05-07  
**Status:** Draft for Consensus Review

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [Functional Requirements](#2-functional-requirements)
3. [Non-Functional Requirements](#3-non-functional-requirements)
4. [Implicit Requirements](#4-implicit-requirements)
5. [Out of Scope](#5-out-of-scope)
6. [Tech Stack Decisions](#6-tech-stack-decisions)
7. [Architecture Overview](#7-architecture-overview)
8. [File Structure](#8-file-structure)
9. [Dependencies](#9-dependencies)
10. [API Definitions](#10-api-definitions)
11. [Architecture Decision Record (ADR)](#11-architecture-decision-record-adr)
12. [Acceptance Criteria](#12-acceptance-criteria)
13. [Task Breakdown](#13-task-breakdown)
14. [Risk Register](#14-risk-register)

---

## 1. Purpose

This document defines the specification for fixing critical issues identified during the research phase of the CaptureCast Chrome extension. The fixes address:

1. **Consent tracking bug** (array overwrite at consent.js:123)
2. **Mode validation weakness** (consent.js:10-17)
3. **Service worker timer loss** on suspend
4. **No active session recovery** on SW startup
5. **SW termination handling** during active recording

---

## 2. Functional Requirements

### 2.1 Consent Tracking (FR-CONSENT)

| ID             | Requirement                                    | Acceptance Criteria                                                                                         |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| FR-CONSENT-001 | Fix array overwrite bug in consent.js:123      | Consent records accumulate (append) rather than overwrite. Each capture session has a unique consent entry. |
| FR-CONSENT-002 | Strengthen mode validation in consent.js:10-17 | All valid modes are explicitly whitelisted. Invalid modes throw clear errors.                               |

### 2.2 Service Worker Resilience (FR-SW)

| ID        | Requirement                            | Acceptance Criteria                                                                                     |
| --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| FR-SW-001 | Handle timer loss on SW suspend        | All timer-based state is persisted. No critical timers lost during normal operation.                    |
| FR-SW-002 | Implement active session recovery      | Partially completed recordings can be identified and resumed. Session state reconstructed from storage. |
| FR-SW-003 | Handle SW termination during recording | Recording state checkpointed at intervals. Media chunks flushed before SW timeout.                      |

### 2.3 Media Capture (FR-CAP)

| ID         | Requirement                     | Acceptance Criteria                                                                                   |
| ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| FR-CAP-001 | Support mic using PAGE strategy | When mic enabled, use content script strategy (not offscreen). Fallback to screen-only if mic denied. |

### 2.4 Overlay (FR-OVERLAY)

| ID             | Requirement                          | Acceptance Criteria                                                         |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| FR-OVERLAY-001 | Handle injection failures gracefully | Overlay fails silently on protected pages. User informed to stop via popup. |

---

## 3. Non-Functional Requirements

| ID           | Requirement                             | Criteria                                          |
| ------------ | --------------------------------------- | ------------------------------------------------- |
| NFR-PERF-001 | Checkpoint overhead < 50ms              | Chunk flush is async and non-blocking             |
| NFR-PERF-002 | Recovery completes < 2s                 | Recovery scanning is batched                      |
| NFR-REL-001  | No data loss during normal SW lifecycle | Checkpoint interval prevents > 30s data loss      |
| NFR-REL-002  | Graceful degradation on SW suspend      | SW suspend doesn't crash extension                |
| NFR-UX-001   | Clear user feedback                     | All failure modes have user-visible notifications |
| NFR-UX-002   | Transparent recovery                    | User notified of recovered sessions               |

---

## 4. Implicit Requirements

| ID             | Requirement                | Criteria                                                |
| -------------- | -------------------------- | ------------------------------------------------------- |
| IR-PERSIST-001 | Session state persistence  | Session metadata in IndexedDB, chunk references tracked |
| IR-PERSIST-002 | IndexedDB chunk management | Chunks saved as Blob, 3 retries on failure              |
| IR-CHROME-001  | Chrome API limitations     | All Chrome API calls have error handlers                |
| IR-COMPAT-001  | Backward compatibility     | Existing consent data migrated                          |
| IR-TAB-001     | Tab ID management          | Tab IDs not relied upon for long-term recovery          |

---

## 5. Out of Scope

| Item                          | Reason                             |
| ----------------------------- | ---------------------------------- |
| Consent flow redesign         | Requires separate design effort    |
| Full SW architecture redesign | Exceeds scope; targeted fixes only |
| Cloud backup/sync             | Beyond current scope               |
| Multi-device recovery         | Requires backend infrastructure    |
| Custom codec support          | Platform limitation                |

---

## 6. Tech Stack Decisions

### 6.1 Chrome MV3 APIs

| API                        | Usage                      | Rationale                                |
| -------------------------- | -------------------------- | ---------------------------------------- |
| chrome.offscreen           | Primary recording (no mic) | Isolated execution for MediaRecorder     |
| chrome.scripting           | Overlay injection          | executeScript for overlay.js             |
| chrome.storage.local       | Session snapshots          | Unlimited quota, survives SW termination |
| chrome.runtime.sendMessage | Inter-component messaging  | Bi-directional messaging                 |
| chrome.tabs                | Recorder page management   | Creates dedicated recorder tabs          |
| IndexedDB                  | Chunk persistence          | Unlimited quota in extensions            |

### 6.2 State Management Pattern

Single source of truth in service worker with snapshot persistence.

```
┌─────────────────────────────────────────────────────────────┐
│                    Service Worker                          │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ STATE object (in-memory)                             │  │
│  │ - status: STATE_* constants                         │  │
│  │ - recordingId, startedAt, lastActivityAt            │  │
│  └─────────────────────────────────────────────────────┘  │
│                           │                               │
│                    persistSessionSnapshot()                │
│                           ▼                               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ chrome.storage.local (sessionSnapshot)              │  │
│  │ - Survives SW termination                           │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Architecture Overview

### 7.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Extension Popup                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ chrome.runtime.sendMessage
┌─────────────────────────────────────────────────────────────────────────┐
│                      Background Service Worker                           │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ STATE    │  │ Session    │  │ Message      │  │ Overlay         │    │
│  │ Manager  │  │ Snapshot   │  │ Router       │  │ Manager         │    │
│  └──────────┘  └────────────┘  └──────────────┘  └─────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
                    │                       │
          ┌─────────┴─────────┐  ┌────────┴─────────┐
          ▼                   ▼  ▼                 ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Offscreen Doc   │  │  Recorder Page   │  │  Target Tab     │
│  (screen only)   │  │  (mic capture)   │  │  (overlay.js)   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │    IndexedDB    │
                    └─────────────────┘
```

### 7.2 Patterns Used

| Pattern              | Application                       |
| -------------------- | --------------------------------- |
| Snapshot Pattern     | Session state persistence         |
| Strategy Pattern     | offscreen vs page execution       |
| State Machine        | STATE\_\* constants + transitions |
| Message Schema       | Type safety, validation           |
| Graceful Degradation | Overlay injection failures        |

---

## 8. File Structure

```
/Users/applesucks/dev/screencast/
├── consent.js                    # [MODIFY] FR-CONSENT-001, FR-CONSENT-002
├── background.js                 # [MODIFY] FR-SW-001, FR-SW-002, FR-SW-003
├── overlay.js                    # [MODIFY] FR-OVERLAY-001
├── recorder.js                   # [MODIFY] FR-CAP-001
├── chunkStorage.js               # Chunk save with 3-retry logic
├── db.js                         # DB wrapper
├── constants.js                  # Shared constants
├── recovery.html                 # [NEW] Recovery UI page
├── recovery.js                   # [NEW] Recovery logic
└── dist/                         # Bundled output
```

---

## 9. Dependencies

### 9.1 Chrome APIs (No npm packages typically needed)

- `chrome.offscreen` - Offscreen document creation
- `chrome.scripting` - Script injection
- `chrome.storage.local` - Session persistence
- `chrome.runtime` - Messaging
- `chrome.tabs` - Tab management
- `chrome.action` - Badge updates

### 9.2 Required Reading

| Document                          | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| docs/MEDIARECORDER_GUIDE.md       | MediaRecorder error handling             |
| docs/STORAGE_FAILURE_MATRIX.md    | IndexedDB limits, retry logic            |
| docs/PERMISSION_MATRIX.md         | getDisplayMedia/getUserMedia constraints |
| docs/OVERLAY_SECURITY_ANALYSIS.md | Overlay injection boundaries             |

---

## 10. API Definitions

### 10.1 Message Protocol

#### Inbound (Popup → SW)

| Message   | Fields                 | Handler          |
| --------- | ---------------------- | ---------------- |
| START     | mode, mic, systemAudio | startRecording() |
| STOP      | —                      | stopRecording()  |
| GET_STATE | —                      | —                |

#### Outbound (SW → Components)

| Message         | Target        | Fields                          |
| --------------- | ------------- | ------------------------------- |
| OFFSCREEN_START | offscreen     | mode, includeAudio, recordingId |
| RECORDER_STOP   | recorder page | —                               |
| STATE_UPDATE    | overlay       | status                          |

### 10.2 Session Snapshot Schema

```javascript
{
  recordingId: string,           // UUID of active recording
  status: STATE_*,               // Current recording state
  startedAt: number,             // Unix timestamp (ms)
  lastActivityAt: number,        // Unix timestamp (ms)
  options: {
    mode: 'tab' | 'screen' | 'window',
    includeMic: boolean,
    includeSystemAudio: boolean
  },
  strategy: 'offscreen' | 'page',
  correlationId: string
}
```

### 10.3 Key Functions

#### background.js

```javascript
startRecording(mode, includeMic, includeSystemAudio): Promise<{ok, error?, overlayInjected?}>
stopRecording(): Promise<{ok, error?}>
persistSessionSnapshot(extra?): Promise<void>
clearSessionSnapshot(): Promise<void>
reconcileUnfinishedSessions(): Promise<void>
```

#### consent.js

```javascript
validateMode(mode): { valid: boolean, error?: string }
// Valid modes: 'tab', 'screen', 'window'
loadParams(): Promise<{ mode, mic, systemAudio }>
```

#### chunkStorage.js

```javascript
saveChunk(recordingId, chunk, index): Promise<void>  // With 3-retry
getChunks(recordingId): Promise<Array>
markRecordingRecoverable(recordingId): Promise<void>
```

---

## 11. Architecture Decision Record (ADR)

### 11.1 Open Questions (Pending)

| ID     | Question                                                                   | Options                                                                                     | Status      |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------- |
| OQ-001 | **Recovery Mode**: Should session recovery be automatic or user-initiated? | (A) Auto-resume<br>(B) User-initiated via recovery UI<br>(C) Auto-resume with cancel option | **PENDING** |
| OQ-002 | **Checkpoint Interval**: What chunk checkpoint interval?                   | (A) 30 seconds<br>(B) 60 seconds<br>(C) Configurable                                        | **PENDING** |
| OQ-003 | **Background Sync API**: Can it be used as fallback?                       | (A) Yes<br>(B) No<br>(C) Investigate further                                                | **PENDING** |

### 11.2 Decisions (Decided)

| ID      | Decision                                       | Rationale                                                              | Status      |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ----------- |
| DEC-001 | Use PAGE strategy for microphone capture       | Offscreen cannot use getUserMedia(). PAGE strategy uses dedicated tab. | **DECIDED** |
| DEC-002 | Timestamp-based reconciliation                 | No heartbeat pings. Session age from lastActivityAt.                   | **DECIDED** |
| DEC-003 | Persist session snapshot on every state change | SW termination loses in-memory timers. Snapshot survives.              | **DECIDED** |
| DEC-004 | 3-retry with PARTIAL/FAILED marking            | Chunk save fails retry 3 times. Recording marked recoverable.          | **DECIDED** |
| DEC-005 | Overlay injection is best-effort               | Script fails on restricted pages. Don't block recording.               | **DECIDED** |

### 11.3 Approvals

- (none yet - awaiting consensus review)

### 11.4 Rejections

- (none yet)

---

## 12. Acceptance Criteria

### 12.1 Consent Tracking

- [ ] **AC-CONSENT-001**: Consent records accumulate rather than overwrite
- [ ] **AC-CONSENT-002**: Invalid modes throw clear, actionable errors
- [ ] **AC-CONSENT-003**: Mode validation happens at function entry

### 12.2 Service Worker Resilience

- [ ] **AC-SW-001**: Timer-based state persisted before SW suspend
- [ ] **AC-SW-002**: Active sessions recoverable on SW startup
- [ ] **AC-SW-003**: Checkpoints occur at configurable intervals (default 30s)
- [ ] **AC-SW-004**: Recovery completes within 2 seconds

### 12.3 Media Capture

- [ ] **AC-CAP-001**: Microphone capture uses PAGE strategy (not offscreen)
- [ ] **AC-CAP-002**: Graceful degradation when mic permission denied

### 12.4 Overlay

- [ ] **AC-OVERLAY-001**: Overlay fails silently on chrome://, about://, devtools://, PDF
- [ ] **AC-OVERLAY-002**: User can stop recording via popup on protected pages

---

## 13. Task Breakdown

### Task 1: Fix Consent Tracking Bug (FR-CONSENT-001)

| Field            | Value                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------- |
| **Files**        | consent.js                                                                                |
| **Lines**        | Line 123                                                                                  |
| **Bug**          | `sessionStorage.setItem(key, JSON.stringify(entry))` should be `JSON.stringify(existing)` |
| **Verification** | Consent records accumulate correctly                                                      |

### Task 2: Strengthen Mode Validation (FR-CONSENT-002)

| Field            | Value                                      |
| ---------------- | ------------------------------------------ |
| **Files**        | consent.js                                 |
| **Lines**        | Lines 10-17                                |
| **Change**       | Add whitelist validation before processing |
| **Verification** | Invalid modes rejected with clear error    |

### Task 3: Implement Session Snapshot Persistence (FR-SW-001, FR-SW-003)

| Field            | Value                                              |
| ---------------- | -------------------------------------------------- |
| **Files**        | background.js                                      |
| **Change**       | Add persistSessionSnapshot() on every state change |
| **Change**       | Add periodicSnapshot() with interval timer         |
| **Verification** | Session state survives SW restart                  |

### Task 4: Implement Active Session Recovery (FR-SW-002)

| Field            | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Files**        | background.js, recovery.html, recovery.js                      |
| **Change**       | Update reconcileUnfinishedSessions() to detect active sessions |
| **Change**       | Create recovery UI for user-initiated recovery                 |
| **Verification** | Active sessions recoverable after SW restart                   |

### Task 5: Support PAGE Strategy for Mic (FR-CAP-001)

| Field            | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Files**        | background.js, recorder.js                                     |
| **Change**       | Ensure mic-enabled recording uses recorder page, not offscreen |
| **Verification** | Microphone capture works when enabled                          |

### Task 6: Handle Overlay Injection Failures (FR-OVERLAY-001)

| Field            | Value                                               |
| ---------------- | --------------------------------------------------- |
| **Files**        | overlay.js                                          |
| **Change**       | Fail silently on protected pages with console debug |
| **Change**       | Ensure popup provides stop control                  |
| **Verification** | No errors on chrome:// URLs                         |

---

## 14. Risk Register

| Risk                                        | Likelihood | Impact | Mitigation                                   |
| ------------------------------------------- | ---------- | ------ | -------------------------------------------- |
| SW suspends during critical recording phase | Medium     | High   | Checkpoint strategy, graceful degradation    |
| IndexedDB quota exceeded unexpectedly       | Low        | Medium | Monitor, warn user, graceful failure         |
| Recovery creates corrupted recordings       | Low        | Medium | Validate chunk integrity, fail-safe marking  |
| Tab re-acquisition fails (tab closed)       | Medium     | Low    | Clear session termination, user notification |

---

## Requirement Coverage Map

| Requirement ID | Source Issue                           | Task   |
| -------------- | -------------------------------------- | ------ |
| FR-CONSENT-001 | Consent tracking bug (array overwrite) | Task 1 |
| FR-CONSENT-002 | Mode validation weak                   | Task 2 |
| FR-SW-001      | SW timer loss on suspend               | Task 3 |
| FR-SW-002      | No active session recovery             | Task 4 |
| FR-SW-003      | SW terminates during recording         | Task 3 |
| FR-CAP-001     | Mic in Offscreen Impossible            | Task 5 |
| FR-OVERLAY-001 | Overlay injection fails silently       | Task 6 |

---

_Document prepared by Requirements Analysis + Technical Architect subagents_  
_Awaiting consensus review via ralplan pipeline_
