# Troubleshooting CaptureCast

This guide helps you resolve common issues with CaptureCast.

## Recording Issues

### Recording Won't Start

**Symptom**: Clicking "Record" shows error or nothing happens.

**Possible Causes & Solutions**:

1. **On a restricted page**

   - Pages like `chrome://`, `about:`, `edge://`, and other extension pages cannot be recorded
   - **Solution**: Navigate to a regular webpage first, then start recording

2. **Browser permissions denied**

   - You may have denied screen sharing permission
   - **Solution**:
     - Click the camera icon in the address bar
     - Reset permissions for the extension
     - Try recording again

3. **Extension not loaded properly**

   - Extension may have crashed or failed to load
   - **Solution**:
     - Go to `chrome://extensions/`
     - Find CaptureCast
     - Click the reload icon
     - Try again

4. **Microphone permission issues** (when mic enabled)
   - Microphone access denied or not available
   - **Solution**:
     - Check browser microphone permissions
     - Ensure microphone is connected
     - Try without microphone first

### Recording Starts But Immediately Stops

**Symptom**: Recording begins but ends within seconds.

**Possible Causes & Solutions**:

1. **User cancelled screen sharing dialog**

   - You clicked "Cancel" on the browser's picker
   - **Solution**: Click "Share" and select a source

2. **Selected source was closed**

   - The tab/window you selected was closed immediately
   - **Solution**: Keep the selected source open

3. **Browser codec support issue**
   - Your browser may not support video encoding
   - **Solution**:
     - Update your browser to the latest version
     - Check console (F12) for codec errors

### Can't Stop Recording

**Symptom**: Recording continues even after clicking Stop.

**Possible Causes & Solutions**:

1. **Overlay not visible**

   - You may be on a different tab or window
   - **Solution**:
     - Click the extension icon (top-right)
     - Click "Stop Recording" in popup

2. **Extension hung**
   - Rare issue with state synchronization
   - **Solution**:
     - Wait 10 seconds (auto-reset timeout)
     - Or reload extension: `chrome://extensions/` → reload icon

### Overlay Not Showing

**Symptom**: No Stop button appears on the page during recording.

**This is normal on**:

- `chrome://` pages
- `about:` pages
- PDF files
- Other extension pages
- Some protected pages

**Solution**: Use the extension icon to stop recording instead.

## Preview & Playback Issues

### Video Won't Play in Preview

**Symptom**: Preview page opens but video doesn't play or shows blank.

**Possible Causes & Solutions**:

1. **Duration normalization in progress**

   - WebM files need metadata correction (takes 1-2 seconds)
   - **Solution**: Wait a moment, video will appear

2. **Recording failed to save**

   - Error during recording or saving to IndexedDB
   - **Solution**:
     - Check browser console (F12) for errors
     - Try recording again
     - Ensure sufficient disk space

3. **Browser codec not supported for playback**

   - Rare codec compatibility issue
   - **Solution**:
     - Download the video
     - Play in VLC or another media player

4. **Recording too short**
   - Recording was stopped too quickly (< 1 second)
   - **Solution**: Record for at least 2-3 seconds

### Video Duration Shows as Infinity or 0:00

**Symptom**: Duration displays incorrectly in preview.

**Cause**: WebM metadata issue (known browser behavior).

**Solution**: This is normal and should auto-correct within 2 seconds. The `fixDurationAndReset()` function handles this. If it doesn't correct:

- Reload the preview page
- Download and check duration in media player
- Re-record if issue persists

### Preview Page Shows "Recording not found"

**Symptom**: Preview page says recording doesn't exist.

**Possible Causes & Solutions**:

1. **Recording URL corrupted**

   - URL may have been modified or truncated
   - **Solution**: Start a new recording

2. **IndexedDB cleared**

   - Browser may have cleared storage
   - **Solution**: Recording is lost, make a new one

3. **Private browsing mode**
   - IndexedDB may not persist in private mode
   - **Solution**: Use regular browsing mode

## Download Issues

### Download Doesn't Start

**Symptom**: Clicking "Download" does nothing.

**Possible Causes & Solutions**:

1. **Browser blocked download**

   - Popup blocker may have interfered
   - **Solution**:
     - Check browser's download bar for blocked download
     - Allow downloads from the extension

2. **Blob URL expired**
   - Page was open too long (rare)
   - **Solution**: Reload preview page

### Downloaded File Won't Open

**Symptom**: Downloaded .webm file won't play.

**Possible Causes & Solutions**:

1. **Media player doesn't support WebM**

   - Windows Media Player doesn't support WebM by default
   - **Solution**:
     - Use VLC Media Player (free, supports WebM)
     - Use Chrome/Firefox browser to play
     - Convert to MP4 with online tool

2. **File corrupted during recording**

   - Issue during recording process
   - **Solution**: Try recording again

3. **Incomplete download**
   - Download was interrupted
   - **Solution**: Download again from preview page

## Performance Issues

### Recording is Laggy

**Symptom**: Recorded video is choppy or has low framerate.

**Possible Causes & Solutions**:

1. **System resource constraints**

   - CPU/RAM overloaded
   - **Solution**:
     - Close unnecessary tabs and programs
     - Record smaller window instead of entire screen
     - Disable system audio if not needed

2. **Recording high-resolution screen**

   - 4K screens require more resources
   - **Solution**:
     - Record single tab instead of screen
     - Lower screen resolution temporarily

3. **Other extensions interfering**
   - Other extensions consuming resources
   - **Solution**:
     - Disable other extensions temporarily
     - Test in incognito with only CaptureCast enabled

### Browser Becomes Slow During Recording

**Symptom**: Browser feels sluggish while recording.

**Cause**: Normal - encoding video in real-time uses CPU.

**Solutions**:

- Record for shorter durations
- Close unnecessary tabs
- Use tab recording instead of screen
- Pause other resource-intensive tasks

## Extension Issues

### Extension Icon Missing

**Symptom**: Can't find CaptureCast icon in browser.

**Solutions**:

1. Click the puzzle piece icon (Extensions menu)
2. Find CaptureCast and click the pin icon
3. Icon will appear in toolbar

### Extension Not Loading

**Symptom**: Extension doesn't appear in `chrome://extensions/`.

**Solutions**:

1. Verify you selected the correct folder (containing `manifest.json`)
2. Check for errors in the extension card
3. Try removing and re-loading the extension
4. Ensure Developer Mode is enabled

### "Manifest is not valid JSON" Error

**Symptom**: Error when loading extension.

**Cause**: `manifest.json` file is corrupted.

**Solution**:

1. Re-download the extension
2. Don't edit `manifest.json` manually
3. Ensure file encoding is UTF-8

## Data & Storage Issues

### "Failed to save recording" Error

**Symptom**: Recording completes but shows save error.

**Possible Causes & Solutions**:

1. **Insufficient storage**

   - Browser storage quota exceeded
   - **Solution**:
     - Delete old recordings from preview page
     - Clear browser cache
     - Free up disk space

2. **IndexedDB disabled**
   - Browser settings may block IndexedDB
   - **Solution**:
     - Check browser settings → Privacy
     - Enable cookies and site data
     - Not compatible with some privacy modes

### Can't Delete Recording

**Symptom**: Clicking "Delete Recording" fails.

**Solution**:

1. Reload the preview page
2. Try again
3. Clear browser data manually:
   - F12 → Application → IndexedDB → CaptureCastDB → Delete

## Debugging

### Viewing Console Logs

For developers and advanced troubleshooting:

1. **Background Service Worker**:

   - Go to `chrome://extensions/`
   - Find CaptureCast
   - Click "service worker" link
   - View console logs

2. **Popup**:

   - Right-click extension icon
   - Click "Inspect popup"
   - View console

3. **Preview/Recorder Pages**:
   - F12 on the page
   - View console

### Common Error Messages

| Error                            | Meaning                                | Solution                          |
| -------------------------------- | -------------------------------------- | --------------------------------- |
| "Already recording"              | Tried to start while recording active  | Stop current recording first      |
| "Not recording"                  | Tried to stop when no recording active | State mismatch, reload extension  |
| "Failed to start recording"      | Generic start failure                  | Check console, verify permissions |
| "No supported video codec found" | Browser lacks codec support            | Update browser                    |
| "Unauthorized sender"            | Security validation failed             | Reload extension                  |

### Collecting Debug Information

When reporting issues, include:

1. **Browser Information**:

   - Browser name and version
   - Operating system
   - Extension version

2. **Steps to Reproduce**:

   - Numbered steps
   - What you expected
   - What actually happened

3. **Console Logs**:

   - Relevant error messages
   - Screenshots of console

4. **Settings Used**:
   - Microphone enabled?
   - System audio enabled?
   - Recording mode (tab/window/screen)

## Getting Help

### Before Asking for Help

1. Check this troubleshooting guide
2. Check existing GitHub issues
3. Try reloading the extension
4. Try in incognito mode (to rule out other extensions)
5. Update browser to latest version

### Where to Get Help

- **GitHub Issues**: https://github.com/yourusername/capturecast/issues
- **Discussions**: https://github.com/yourusername/capturecast/discussions

### Reporting Bugs

See CONTRIBUTING.md for bug report template.

## Known Limitations

### Cannot Record

- Chrome Web Store pages
- Chrome settings pages (`chrome://`)
- Other extension pages
- Some DRM-protected content
- Private/Incognito tabs (depending on extension settings)

### Platform Limitations

- **Mac**: System audio capture requires macOS 11+ and specific browser versions
- **Linux**: Audio capture depends on desktop environment
- **Windows**: Generally works well with all features

### Browser Compatibility

- **Chromium-based**: Full support (Chrome, Edge, Brave, Vivaldi, Opera)
- **Firefox**: Not supported (different extension API)
- **Safari**: Not supported (WebExtension differences)

## Still Having Issues?

If you've tried everything and still have problems:

1. Export your recording settings (if implemented)
2. Uninstall the extension completely
3. Restart your browser
4. Reinstall the extension
5. Test with default settings

If issues persist, please open a GitHub issue with detailed information.
