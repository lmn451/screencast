# Migration Guide: Background.js → XState v5

This guide explains how to migrate from the imperative `background.js` state management to the new XState v5 state machine architecture.

## Table of Contents

1. [Overview](#overview)
2. [Architecture Changes](#architecture-changes)
3. [State Machine States](#state-machine-states)
4. [Migration by Function](#migration-by-function)
   - [startRecording](#startrecording)
   - [stopRecording](#stoprecording)
   - [Message Handling](#message-handling)
   - [Overlay Management](#overlay-management)
   - [Recovery & Reconciliation](#recovery--reconciliation)
5. [Component Impact](#component-impact)
6. [Testing Strategy](#testing-strategy)

---

## Overview

### Before (background.js)
```
Global STATE object → Manual state transitions → Event-driven message handlers
```

**Problems:**
- State scattered across multiple variables
- No clear state transition validation
- Hard to test state logic in isolation
- Race conditions possible with concurrent operations
- Difficult to add new states without breaking existing code

### After (XState v5)
```
RecordingStateManager → State Machine → Typed Events → Predictable Transitions
```

**Benefits:**
- Single source of truth for state
- Declarative state transitions
- Type-safe event handling
- Built-in entry/exit actions
- Self-documenting state diagram

---

## Architecture Changes

### Old Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       background.js                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ STATE object │  │ Handlers    │  │ Helper Functions    │  │
│  │ - status     │  │ - onMessage │  │ - validateTransition│  │
│  │ - options    │  │ - onInstall │  │ - persistSnapshot   │  │
│  │ - tabIds     │  │ - onStartup │  │ - updateBadge      │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### New Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           background-xstate.js                          │
│                         (Integration Layer)                             │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      RecordingService                           │    │
│  │  - Wraps XState machine                                          │    │
│  │  - Handles Chrome API calls                                      │    │
│  │  - Routes messages to machine events                             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                     │                                   │
│                                     ▼                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     recordingMachine.ts                         │    │
│  │                                                                   │    │
│  │   ┌───────┐    ┌──────────┐    ┌──────────┐    ┌───────┐        │    │
│  │   │ idle  │───►│ starting │───►│ recording│───►│stopping│        │    │
│  │   └───────┘    └──────────┘    └──────────┘    └───────┘        │    │
│  │                         │              │              │          │    │
│  │                         ▼              ▼              ▼          │    │
│  │                   ┌──────────┐   ┌─────────┐   ┌─────────┐     │    │
│  │                   │  failed  │   │ saved   │   │recoverable│   │    │
│  │                   └──────────┘   └─────────┘   └─────────┘     │    │
│  │                                                                   │    │
│  │   States: idle | starting | recording | stopping | saving |     │    │
│  │           saved | failed | recoverable                           │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## State Machine States

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           STATE TRANSITIONS                              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   idle ──START──────────────────────► starting                           │
│    ▲                                      │                              │
│    │                                      ├── OFFSCREEN_STARTED ───────►│
│    │                                      ├── RECORDER_STARTED ───────►│
│    │                                      ├── CONFIRMATION_TIMEOUT ───►│
│    │                                      │                              │
│    │                                      ├── OFFSCREEN_ERROR ──────► failed
│    │                                      └── RECORDER_ERROR ───────► failed
│    │                                                                   │
│    │   recoverable ───────────── RECOVERY_DISCARD ───────────────► idle │
│    │        │                                                       │
│    │        │                                                      │
│    │        ▼                                                      │
│    │   stopping ──────────OFFSCREEN_DATA/RECORDER_DATA────► saving    │
│    │        │                                                   │      │
│    │        │                                                   ▼      │
│    │        │                                              ┌────────┐   │
│    │        └──SAVE_TIMEOUT───────────────────────────────►│recover-│   │
│    │                                                   │    │able    │   │
│    │                                                   │    └────────┘   │
│    │                                                   │        │        │
│    │                                                   └────────┬───────┘
│    │                                                            │
│    ▼                                                            ▼
│  idle ◄───────────────────────────────────────────── RESET/DISCARD
│                                                                          │
│                                            saved ─(after 1s)──► idle    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Migration by Function

### startRecording

#### Before (background.js)

```javascript
async function startRecording(mode, includeMic, includeSystemAudio) {
  // 1. Validate state transition
  const transition = validateStateTransition(STATE.status, STATE_STARTING);
  if (!transition.valid) {
    logger.warn('Invalid state transition:', transition.error);
    return { ok: false, error: transition.error };
  }
  if (STATE.status !== STATE_IDLE) {
    return { ok: false, error: 'Already recording or saving' };
  }

  // 2. Check for concurrent recording
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    const snapshot = result[SESSION_SNAPSHOT_KEY];
    if (snapshot) {
      const activeStatuses = [STATE_STARTING, STATE_RECORDING, STATE_STOPPING, STATE_SAVING];
      if (activeStatuses.includes(snapshot.status)) {
        const age = Date.now() - snapshot.lastActivityAt;
        if (age < 30000) {
          return { ok: false, error: 'Recording already in progress' };
        }
      }
    }
  } catch (e) {
    logger.warn('Failed to check for concurrent recording:', e);
  }

  // 3. Check storage quota
  const storageCheck = await checkStorageQuota();
  if (!storageCheck.ok) {
    return { ok: false, error: storageCheck.error };
  }

  // 4. Initialize state
  const now = Date.now();
  STATE.startedAt = now;
  STATE.lastActivityAt = now;
  STATE.options = { mode, includeMic: !!includeMic, includeSystemAudio: !!includeSystemAudio };
  STATE.status = STATE_STARTING;
  STATE.recordingId = crypto.randomUUID();
  STATE.correlationId = crypto.randomUUID();
  STATE.overlayTabId = await getActiveTabId();

  // 5. Persist session snapshot
  await persistSessionSnapshot();

  // 6. Choose strategy and start
  const useOffscreen = !STATE.options.includeMic && canUseOffscreen();

  if (useOffscreen) {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      mode,
      includeAudio: STATE.options.includeSystemAudio,
      recordingId: STATE.recordingId,
      targetTabId: STATE.overlayTabId,
    });
    STATE.strategy = 'offscreen';
  } else {
    const url = chrome.runtime.getURL(
      `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(mode)}&mic=${...}&sys=${...}`
    );
    const tab = await chrome.tabs.create({ url, active: true });
    STATE.recorderTabId = tab.id ?? null;
    STATE.strategy = 'page';
  }

  // 7. Inject overlay
  let overlayInjected = false;
  if (STATE.overlayTabId) {
    overlayInjected = await injectOverlay(STATE.overlayTabId);
  }

  // 8. Set confirmation timeout
  const confirmationTimeout = setTimeout(() => {
    if (STATE.status === STATE_STARTING) {
      logger.warn('No confirmation received within 5 seconds, falling back to RECORDING');
      STATE.status = STATE_RECORDING;
      STATE.lastActivityAt = Date.now();
      persistSessionSnapshot();
      updateBadge();
    }
  }, 5000);
  STATE.stopTimeoutId = confirmationTimeout;

  // 9. Start checkpoint timer
  startCheckpointTimer();

  return { ok: true, overlayInjected };
}
```

#### After (recordingService.ts)

```typescript
async startRecording(
  mode: 'tab' | 'window' | 'screen',
  includeMic: boolean,
  includeSystemAudio: boolean
): Promise<{ ok: boolean; error?: string; overlayInjected?: boolean }> {
  // 1. Check storage quota
  const quotaCheck = await checkStorageQuota();
  if (!quotaCheck.ok) {
    return { ok: false, error: quotaCheck.error };
  }

  // 2. Send START event to machine - validation happens automatically
  this.manager.send({
    type: 'START',
    mode,
    mic: includeMic,
    systemAudio: includeSystemAudio,
  });

  const context = this.manager.getSnapshot().context;

  // 3. Inject overlay on active tab
  let overlayInjected = false;
  const [activeTab] = await this.chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    overlayInjected = await this.injectOverlay(activeTab.id);
    this.manager.send({ type: 'UPDATE_STATE', status: 'recording' });
  }

  // 4. Set confirmation timeout
  this.confirmationTimeout = setTimeout(() => {
    this.manager.send({ type: 'CONFIRMATION_TIMEOUT' });
  }, TIMEOUTS.CONFIRMATION);

  // 5. Start checkpoint timer
  this.startCheckpointTimer();

  return { ok: true, overlayInjected };
}
```

#### Key Changes

| Aspect | Before | After |
|--------|--------|-------|
| State validation | Manual `validateStateTransition()` | Built into machine transitions |
| Concurrent check | Manual check in function | Handled by machine context |
| State initialization | Manual property assignments | `assign()` in `idle.on.START` |
| Strategy selection | Manual `useOffscreen` check | Machine sets strategy in `starting` entry |
| Timeout handling | Stored in `STATE.stopTimeoutId` | Stored in service as `confirmationTimeout` |
| Checkpoint timer | Global `startCheckpointTimer()` | Service method `startCheckpointTimer()` |

---

### stopRecording

#### Before (background.js)

```javascript
async function stopRecording() {
  // 1. Validate state transition
  const transition = validateStateTransition(STATE.status, STATE_STOPPING);
  if (!transition.valid) {
    logger.warn('Invalid state transition:', transition.error);
    return { ok: false, error: transition.error };
  }
  if (STATE.status !== STATE_RECORDING) {
    return { ok: false, error: 'Not recording' };
  }

  // 2. Transition to STOPPING
  STATE.status = STATE_STOPPING;
  STATE.lastActivityAt = Date.now();
  stopCheckpointTimer();
  await persistSessionSnapshot();
  await updateBadge();

  // 3. Remove overlay (best-effort)
  try {
    if (STATE.overlayTabId) {
      try {
        await chrome.tabs.sendMessage(STATE.overlayTabId, { type: 'OVERLAY_REMOVE' });
      } catch (sendErr) {
        logger.warn('Overlay sendMessage failed:', sendErr);
      }
      await removeOverlay(STATE.overlayTabId);
    }
  } catch (e) {
    logger.warn('Overlay removal in stopRecording failed:', e);
  }

  // 4. Set safety timeout
  if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
  STATE.stopTimeoutId = setTimeout(async () => {
    logger.error(`Save timeout reached - forcing reset`);
    await clearSessionSnapshot();
    await resetRecordingState();
  }, STOP_TIMEOUT_MS);

  // 5. Send stop message to recorder/offscreen
  try {
    if (STATE.strategy === 'page') {
      await chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
    } else {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    }
  } catch (e) {
    return { ok: false, error: 'Failed to send stop signal: ' + e.message };
  }

  return { ok: true };
}
```

#### After (recordingService.ts)

```typescript
async stopRecording(): Promise<{ ok: boolean; error?: string }> {
  // 1. Validate state
  const state = this.manager.getSnapshot().value;
  if (state !== 'recording') {
    return { ok: false, error: `Cannot stop: invalid state ${state}` };
  }

  // 2. Send STOP event
  this.manager.send({ type: 'STOP' });

  // 3. Set save timeout
  this.saveTimeout = setTimeout(() => {
    this.manager.send({ type: 'SAVE_TIMEOUT' });
  }, TIMEOUTS.SAVE);

  // 4. Send stop message based on strategy
  const context = this.manager.getSnapshot().context;
  if (context.strategy === 'offscreen') {
    await this.chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  } else {
    await this.chrome.runtime.sendMessage({ type: 'RECORDER_STOP' });
  }

  return { ok: true };
}
```

#### Key Changes

| Aspect | Before | After |
|--------|--------|-------|
| State validation | `validateStateTransition(STATE.status, STATE_STOPPING)` | `state !== 'recording'` check |
| State transition | `STATE.status = STATE_STOPPING` | `manager.send({ type: 'STOP' })` |
| Overlay removal | In-function with try/catch | In `cleanup()` method |
| Safety timeout | Manual `setTimeout` with reset | Machine handles via `SAVE_TIMEOUT` event |
| Checkpoint stop | `stopCheckpointTimer()` call | In `cleanup()` |
| Stop message | `if (STATE.strategy === 'page')` | `context.strategy === 'offscreen'` |

---

### Message Handling

#### Before (background.js)

```javascript
// Global message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'OFFSCREEN_STARTED':
          handleOffscreenStarted(message);
          break;
        case 'RECORDER_STARTED':
          handleRecorderStarted(message);
          break;
        case 'OFFSCREEN_DATA':
          await handleOffscreenData(message);
          break;
        case 'RECORDER_DATA':
          await handleRecorderData(message);
          break;
        // ... more handlers
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
```

#### After (recordingService.ts)

```typescript
async handleMessage(
  message: Record<string, unknown>,
  sender: { id: string }
): Promise<{ ok: boolean; error?: string } | null> {
  // 1. Validate sender
  if (sender.id !== this.chrome.runtime.id) {
    return { ok: false, error: 'Unauthorized sender' };
  }

  // 2. Rate limiting
  if (!checkRateLimit(sender.id)) {
    return { ok: false, error: 'Rate limited' };
  }

  // 3. Validate message against schema
  const schema = schemas[message.type as string];
  if (!schema) {
    return { ok: false, error: 'Unknown message type' };
  }
  const validation = validateMessageStrict(message as any, schema);
  if (!validation.valid) {
    return { ok: false, error: `Validation failed: ${validation.errors.join(', ')}` };
  }

  // 4. Route to handlers
  switch (message.type) {
    case 'START':
      return await this.startRecording(message.mode, message.mic, message.systemAudio);
    case 'STOP':
      return await this.stopRecording();
    case 'OFFSCREEN_STARTED':
      await this.handleOffscreenStarted();
      return { ok: true };
    case 'RECORDER_STARTED':
      await this.handleRecorderStarted();
      return { ok: true };
    case 'OFFSCREEN_DATA':
      await this.handleOffscreenData(message.recordingId, message.mimeType);
      return { ok: true };
    // ... more cases
  }
}
```

#### Key Changes

| Aspect | Before | After |
|--------|--------|-------|
| Validation | None | Schema validation via `schemas` |
| Sender check | None | `sender.id !== this.chrome.runtime.id` |
| Rate limiting | `checkRateLimit()` global | `checkRateLimit()` in service |
| State update | Manual `STATE.status = X` | Machine state transitions |
| Handlers | Scattered functions | `handleX()` methods on service |

---

### Overlay Management

#### Before (background.js)

```javascript
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    logger.log('Overlay injection failed:', e.message);
    return false;
  }
}

async function removeOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById('cc-overlay');
        if (el) el.remove();
      },
    });
  } catch (e) {
    logger.warn('Overlay removal failed:', e);
  }
}
```

#### After (recordingService.ts)

```typescript
private async injectOverlay(tabId: number): Promise<boolean> {
  try {
    await this.chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    console.log('[RecordingService] Overlay injection failed:', e);
    return false;
  }
}

private async removeOverlay(tabId: number): Promise<void> {
  // Handled via OVERLAY_REMOVE message to overlay
  // Or via cleanup() method
}
```

**Key Changes:**

| Aspect | Before | After |
|--------|--------|-------|
| Location | Standalone functions | Service methods |
| Error handling | `logger.warn()` | `console.log/warn` |
| Tab ID source | `STATE.overlayTabId` | `context.overlayTabId` |

---

### Recovery & Reconciliation

#### Before (background.js)

Recovery was handled in `resetRecordingState()` with manual state clearing.

#### After (recordingService.ts + machine)

Recovery uses machine states `recoverable`, `failed` with events:

```typescript
// Machine states
recoverable: {
  on: {
    RECOVERY_DISCARD: { target: 'idle' },
    OFFSCREEN_DATA: { target: 'saved' },
    RECORDER_DATA: { target: 'saved' },
    RESET: { target: 'idle' },
  },
},

// background-xstate.js reconciliation
async function reconcileUnfinishedSessions() {
  const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
  const snapshot = result[SESSION_SNAPSHOT_KEY];
  
  if (age > STOP_TIMEOUT_MS) {
    // Stale session - clean up
    await chrome.storage.local.remove(SESSION_SNAPSHOT_KEY);
    // Check for partial recordings and mark recoverable
  } else {
    // Active session - show recovery prompt
    if (snapshot.status === 'recording' || snapshot.status === 'stopping') {
      await showRecoveryPrompt(snapshot);
    }
  }
}
```

---

## Component Impact

### Popup

**Before:**
```javascript
// popup.js
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  updateUI(response.status, response.recordingId);
});
```

**After:**
```typescript
// popup.js
const service = getRecordingService();
const state = service.getState();
// state = { status, recordingId, correlationId, startedAt, options, ... }
```

**Changes:**
- State is now typed via `RecordingContext`
- Direct access to `context.options`, `context.strategy`, etc.
- `status` is now the machine state string (`idle`, `recording`, etc.)

### Offscreen Document

**Before:**
```javascript
// offscreen.js
chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED', success: true });
```

**After:**
```typescript
// offscreen.js - unchanged, just sends the same message
chrome.runtime.sendMessage({ type: 'OFFSCREEN_STARTED' });
```

**Changes:**
- No API changes needed
- Machine handles `OFFSCREEN_STARTED` event → transitions to `recording`

### Recorder Tab

**Before:**
```javascript
// recorder.js
chrome.runtime.sendMessage({ type: 'RECORDER_STARTED', recordingId });
```

**After:**
```typescript
// recorder.js - unchanged
chrome.runtime.sendMessage({ type: 'RECORDER_STARTED', recordingId });
```

**Changes:**
- No API changes needed

### Overlay

**Before:**
```javascript
// overlay.js receives
{ type: 'OVERLAY_REMOVE' }
```

**After:**
```javascript
// overlay.js - unchanged
{ type: 'OVERLAY_REMOVE' }
```

**Changes:**
- Overlay removal happens in `cleanup()` via `removeOverlay()`
- Can also be triggered by message

---

## Testing Strategy

### Before

```javascript
// background.test.js
function testStartRecording() {
  // Mock STATE
  // Call startRecording()
  // Assert STATE.status changed
  // Hard to test edge cases
}
```

### After

```typescript
// recordingMachine.test.ts
import { recordingMachine } from './recordingMachine';

describe('Recording Machine', () => {
  it('should transition from idle to recording on START', () => {
    const actor = createActor(recordingMachine);
    actor.start();
    
    actor.send({ type: 'START', mode: 'tab', mic: false, systemAudio: false });
    
    expect(actor.getSnapshot().value).toBe('starting');
  });
  
  it('should reject STOP when not recording', () => {
    // ...
  });
  
  it('should transition to failed on OFFSCREEN_ERROR', () => {
    // ...
  });
});
```

**Benefits:**
- Test state logic without Chrome APIs
- Test all transitions deterministically
- Mock Chrome API at service layer

---

## File Changes Summary

| File | Action | Purpose |
|------|--------|---------|
| `background.js` | Deprecate | Old imperative implementation |
| `background-xstate.js` | New | Integration layer with Chrome APIs |
| `src/services/recordingService.ts` | New | Service layer wrapping XState machine |
| `src/machines/recordingMachine.ts` | New | XState v5 state machine definition |
| `src/machines/types.ts` | New | TypeScript types and constants |

---

## Quick Reference: Event Mapping

| Old Handler | New Event |
|-------------|------------|
| `handleOffscreenStarted()` | `OFFSCREEN_STARTED` |
| `handleRecorderStarted()` | `RECORDER_STARTED` |
| `handleOffscreenData()` | `OFFSCREEN_DATA` |
| `handleRecorderData()` | `RECORDER_DATA` |
| `handleOffscreenError()` | `OFFSCREEN_ERROR` |
| `handleRecorderError()` | `RECORDER_ERROR` |
| Confirmation timeout fires | `CONFIRMATION_TIMEOUT` |
| Save timeout fires | `SAVE_TIMEOUT` |
| - | `RECOVERY_DISCARD` |

---

## Common Patterns

### Getting Current State

```typescript
// Old
const status = STATE.status;

// New
const snapshot = manager.getSnapshot();
const status = snapshot.value; // 'idle' | 'starting' | 'recording' | etc.
```

### Sending Machine Events

```typescript
// Old
STATE.status = STATE_RECORDING;
await persistSessionSnapshot();

// New
manager.send({ type: 'START', mode: 'tab', mic: false, systemAudio: false });
```

### Checking if Recording

```typescript
// Old
const isRecording = STATE.status === STATE_RECORDING;

// New
const isRecording = manager.isRecording();
```

### Accessing Context

```typescript
// Old
const { recordingId, options } = STATE;

// New
const context = manager.getSnapshot().context;
const { recordingId, options } = context;
```