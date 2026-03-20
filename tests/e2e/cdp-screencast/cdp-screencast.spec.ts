import { test, expect } from '../lib/fixtures';

test.describe('CDP Screencast Backend E2E', () => {
  test.beforeEach(async ({ context }) => {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
  });

  test('cdpScreencast backend responds correctly to START', async ({ context, extensionId }) => {
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

  test('cdpScreencast backend does not show picker', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    let pickerShown = false;
    page.on('dialog', async (dialog) => {
      pickerShown = true;
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
    expect(pickerShown).toBe(false);
  });

  test('state shows backend as cdpScreencast after start', async ({ context, extensionId }) => {
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

    expect((state as { backend: string }).backend).toBe('cdpScreencast');
    expect((state as { status: string }).status).toBe('RECORDING');
  });

  test('can stop cdpScreencast recording', async ({ context, extensionId }) => {
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

    await page.waitForTimeout(300);

    const stopResult = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
      });
    });

    expect((stopResult as { ok: boolean }).ok).toBe(true);
  });

  test('recording ID is generated on start', async ({ context, extensionId }) => {
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

    expect((state as { recordingId: string }).recordingId).toBeTruthy();
  });
});

test.describe('CDP Screencast vs tabCapture comparison', () => {
  test.beforeEach(async ({ context }) => {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
  });

  test('tabCapture sets isAutomation: true', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_START', backend: 'tabCapture' }, resolve);
      });
    });

    const state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });

    expect((state as { isAutomation: boolean }).isAutomation).toBe(true);
  });

  test('cdpScreencast sets isAutomation: true', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_START', backend: 'cdpScreencast' }, resolve);
      });
    });

    const state = await page.evaluate(() => {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
      });
    });

    expect((state as { isAutomation: boolean }).isAutomation).toBe(true);
  });

  test('both backends record in STATE', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/controller.html`);

    for (const backend of ['tabCapture', 'cdpScreencast']) {
      await page.evaluate(
        (b) => {
          return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'CONTROLLER_START', backend: b }, resolve);
          });
        },
        [backend]
      );

      const state = await page.evaluate(() => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'CONTROLLER_STATE' }, resolve);
        });
      });

      expect((state as { recording: boolean }).recording).toBe(true);

      await page.evaluate(() => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' }, resolve);
        });
      });

      await page.waitForTimeout(200);
    }
  });
});
