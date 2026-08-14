# Permissions and justifications

ScreenSilo requests only the permissions strictly required for screen
recording. See [`manifest.json`](../manifest.json) for the source of truth.

## Required (granted at install time)

| Permission  | Why                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `activeTab` | Grants temporary access after a user action so the extension can place controls in the active tab. |
| `scripting` | Lets the background service worker inject and remove the in-page Stop overlay.                     |
| `offscreen` | Keeps local capture and MediaRecorder encoding alive outside the short-lived popup.                |
| `storage`   | Persists minimal session-recovery state in `chrome.storage.local`.                                 |
| `alarms`    | Schedules local recording checkpoints and MV3 service-worker reconciliation.                       |

## Removed / avoided

- `host_permissions: <all_urls>` — removed in v0.2.0. The overlay is injected only via the active-tab `scripting` permission.
- `tabs` — the extension uses the `chrome.tabs` API but does not request broad access to tab URLs or titles.
- `tabCapture` and `desktopCapture` — capture is initiated through the browser's user-controlled `getDisplayMedia()` picker.
- `notifications` — removed because the current release does not use browser notifications.
- `web_accessible_resources` — empty. `overlay.js` is injected via `chrome.scripting.executeScript` and does **not** need to be web-accessible; exposing it would be a needless attack surface.

## Limitations

- Overlay injection fails on restricted URLs (`chrome://`, `chrome-extension://`, the Chrome Web Store, `view-source:`, etc.). In those cases the user can still stop the recording via the extension popup or the toolbar badge.
