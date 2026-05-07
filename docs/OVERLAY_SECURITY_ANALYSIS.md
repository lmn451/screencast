# Overlay Injection Security Analysis - CaptureCast

## Executive Summary

This document analyzes the security considerations of the overlay injection system in CaptureCast, a Chrome extension for screen recording. The overlay provides a "Stop" button injected into the user's active tab during recording.

---

## 1. Chrome Content Script Injection Limitations

### 1.1 `chrome.scripting.executeScript` Requirements

**From manifest.json (line 30):**

```json
"permissions": ["activeTab", "scripting", "offscreen"]
```

The extension uses:

- **`activeTab`**: Grants temporary host permissions to the active tab in response to user gesture
- **`scripting`**: Required for `chrome.scripting.executeScript` API

**API behavior (from background.js lines 186-197):**

```javascript
async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
    });
    return true;
  } catch (e) {
    logger.log('Overlay injection failed (may be restricted page):', e.message);
    return false;
  }
}
```

### 1.2 Restricted Pages - Cannot Inject

Based on Chrome's security model, `scripting.executeScript` **cannot inject** into:

| Scheme                | Example                       | Reason                          |
| --------------------- | ----------------------------- | ------------------------------- |
| `chrome://`           | `chrome://settings`           | Chrome internal pages           |
| `about:`              | `about:blank`, `about:memory` | About pages                     |
| `devtools://`         | `devtools://devtools`         | Developer tools                 |
| `file://`             | `file:///path/to/page.html`   | Local files                     |
| `chrome-extension://` | Extension's own pages         | Self (uses different mechanism) |
| PDF viewer            | Built-in PDF viewer           | Sandboxed viewer                |

### 1.3 PDF Viewer Behavior

When viewing a PDF in Chrome's built-in viewer, injection attempts silently fail. The code handles this gracefully:

```javascript
// background.js lines 308-312
let overlayInjected = false;
if (STATE.overlayTabId) {
  overlayInjected = await injectOverlay(STATE.overlayTabId);
}
// Returns { ok: true, overlayInjected } - overlay injection failure is non-fatal
```

**Risk**: On restricted pages (PDF viewer, `chrome://`, `about:`), users lose the in-page Stop button. They must rely on:

- Extension popup Stop button
- Badge click handler
- Closing the tab

---

## 2. Overlay Injection Failure Handling

### 2.1 STOP Entry Points

The `STOP` command has multiple entry points:

| Entry Point           | File                | Handler                                              |
| --------------------- | ------------------- | ---------------------------------------------------- |
| **Popup button**      | `popup.js:28-34`    | `stop()` → `GET_STATE` then UI update                |
| **Overlay button**    | `overlay.js:67-91`  | `STOP` message → error handling with visual feedback |
| **Badge click**       | Not visible in code | Falls through to popup                               |
| **Keyboard shortcut** | Chrome default      | Opens popup                                          |

### 2.2 STOP State Machine

**From background.js `stopRecording()` (lines 339-390):**

```
RECORDING → STOPPING (persist snapshot)
         → Attempt overlay removal (best-effort)
         → Send RECORDER_STOP or OFFSCREEN_STOP
         → Safety timeout (STOP_TIMEOUT_MS)
         → If timeout: resetRecordingState()
```

**State validation (lines 340-345):**

```javascript
const transition = validateStateTransition(STATE.status, STATE_STOPPING);
if (!transition.valid) {
  logger.warn('Invalid state transition:', transition.error);
  return { ok: false, error: transition.error };
}
if (STATE.status !== STATE_RECORDING) return { ok: false, error: 'Not recording' };
```

### 2.3 Overlay Removal Failure Handling

**From background.js `removeOverlay()` (lines 199-211):**

```javascript
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
    MK: logger.warn('Overlay removal failed (non-critical):', e);
  }
}
```

**Critical observation**: Removal failures are **non-critical** - the code continues execution. Overlay elements may persist until:

1. Page navigation
2. Tab close
3. Manual removal

---

## 3. Security Considerations

### 3.1 XSS Prevention in Overlay

**✅ GOOD**: Overlay uses `textContent` for user-facing text

From overlay.js:

```javascript
btn.textContent = 'Stop'; // Line 20 - safe
btn.textContent = 'Saving…'; // Line 39 - safe
btn.textContent = 'Starting…'; // Line 44 - safe
btn.textContent = 'Error!'; // Lines 78, 86 - safe
```

**✅ GOOD**: No dynamic HTML insertion

```javascript
// No innerHTML usage
// No document.write()
// No eval() or Function() constructor
```

**✅ GOOD**: Unique ID prevents duplicates

```javascript
if (document.getElementById('cc-overlay')) return; // Line 8
```

### 3.2 Clickjacking Protection

**✅ GOOD**: Fixed positioning with highest z-index

```javascript
Object.assign(root.style, {
  position: 'fixed',
  top: '12px',
  right: '12px',
  zIndex: 2147483647, // Maximum 32-bit signed integer
});
```

**⚠️ CONSIDERATION**: Overlay is always on top, could block:

- Chat widgets (floating icons in corners)
- Notification toasts
- Modal dialogs expecting topmost position

**Mitigation in place**: Small footprint (20px border-radius button), only visible during active recording.

### 3.3 Input Sanitization

**✅ GOOD**: Message schema validation

From background.js lines 481-494:

```javascript
const schema = schemas[message?.type];
if (schema) {
  const { valid, errors } = validateMessageStrict(message, schema);
  if (!valid) {
    logger.warn('Message validation failed:', errors, message.type);
    sendResponse({ ok: false, error: `Validation failed: ${errors.join(', ')}` });
    return;
  }
} else {
  logger.warn('Unknown message type rejected:', message.type);
  sendResponse({ ok: false, error: 'Unknown message type' });
  return;
}
```

**✅ GOOD**: UUID validation for recording IDs

```javascript
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}
```

Used in:

- `OFFSCREEN_DATA` handler (background.js line 535)
- `RECORDER_DATA` handler (background.js line 563)

### 3.4 Communication with Background (Message Passing)

**✅ GOOD**: Sender validation

From background.js lines 474-478:

```javascript
if (sender.id !== chrome.runtime.id) {
  logger.warn('Ignoring message from unauthorized sender:', sender.id);
  sendResponse({ ok: false, error: 'Unauthorized sender' });
  return;
}
```

Only messages from the extension's own context are processed.

**✅ GOOD**: Rate limiting

From background.js lines 434-460:

```javascript
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 50;

function checkRateLimit(senderId) {
  // Sliding window rate limiter
  // Returns false if exceeded
}
```

**✅ GOOD**: Strict message schemas

All message types have defined schemas (messages.js lines 21-107) with:

- Required fields with types
- Optional fields with types
- No catch-all unknown fields

---

## 4. Privacy Considerations

### 4.1 Data Access by Overlay

**Minimal data access** - overlay only:

1. Reads its own DOM element state
2. Queries current recording status via `GET_STATE`

**GET_STATE response (background.js lines 621-634):**

```javascript
const publicState = {
  status: STATE.status,
  recordingId: STATE.recordingId,
  correlationId: STATE.correlationId,
  startedAt: STATE.startedAt,
  lastActivityAt: STATE.lastActivityAt,
  options: { ...STATE.options },
  strategy: STATE.strategy,
  recording: STATE.status === STATE_RECORDING || STATE.status === STATE_SAVING,
};
```

**⚠️ POTENTIAL LEAK**: `correlationId` is exposed (UUIDv4, not sensitive but unnecessary)

### 4.2 Data Leakage to Page

**✅ SECURE**: Overlay cannot leak data to page

1. **Isolated execution context**: Content scripts run in isolated world
2. **No shared variables**: Page JavaScript cannot access extension variables
3. **No page communication**: Overlay only sends messages to background, not to page

**Shadow DOM Usage**: ❌ **NOT USED** - Could improve isolation

```javascript
// Current approach (less isolated):
const root = document.createElement('div');
document.documentElement.appendChild(root);

// More isolated alternative (not implemented):
const shadow = root.attachShadow({ mode: 'closed' });
```

### 4.3 iframe Restrictions

**✅ GOOD**: Overlay injects into main frame only

```javascript
// Default behavior of executeScript
// Does not inject into iframes unless allFrames: true is specified
```

**Benefit**: Page iframes (ads, embeds) are not affected by the overlay.

### 4.4 Extension Page Access

**✅ SECURE**: `web_accessible_resources` is empty

From manifest.json lines 44-45:

```json
"web_accessible_resources": []
```

The overlay.js file is **NOT** web-accessible - it can only be injected, not directly loaded by page scripts.

---

## 5. Security Checklist

| Item                               | Status      | Location                  |
| ---------------------------------- | ----------- | ------------------------- |
| XSS Prevention (textContent)       | ✅ PASS     | overlay.js:20,39,44,78,86 |
| No eval/dynamic code               | ✅ PASS     | overlay.js:1-114          |
| Unique element ID                  | ✅ PASS     | overlay.js:8,10           |
| Sender validation                  | ✅ PASS     | background.js:474-478     |
| Message schema validation          | ✅ PASS     | background.js:481-494     |
| UUID validation                    | ✅ PASS     | background.js:467-469     |
| Rate limiting                      | ✅ PASS     | background.js:434-460     |
| CSP compliance                     | ✅ PASS     | manifest.json:37-38       |
| No web_accessible_resources        | ✅ PASS     | manifest.json:45          |
| Overlay injection failure handling | ✅ PASS     | background.js:186-197     |
| Overlay removal failure handling   | ✅ PASS     | background.js:199-211     |
| State machine validation           | ✅ PASS     | background.js:340-345     |
| Restricted page handling           | ✅ PASS     | background.js:308-312     |
| Shadow DOM isolation               | ⚠️ NOT USED | -                         |

---

## 6. Recommendations

### 6.1 High Priority

1. **Remove `correlationId` from GET_STATE response** - not needed by overlay:
   ```javascript
   // Remove from background.js line 626
   correlationId: STATE.correlationId,  // Remove this
   ```

### 6.2 Medium Priority

2. **Consider Shadow DOM for overlay** - Better isolation from page CSS:

   ```javascript
   const shadow = document.createElement('div');
   shadow.attachShadow({ mode: 'closed' });
   shadow.shadowRoot.appendChild(btn);
   ```

3. **Add injection target URL validation** - Address TOCTOU concern:
   ```javascript
   async function injectOverlay(tabId, expectedUrl) {
     try {
       const tab = await chrome.tabs.get(tabId);
       if (!tab.url.startsWith('http')) {
         return false;  // Reject restricted pages explicitly
       }
       // ... proceed with injection
     }
   }
   ```

### 6.3 Low Priority

4. **Document fallback behavior** - Users on restricted pages should know alternative stop methods.

5. **Consider overlay position randomization** - To avoid blocking fixed-position page elements.

---

## 7. Threat Model Summary

| Threat                    | Likelihood   | Impact | Mitigation                       |
| ------------------------- | ------------ | ------ | -------------------------------- |
| XSS via overlay           | **LOW**      | HIGH   | textContent-only, no eval        |
| Clickjacking overlay      | **LOW**      | LOW    | Overlay is intended UI           |
| Message injection         | **LOW**      | HIGH   | Schema validation + sender check |
| Rate limit exhaustion     | **LOW**      | MEDIUM | 50 req/sec limit                 |
| Page → Overlay data leak  | **VERY LOW** | MEDIUM | Isolated world                   |
| Restricted page injection | **N/A**      | LOW    | Graceful failure                 |

---

## 8. Conclusion

The overlay injection system demonstrates good security practices:

- ✅ Minimal attack surface (simple UI, no dynamic content)
- ✅ Strict message validation (Phase 6 implementation)
- ✅ Proper sender validation
- ✅ Rate limiting in place
- ✅ Graceful failure handling
- ✅ CSP compliant

**Overall Risk Assessment: LOW**

The main considerations are:

1. Adding Shadow DOM for enhanced isolation (optional enhancement)
2. Removing unnecessary `correlationId` from state exposure
3. Documenting behavior on restricted pages for user awareness

The implementation correctly handles injection failures and provides multiple redundant stop mechanisms for users.
