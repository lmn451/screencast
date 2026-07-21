# Permissions and justifications

CaptureCast requests only the permissions strictly required for screen
recording. See [`manifest.json`](../manifest.json) for the source of truth.

## Required (granted at install time)

| Permission  | Why                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `activeTab` | Access the user's active tab while recording and support the Stop overlay.                       |
| `scripting` | Required by `chrome.scripting.executeScript` to inject the Stop overlay.                         |
| `offscreen` | Runs `getDisplayMedia` and `MediaRecorder` in a background offscreen document.                   |
| `storage`   | Persists local session snapshots and recovery metadata in `chrome.storage.local`.                 |
| `alarms`    | Schedules reconciliation and recording checkpoint work across service-worker suspension.          |

CaptureCast does not request optional permissions. It does not use `chrome.notifications`,
`chrome.tabCapture`, host permissions, or `<all_urls>`.

## Removed / avoided

- `host_permissions: <all_urls>` — removed in v0.2.0. The overlay is injected only via the active-tab `scripting` permission.
- `web_accessible_resources` — empty. `overlay.js` is injected via `chrome.scripting.executeScript` and does **not** need to be web-accessible; exposing it would be a needless attack surface.

## Limitations

- Overlay injection fails on restricted URLs (`chrome://`, `chrome-extension://`, the Chrome Web Store, `view-source:`, etc.). In those cases the user can still stop the recording via the extension popup or the toolbar badge.
