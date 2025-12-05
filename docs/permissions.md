# Permissions and justifications

- activeTab: To let the user start recording from the current active tab context and interact with it via overlay injection when recording starts.
- scripting: To inject a small overlay (Stop button) into the active tab during recording.
- offscreen: Required for using the offscreen document to run getDisplayMedia + MediaRecorder without a visible tab.
- tabs: To query the active tab and open the preview page when recording is done.
- storage: To persist recording metadata and configuration settings.

Removed or avoided:
- tabCapture: Not needed because recording uses navigator.mediaDevices.getDisplayMedia in the offscreen document.
- host_permissions <all_urls>: Removed in v0.2.0 - not necessary with current architecture; we only inject overlay into the active tab through scripting permission.

Note: Overlay injection may fail on restricted pages (chrome://, about:, extension pages). In these cases, you can still stop recording via the extension icon.

