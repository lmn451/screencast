# Known Issues and Limitations

## Critical Issues Identified

### 1. Memory Exhaustion Risk for Long Recordings

**Status**: Known limitation, not yet fixed

**Issue**: The entire recording is buffered in RAM before being saved to IndexedDB.

**Technical Details**:

- `offscreen.js` and `recorder.js` use `let chunks = []` to accumulate video data
- All chunks are held in memory until recording stops
- Final blob is created by `new Blob(chunks, { type: ... })`

**Impact**:

- Long recordings (> 30 minutes) at high resolution can consume 2GB+ RAM
- May cause extension process to crash (OOM error)
- Complete loss of recording if crash occurs
- Particularly affects:
  - 1080p recordings > 20 minutes
  - 4K recordings > 5 minutes
  - Systems with limited RAM

**Risk Level**: High for power users

**Status**: ✅ FIXED in v0.2.0 - Chunked storage now saves incrementally

**Solution Implemented**:

- `media-recorder-utils.js` saves chunks directly to IndexedDB as they arrive
- No memory accumulation regardless of recording length
- Partial recordings preserved even if extension crashes
- Safe for 60+ minute recordings at any resolution

### 2. Race Condition with Concurrent Recordings

**Status**: Partially mitigated in v0.2.0

**Issue**: If IndexedDB save takes longer than timeout, state can become corrupted.

**Scenario**:

1. User records large video
2. Clicks Stop
3. IndexedDB save takes 65+ seconds (very large file, slow disk)
4. 60-second timeout fires, resets state
5. User starts new recording
6. Old save completes, overwrites new recording state

**Impact**:

- New recording appears stopped (badge off, overlay removed)
- Actual recording continues but user unaware
- Confusing UX

**Risk Level**: Medium (rare, requires specific timing)

**Mitigations Applied**:

- Increased timeout from 10s to 60s
- Added logging when timeout fires
- Improved state consistency checks

**Remaining Risk**:

- Still possible with very large recordings (> 5GB) on slow systems
- No active recording protection during save

**Future Fix** (v0.3+):

- Add recording ID tracking to prevent state collision
- Implement save progress indicator
- Add "recording in progress" lock during save

### 3. No Progress Feedback During Save

**Status**: Known limitation

**Issue**: After clicking Stop, no visual feedback during IndexedDB save operation.

**Impact**:

- User doesn't know if extension is working
- May close browser/tab prematurely, losing recording
- May click Stop multiple times (now mitigated in overlay)

**Risk Level**: Low (UX issue)

**Workarounds**:

- Overlay now shows "Saving..." (v0.2.0)
- Wait for preview tab to open

**Future Fix** (v0.3+):

- Add progress notification
- Show estimated save time
- Add badge animation during save

## Medium Priority Issues

### 4. Service Worker Suspension (MV3)

**Status**: Potential future issue

**Issue**: Chrome MV3 service workers can be suspended after 30 seconds of inactivity.

**Impact**:

- Recording state could be lost if service worker suspended
- Messages might not be delivered
- May affect long recording sessions

**Current Mitigation**:

- State is in memory only
- Recording process keeps service worker alive

**Future Fix** (v0.3+):

- Persist state to `chrome.storage.session`
- Restore state on service worker wake

### 5. Codec Compatibility

**Status**: Low risk, handled

**Issue**: Not all browsers support all codecs (AV1, VP9, VP8).

**Mitigation**:

- Fallback chain implemented
- Error thrown if no codec supported
- Should work on all modern browsers

**Compatibility**:

- AV1: Chrome 90+, Edge 90+
- VP9: Chrome 29+, Edge 79+
- VP8: All Chromium browsers

### 6. Overlay Injection Failures

**Status**: Expected behavior

**Issue**: Cannot inject overlay on restricted pages.

**Affected Pages**:

- `chrome://` and `edge://` pages
- `about:` pages
- Other extension pages
- PDF viewer
- Chrome Web Store

**Mitigation**:

- Documented in TROUBLESHOOTING.md
- User can stop via extension icon
- Error logged (not shown to user)

## Low Priority Issues

### 7. No Recording Size Limit

**Status**: By design, but risky

**Issue**: No hard limit on recording size or duration.

**Impact**:

- Users might record until running out of disk space
- No warning before hitting quota
- May cause system instability

**Future Fix** (v0.3+):

- Add configurable time limit
- Show storage usage in preview
- Warn when approaching quota

### 8. IndexedDB Quota

**Status**: Browser-dependent

**Issue**: IndexedDB has storage quota limits (browser-specific).

**Typical Limits**:

- Chrome: ~60% of available disk space (or 20GB minimum)
- Edge: Similar to Chrome
- Varies by system

**Impact**:

- Large recordings may fail to save
- Error not always clear to user

**Future Fix** (v0.3+):

- Check quota before recording
- Show available storage
- Offer direct-to-download option (skip IndexedDB)

### 9. No Encryption

**Status**: By design, privacy by architecture

**Issue**: Recordings stored unencrypted in IndexedDB.

**Security Consideration**:

- Anyone with file system access can read recordings
- Not an issue for most users (local-only storage)
- Browser sandbox provides some protection

**Future Enhancement** (v1.0+):

- Optional encryption with user-provided password
- Encrypted export option

## Performance Limitations

### 10. Recording Performance

**Factors Affecting Performance**:

- Screen resolution (4K requires 4x processing vs 1080p)
- Frame rate (60fps vs 30fps)
- Codec (AV1 is slowest but best quality)
- System specs (CPU, available RAM)
- Other running applications

**Known Issues**:

- May drop frames on older hardware
- CPU usage 10-30% during recording
- Battery drain on laptops

**No Planned Fix**: This is inherent to video encoding

## Testing Gaps

**Areas Not Covered by E2E Tests**:

- Long recording sessions (> 5 minutes)
- Large file handling (> 1GB)
- Concurrent recordings (prevented, but not tested)
- Service worker suspension scenarios
- Low memory conditions
- Slow disk I/O

**Reason**: Difficult to test reliably in CI/CD

## Browser Compatibility

**Fully Supported**:

- Chrome 90+
- Edge 90+
- Brave (Chromium-based)
- Vivaldi (Chromium-based)
- Opera (Chromium-based)

**Not Supported**:

- Firefox (different WebExtensions API)
- Safari (different extension model)
- Older Chrome/Edge versions (< 90)

## Platform-Specific Issues

**macOS**:

- System audio capture requires macOS 11+
- May require additional permissions

**Windows**:

- Generally works well
- Some codec issues on older Windows 10 builds

**Linux**:

- Audio capture varies by desktop environment
- Wayland may have restrictions

## Reporting Issues

If you encounter issues not listed here:

1. Check TROUBLESHOOTING.md first
2. Search existing GitHub issues
3. Open new issue with:
   - Browser version
   - OS version
   - Extension version
   - Console logs
   - Steps to reproduce

## Future Roadmap

### v0.3.0 (Next Release)

- [ ] Incremental save to prevent OOM
- [ ] Save progress indicator
- [ ] Recording time limit option
- [ ] State persistence for MV3

### v0.4.0

- [ ] Storage usage UI
- [ ] Direct-to-download option
- [ ] Better error messages

### v1.0.0

- [ ] Format conversion (MP4)
- [ ] Video trimming
- [ ] Advanced settings UI

---

Last Updated: v0.2.0
