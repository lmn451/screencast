import { test, expect } from '../lib/fixtures';
import type { Page } from '@playwright/test';

test.describe('Controller Page E2E', () => {
  test.beforeEach(async ({ context, extensionId }) => {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
  });

  test('controller page loads and shows IDLE state', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const statusEl = page.locator('#status');
    await expect(statusEl).toContainText('IDLE');
  });

  test('START button is enabled when IDLE', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const btnStart = page.locator('#btnStart');
    await expect(btnStart).toBeEnabled();
  });

  test('STOP button is disabled when IDLE', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const btnStop = page.locator('#btnStop');
    await expect(btnStop).toBeDisabled();
  });

  test('clicking Get State updates status display', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const btnState = page.locator('#btnState');
    await btnState.click();

    const outputEl = page.locator('#output');
    await expect(outputEl).toContainText('"status": "IDLE"');
  });

  test('clicking START calls chrome.runtime.sendMessage with CONTROLLER_START', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const messages: unknown[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'log') {
        messages.push(msg.text());
      }
    });

    const btnStart = page.locator('#btnStart');
    await btnStart.click();

    await page.waitForTimeout(500);

    const startMessage = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
      });
    });

    expect((startMessage as { status: string }).status).toBe('RECORDING');
  });

  test('buttons update state after START', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const btnStart = page.locator('#btnStart');
    const btnStop = page.locator('#btnStop');

    await btnStart.click();

    // Wait for RECORDING state to be observed
    await page.waitForFunction(
      () => {
        const status = document.getElementById('status');
        return status && status.textContent.includes('RECORDING');
      },
      { timeout: 5000 }
    );

    await expect(btnStart).toBeDisabled();
    await expect(btnStop).toBeEnabled();
  });
});

test.describe('Controller Message API via runtime', () => {
  test.beforeEach(async ({ context }) => {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
  });

  test('CONTROLLER_START starts recording with tabCapture backend', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'tabCapture', mode: 'tab' },
          resolve
        );
      });
    });

    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { backend: string }).backend).toBe('tabCapture');
  });

  test('CONTROLLER_STOP stops recording', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_START', backend: 'tabCapture' }, resolve);
      });
    });

    await page.waitForTimeout(300);

    const stopResult = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
      });
    });

    expect((stopResult as { ok: boolean }).ok).toBe(true);
  });

  test('CONTROLLER_STATE returns current state', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });

    expect(state).toHaveProperty('status');
    expect(state).toHaveProperty('backend');
    expect(state).toHaveProperty('recording');
  });

  test('CONTROLLER_START with cdpScreencast backend', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CONTROLLER_START', backend: 'cdpScreencast', mode: 'tab' },
          resolve
        );
      });
    });

    expect((result as { ok: boolean }).ok).toBe(true);
    expect((result as { backend: string }).backend).toBe('cdpScreencast');
  });
});
