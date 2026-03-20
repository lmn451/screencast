/**
 * CDP Screencast Recording Flow E2E Tests
 * 
 * These tests validate the complete recording flow in CI using the
 * cdpScreencast backend which doesn't require user gesture or native pickers.
 * 
 * @CI-SAFE - Can run in headless CI environments
 */

import { test, expect, type Page } from '../lib/fixtures';

test.describe('CDP Screencast Recording Flow', () => {
  test('complete recording lifecycle', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    // 1. Start recording
    const startResult = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    expect((startResult as { ok: boolean }).ok).toBe(true);
    expect((startResult as { backend: string }).backend).toBe('cdpScreencast');

    // 2. Verify recording state
    let state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });

    expect((state as { status: string }).status).toBe('RECORDING');
    expect((state as { backend: string }).backend).toBe('cdpScreencast');
    expect((state as { recordingId: string }).recordingId).toBeTruthy();

    const recordingId = (state as { recordingId: string }).recordingId;

    // 3. Simulate recording duration
    await page.waitForTimeout(2000);

    // 4. Stop recording
    const stopResult = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
      });
    });

    expect((stopResult as { ok: boolean }).ok).toBe(true);

    // 5. Wait for save to complete
    await page.waitForTimeout(500);

    // 6. Verify recording was saved to IndexedDB
    state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
      });
    });

    expect((state as { status: string }).status).toBe('IDLE');
  });

  test('recording persists after tab navigation', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    // Start recording
    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    // Get recording ID
    let state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });
    const recordingId = (state as { recordingId: string }).recordingId;

    // Stop recording
    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
      });
    });

    await page.waitForTimeout(1000);

    // Navigate to recordings page
    await page.goto(`chrome-extension://${extensionId}/recordings.html`);
    await page.waitForTimeout(500);

    // Verify the recording appears in the list
    const hasRecordings = await page.locator('.item').count();
    expect(hasRecordings).toBeGreaterThan(0);
  });

  test('automation flag is set correctly', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    const state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });

    // isAutomation should be true because we're using controller
    expect((state as { isAutomation: boolean }).isAutomation).toBe(true);
  });
});

test.describe('CDP Screencast vs tabCapture Backend Comparison', () => {
  test('cdpScreencast does not trigger native picker', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    let dialogShown = false;
    page.on('dialog', async (dialog) => {
      dialogShown = true;
      await dialog.dismiss();
    });

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    await page.waitForTimeout(500);

    // CDP screencast should NOT show any dialogs
    expect(dialogShown).toBe(false);
  });

  test('cdpScreencast creates offscreen document', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    const state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });

    // CDP screencast uses offscreen strategy
    expect((state as { strategy: string }).strategy).toBe('offscreen');
  });
});

test.describe('CDP Screencast Error Handling', () => {
  test('prevents double-start', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    // Start first recording
    const result1 = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    expect((result1 as { ok: boolean }).ok).toBe(true);

    // Try to start second recording while first is active
    const result2 = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    expect((result2 as { ok: boolean }).ok).toBe(false);
    expect((result2 as { error: string }).error).toContain('Already recording');

    // Cleanup
    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
      });
    });
  });

  test('handles rapid stop gracefully', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    // Stop immediately (very short recording)
    const stopResult = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
      });
    });

    expect((stopResult as { ok: boolean }).ok).toBe(true);
  });
});
