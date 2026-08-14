# Privacy Policy for ScreenSilo

Effective date: August 14, 2026

ScreenSilo is a browser extension for recording a user-selected browser tab,
window, or screen. ScreenSilo is designed to perform its work locally in your
browser without an account or upload service.

## Information ScreenSilo processes

ScreenSilo processes the following information only to provide its recording
features:

- The visual content of the tab, window, or screen you explicitly select in the
  browser's screen-sharing prompt.
- Microphone audio and system or tab audio when you explicitly enable those
  options and grant the browser permission.
- Recording metadata such as an internal recording identifier, creation time,
  duration, file type, file size, and completion status.
- Minimal session-recovery state, including recording mode, audio choices,
  timestamps, and internal identifiers.
- Local diagnostic entries such as error messages, stack traces, internal
  identifiers, and recording state. Diagnostics do not contain the recorded
  video or audio.

## Local storage and retention

Recordings and recording metadata are stored in browser-managed IndexedDB on
your device. Completed recordings remain there until you delete them from the
preview or recordings page. Downloading a recording does not automatically
delete the browser copy.

Session-recovery state is stored in `chrome.storage.local` so ScreenSilo can
recover from a suspended service worker or interrupted recording. It is removed
or replaced as the recording lifecycle completes.

ScreenSilo keeps a local rolling buffer of up to 500 diagnostic entries. You can
view, export, or clear these entries from the Diagnostics page. Export happens
only when you choose it and creates a file on your device.

## Data collection, transmission, and sharing

ScreenSilo does not transmit recordings, audio, metadata, diagnostics, browsing
history, or personal information to ScreenSilo's developer or to external
servers. ScreenSilo has no analytics, advertising, account, or cloud-upload
service and does not sell or share user information with third parties.

No data leaves your device unless you choose to download, export, or share a
file using software outside ScreenSilo.

## Permissions

ScreenSilo uses these browser permissions:

- `activeTab`: grants temporary access to the active tab so ScreenSilo can show
  recording controls after a user action.
- `scripting`: injects and removes the small in-page Stop overlay.
- `offscreen`: keeps local capture and encoding active outside the popup.
- `storage`: stores minimal recording-session recovery state locally.
- `alarms`: schedules local checkpoints and service-worker reconciliation.

ScreenSilo does not request broad host access such as `<all_urls>`.

## User controls

You control when capture starts, which surface is shared, whether audio is
included, and when capture stops. You can delete recordings individually and
clear local diagnostics from the extension. Removing ScreenSilo through your
browser also removes extension-managed local data according to the browser's
uninstallation behavior.

## Chrome Web Store Limited Use

ScreenSilo's use of information received from Chrome APIs adheres to the Chrome
Web Store User Data Policy, including the Limited Use requirements.

## Changes to this policy

This policy will be updated if ScreenSilo's features or data practices change.
The effective date above identifies the latest revision.

## Contact

For privacy questions, contact [hello@subagentura.tech](mailto:hello@subagentura.tech).
