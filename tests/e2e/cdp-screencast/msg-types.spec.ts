/**
 * Test different message types with fixtures
 */

import { test, expect } from '../lib/fixtures';

test('GET_STATE works', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ timeout: true }), 5000);
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
        resolve({ response, error: chrome.runtime.lastError });
      });
    });
  });
  
  console.log('GET_STATE result:', result);
  expect(result).toHaveProperty('response');
});

test('OFFSCREEN_TEST works', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ timeout: true }), 5000);
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_TEST' }, (response) => {
        resolve({ response, error: chrome.runtime.lastError });
      });
    });
  });
  
  console.log('OFFSCREEN_TEST result:', result);
  expect(result).toHaveProperty('response');
});

test('CONTROLLER_START with tabCapture works', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ timeout: true }), 10000);
      chrome.runtime.sendMessage(
        { type: 'CONTROLLER_START', backend: 'tabCapture' },
        (response) => {
          resolve({ response, error: chrome.runtime.lastError });
        }
      );
    });
  });
  
  console.log('tabCapture result:', result);
  
  // Stop if started
  if (result?.response?.ok) {
    await page.evaluate(() => {
      chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' });
    });
  }
});

test('CONTROLLER_START with cdpScreencast works', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  const result = await page.evaluate(() => {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ timeout: true }), 10000);
      chrome.runtime.sendMessage(
        { type: 'CONTROLLER_START', backend: 'cdpScreencast' },
        (response) => {
          resolve({ response, error: chrome.runtime.lastError });
        }
      );
    });
  });
  
  console.log('cdpScreencast result:', result);
  
  // Stop if started
  if (result?.response?.ok) {
    await page.evaluate(() => {
      chrome.runtime.sendMessage({ type: 'CONTROLLER_STOP' });
    });
  }
});
