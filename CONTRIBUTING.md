# Contributing to CaptureCast

Thank you for your interest in contributing to CaptureCast! This document provides guidelines and instructions for contributing.

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Keep discussions on topic

## Getting Started

### Prerequisites

- Node.js 18+ and pnpm 10+
- Chromium-based browser (Chrome, Edge, Brave)
- Basic knowledge of JavaScript, Chrome Extensions API

### Setup

1. Fork and clone the repository:

```bash
git clone https://github.com/yourusername/capturecast.git
cd capturecast
```

2. Install dependencies:

```bash
npm install
```

3. Load extension in browser:
   - Open `chrome://extensions/`
   - Enable Developer Mode
   - Click "Load unpacked"
   - Select the repository root folder

### Development Workflow

1. Create a feature branch:

```bash
git checkout -b feature/your-feature-name
```

2. Make your changes following the style guide (see CRUSH.md)

3. Test your changes:

   - Manual testing: Reload extension, test recording flow
   - Automated tests: `npm run e2e`

4. Commit with clear messages:

```bash
git commit -m "feat: add keyboard shortcuts for stop"
```

5. Push and create Pull Request:

```bash
git push origin feature/your-feature-name
```

## What to Contribute

### Bug Reports

Found a bug? Please open an issue with:

- **Description**: Clear description of the problem
- **Steps to Reproduce**: Numbered steps to reproduce
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Environment**: Browser version, OS, extension version
- **Screenshots/Logs**: If applicable

Example:

```markdown
## Bug: Recording fails on YouTube

**Steps to Reproduce:**

1. Open youtube.com
2. Click extension icon
3. Click "Record"
4. Select "Current Tab"

**Expected:** Recording starts
**Actual:** Error message "Failed to start recording"

**Environment:** Chrome 120, macOS 14, Extension v0.2.0
```

### Feature Requests

Have an idea? Open an issue with:

- **Problem Statement**: What problem does this solve?
- **Proposed Solution**: How would you solve it?
- **Alternatives Considered**: Other ways to solve it
- **Additional Context**: Mockups, examples, etc.

### Code Contributions

We welcome:

- Bug fixes
- Performance improvements
- Documentation improvements
- New features (discuss in issue first)

## Coding Guidelines

### Style Guide

Follow CRUSH.md for:

- 2-space indentation
- Semicolons omitted (ASI)
- camelCase for variables/functions
- UPPER_CASE for constants
- Descriptive names

### Code Patterns

#### Error Handling

```javascript
// Always wrap Chrome API calls
async function doSomething() {
  try {
    const result = await chrome.some.api();
    return { ok: true, result };
  } catch (e) {
    console.error('Error doing something:', e);
    return { ok: false, error: e.message };
  }
}
```

#### Message Handling

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate sender
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Unauthorized' });
    return;
  }

  (async () => {
    try {
      // Handle message
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // Keep channel open
});
```

#### Database Operations

```javascript
// Always close connections
export async function saveData(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const request = tx.objectStore(STORE).put({ key, value });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}
```

### Testing

#### Manual Testing Checklist

Before submitting:

- [ ] Extension loads without errors
- [ ] Can start recording (tab mode)
- [ ] Overlay appears on page
- [ ] Can stop via overlay
- [ ] Can stop via popup
- [ ] Preview page opens
- [ ] Video plays in preview
- [ ] Can download video
- [ ] Can delete recording
- [ ] Badge shows during recording
- [ ] Works with microphone enabled
- [ ] Works with system audio enabled

#### E2E Tests

Add tests for new features:

```typescript
test('my new feature works', async ({ context, extensionId }) => {
  // Test implementation
});
```

Run tests:

```bash
npm run e2e              # All tests
npm run e2e:stop         # Specific suite
```

### Documentation

Update documentation when:

- Adding new features
- Changing architecture
- Modifying APIs/messages
- Fixing bugs (if not obvious)

Files to update:

- `README.md`: User-facing changes
- `ARCHITECTURE.md`: Technical changes
- `CHANGELOG.md`: All changes
- `docs/*.md`: Specific documentation
- Code comments: Complex logic

## Pull Request Process

### PR Title

Use conventional commits format:

- `feat: add keyboard shortcuts`
- `fix: resolve race condition in stop flow`
- `docs: update installation instructions`
- `refactor: simplify message handling`
- `perf: optimize codec fallback logic`
- `test: add preview page tests`

### PR Description

Include:

```markdown
## Description

Brief description of changes

## Motivation

Why is this change needed?

## Changes

- Change 1
- Change 2

## Testing

How was this tested?

## Screenshots

If UI changes

## Checklist

- [ ] Code follows style guide
- [ ] Tests pass
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
```

### Review Process

1. Automated checks run (if configured)
2. Maintainer reviews code
3. Address feedback
4. Approved and merged

### After Merge

- Delete your feature branch
- Pull latest main
- Celebrate! 🎉

## Architecture Guidelines

### Adding New Components

1. Document in ARCHITECTURE.md
2. Follow existing patterns
3. Add message types to protocol section
4. Consider security implications
5. Add error handling

### Modifying State

State changes should:

- Go through background.js
- Be properly reset in `resetRecordingState()`
- Consider MV3 service worker suspension
- Be tested for race conditions

### Adding Permissions

New permissions require:

- Justification in docs/permissions.md
- Privacy policy update
- Security review
- User communication (CHANGELOG)

## Release Process

(For maintainers)

1. Update version in `manifest.json`
2. Update `CHANGELOG.md`
3. Commit: `git commit -m "chore: bump version to X.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push && git push --tags`
6. Package: `./scripts/package.sh`
7. Upload to Chrome Web Store
8. Create GitHub release with notes

## Questions?

- Open an issue for questions
- Check existing issues/PRs first
- Be patient, maintainers are volunteers

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

---

Thank you for contributing to CaptureCast! 🚀
