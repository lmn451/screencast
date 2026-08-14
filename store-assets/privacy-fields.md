# Store privacy fields

Ready-to-paste answers for the Chrome Web Store and Microsoft Edge Add-ons.
Reconfirm these against the final package before every submission.

## Single purpose

ScreenSilo records a user-selected browser tab, window, or screen and saves the
recording locally on the user's device for preview, download, and deletion.

## Permission justifications

### activeTab

ScreenSilo uses the temporary access granted after the user clicks the extension
to inject recording controls into the active tab. It does not request persistent
access to browsing history or all websites.

### scripting

ScreenSilo uses `chrome.scripting` to inject and remove a small Stop overlay in
the active tab during a recording. The overlay is the only script placed in the
page and is initiated by the user's recording action.

### offscreen

ScreenSilo uses an offscreen extension document to keep `getDisplayMedia()` and
`MediaRecorder` running locally after the popup closes. This is necessary for a
recording to continue without keeping the popup open.

### storage

ScreenSilo stores a minimal local snapshot of the active recording session so it
can recover state after a Manifest V3 service worker suspension or browser
interruption. Video and audio recordings are stored separately in local
IndexedDB and are never synced or uploaded by the extension.

### alarms

ScreenSilo uses local browser alarms for periodic recording checkpoints and to
reconcile recovery state when the Manifest V3 service worker is suspended and
restarted.

## Remote code

No. ScreenSilo does not download or execute remotely hosted code. All executable
code is included in the extension package and covered by the extension content
security policy.

## Data use

ScreenSilo does not transmit or collect user data on developer or third-party
servers. User-selected visual content, optional audio, recording metadata,
recovery state, and diagnostics are processed and stored locally on the user's
device solely to provide the extension's recording and recovery features.

## Limited Use certification

ScreenSilo's use of information received from Chrome APIs is limited to providing
or improving its single-purpose, user-facing screen-recording functionality. It
does not use or transfer user data for advertising, creditworthiness, lending,
or unrelated purposes, and it does not permit humans to read user data.

## Public links

- Homepage: https://subagentura.tech/screencast/
- Privacy policy: https://subagentura.tech/screencast/privacy/
- Support email: hello@subagentura.tech
