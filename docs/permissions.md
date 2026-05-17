# Permissions and justifications

CaptureCast requests only the permissions strictly required for screen
recording. See [`manifest.json`](../manifest.json) for the source of truth.

## Required (granted at install time)

| Permission   | Why                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `activeTab`  | Inject the overlay (Stop button) into the user's active tab during recording.                    |
| `scripting`  | Required by `chrome.scripting.executeScript` so the background can attach `overlay.js`.          |
| `offscreen`  | The offscreen document API lets us run `getDisplayMedia` + `MediaRecorder` without a visible tab. |
| `tabCapture` | Required by `chrome.tabCapture` for the silent single-tab capture strategy.                      |

## Optional (requested only when needed)

| Permission      | Why                                                                |
| --------------- | ------------------------------------------------------------------ |
| `notifications` | Surface non-blocking user alerts (e.g. recording saved, failures). |

## Removed / avoided

- `host_permissions: <all_urls>` — removed in v0.2.0. The overlay is injected only via the active-tab `scripting` permission.
- `web_accessible_resources` — empty. `overlay.js` is injected via `chrome.scripting.executeScript` and does **not** need to be web-accessible; exposing it would be a needless attack surface.

## Limitations

- Overlay injection fails on restricted URLs (`chrome://`, `chrome-extension://`, the Chrome Web Store, `view-source:`, etc.). In those cases the user can still stop the recording via the extension popup or the toolbar badge.
