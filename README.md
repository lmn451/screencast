# CaptureCast Browser Extension

A simple, privacy-focused browser extension for screen recording directly in your web browser.

## Features

- **Screen Recording**: Record your entire screen, a specific application window, or just the current browser tab
- **Simple Controls**: One-click start/stop with visual indicators
- **Privacy-Focused**: All recording happens locally - no data is sent to external servers
- **Easy Download**: Preview and download recordings as .webm files

## Installation

### For Development/Testing

1. Clone or download this repository
2. Open your browser and navigate to the extensions page:
   - **Chrome**: `chrome://extensions/`
   - **Firefox**: `about:addons`
   - **Edge**: `edge://extensions/`

3. Enable "Developer mode" (Chrome/Edge) or "Debug add-ons" (Firefox)

4. Click "Load unpacked" (Chrome/Edge) or "Load Temporary Add-on" (Firefox)

5. Select the directory containing the extension files

6. The CaptureCast extension should now appear in your browser toolbar

### For Production

The extension will be available on the Chrome Web Store and Firefox Add-ons once published.

## Usage

1. Click the CaptureCast icon in your browser toolbar
2. Choose your recording source:
   - **This Tab**: Record only the current browser tab
   - **Entire Screen**: Record your entire screen
   - **Application Window**: Record a specific application window
3. Grant permission when prompted by your browser
4. The extension icon will turn red to indicate recording is active
5. Click the red "Stop Recording" overlay or the extension icon to stop
6. A new tab will open with your recording preview
7. Click "Download" to save the video as a .webm file

## Requirements

- Google Chrome, Mozilla Firefox, or Microsoft Edge
- Browser version supporting `getDisplayMedia` and `MediaRecorder` APIs (Chrome 72+, Firefox 66+, Edge 79+)

## Development

### Project Structure

```
├── manifest.json          # Extension configuration
├── popup.html            # Extension popup UI
├── popup.js              # Popup functionality
├── background.js         # Background service worker
├── content.js            # Content script for recording
├── preview.html          # Recording preview page
├── preview.js            # Preview page functionality
├── icons/                # Extension icons
│   ├── icon16.svg
│   ├── icon48.svg
│   ├── icon128.svg
│   └── recording.svg
└── README.md             # This file
```

### Building and Testing

1. Make changes to the source files
2. Reload the extension in your browser's extensions page
3. Test the functionality thoroughly

## Privacy & Security

- All recording and processing happens locally in your browser
- No video data is transmitted to external servers
- The extension only requests necessary permissions for screen recording
- Recordings are stored temporarily in browser memory until downloaded

## License

This project is open source. See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues or questions, please create an issue in this repository.