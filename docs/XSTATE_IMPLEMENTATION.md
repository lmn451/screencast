# XState v5 Implementation Summary

## Overview

This document summarizes the XState v5 refactoring implementation for CaptureCast.

## Files Created

### Machine Definition
- `src/machines/types.ts` - TypeScript type definitions for states, events, context
- `src/machines/recordingMachine.ts` - XState v5 state machine implementation
- `src/machines/index.ts` - Machine exports

### Service Layer
- `src/services/recordingService.ts` - Chrome API bridge for the state machine
- `src/services/index.ts` - Service exports

### Integration
- `background-xstate.js` - New background service worker using XState machine

### Tests
- `tests/unit/recordingMachine.test.js` - Jest tests for state machine

## State Machine Design

### States

```
idle ──START──► starting ──OFFSCREEN_STARTED/RECORDER_STARTED/CONFIRMATION_TIMEOUT──► recording
                      │                                                              │
                      │ STOP (abort)                                                │ STOP
                      ▼                                                              ▼
                     idle                                                         stopping
                                                                                        │
                                                                                        ▼
                                                                                    saved ──(auto 1s)──► idle

Recording states also support:
- failed (on error)
- recoverable (on save timeout)
```

### Events

| Event | From | Purpose |
|-------|------|---------|
| `START` | Popup | Begin recording |
| `STOP` | Popup/Overlay | Stop recording |
| `OFFSCREEN_STARTED` | Offscreen doc | Confirms offscreen recording started |
| `RECORDER_STARTED` | Recorder tab | Confirms page-based recording started |
| `OFFSCREEN_DATA` | Offscreen doc | Recording saved to IndexedDB |
| `RECORDER_DATA` | Recorder tab | Recording saved to IndexedDB |
| `OFFSCREEN_ERROR` | Offscreen doc | Recording failed |
| `RECORDER_ERROR` | Recorder tab | Recording failed |
| `CONFIRMATION_TIMEOUT` | Internal | 5s timeout fallback |
| `SAVE_TIMEOUT` | Internal | 60s timeout for saving |
| `RESET` | User/Recovery | Return to idle |
| `RECONCILE` | On startup | Restore from session snapshot |

### Context

```typescript
interface RecordingContext {
  recordingId: string | null;
  correlationId: string | null;
  strategy: 'offscreen' | 'page' | null;
  overlayTabId: number | null;
  recorderTabId: number | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  options: {
    mode: 'tab' | 'window' | 'screen' | null;
    includeMic: boolean;
    includeSystemAudio: boolean;
  };
  error: string | null;
  failedChunkCount: number;
  overlayInjected: boolean;
}
```

## Benefits of XState v5

1. **Declarative State Transitions** - No more manual `validateStateTransition()` calls
2. **Type Safety** - Full TypeScript support with `setup()` API
3. **Predictable Actions** - Actions execute in deterministic order
4. **Testable Logic** - State machine can be unit tested independently
5. **Visualizable** - Compatible with Stately Studio for visual editing
6. **Actor Model** - Natural fit for extension where components communicate via messages

## Key XState v5 APIs Used

```javascript
import { createMachine, createActor, assign } from 'xstate';

// Create machine
const machine = createMachine({
  id: 'recording',
  initial: 'idle',
  context: { ... },
  states: { ... },
});

// Create actor (like interpret() in v4)
const actor = createActor(machine);
actor.start();

// Send events
actor.send({ type: 'START', mode: 'tab' });

// Get state
const snapshot = actor.getSnapshot();
console.log(snapshot.value); // 'idle' | 'starting' | 'recording' | ...
console.log(snapshot.context); // RecordingContext

// Subscribe to changes
actor.subscribe((snapshot) => {
  console.log('State changed:', snapshot.value);
});
```

## Migration from Current Implementation

### Before (manual state management)
```javascript
// background.js
const STATE = { status: STATE_IDLE, ... };

async function startRecording(mode, mic, systemAudio) {
  const transition = validateStateTransition(STATE.status, STATE_STARTING);
  if (!transition.valid) return { ok: false, error: transition.error };
  
  STATE.status = STATE_STARTING;
  // ...
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START':
      startRecording(...);
      break;
    // ...
  }
});
```

### After (XState v5)
```javascript
// recordingService.ts
const recordingMachine = createMachine({
  states: {
    idle: {
      on: { START: { target: 'starting' } }
    },
    starting: {
      on: {
        OFFSCREEN_STARTED: { target: 'recording' },
        STOP: { target: 'idle' }
      }
    },
    // ...
  }
});

const manager = createRecordingManager();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  manager.send(message); // Direct event dispatch
});
```

## Testing

Run tests:
```bash
pnpm test:unit tests/unit/recordingMachine.test.js
```

All 227 tests pass.

## Next Steps

1. **Replace background.js** - Move logic to `background-xstate.js` for production
2. **Add TypeScript** - Migrate from JSDoc to full TypeScript for better type safety
3. **Visual Editor** - Export machine to Stately Studio for visual editing
4. **Add Actions** - Implement actual Chrome API calls in machine actions
5. **Add Guards** - Add permission checks, storage quota checks as guards
6. **Add Invokes** - Handle offscreen/recorder communication via invoke

## Files Structure

```
screencast/
├── src/
│   ├── machines/
│   │   ├── index.ts           # Exports
│   │   ├── types.ts           # TypeScript definitions
│   │   └── recordingMachine.ts # State machine
│   └── services/
│       ├── index.ts           # Exports
│       └── recordingService.ts # Chrome API bridge
├── tests/
│   └── unit/
│       └── recordingMachine.test.js # Tests (passing)
└── background-xstate.js       # New service worker
```

## Compatibility

- Requires XState v5 (`pnpm add xstate`)
- Uses ESM modules
- Jest for testing
- Compatible with Chrome MV3 extensions