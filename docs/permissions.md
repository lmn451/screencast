# Permissions and justifications

- activeTab: To let the user start recording from the current active tab context and interact with it via overlay injection when recording starts.
- scripting: To inject a small overlay (Stop button) into the active tab during recording.
- offscreen: Required for using the offscreen document to run getDisplayMedia + MediaRecorder without a visible tab.
- tabs: To query the active tab and open the preview page when recording is done.

Removed or avoided:
- tabCapture: Not needed because recording uses navigator.mediaDevices.getDisplayMedia in the offscreen document.
- host_permissions <all_urls>: Not necessary with current architecture; we only inject overlay into the active tab through scripting permission.

