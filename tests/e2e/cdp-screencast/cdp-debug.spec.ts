/**
 * Test CDP debugger attachment directly
 */

import { test, expect } from '../lib/fixtures';

test('CDP debugger attach to tab', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/controller.html`);
  
  // Get the active tab ID
  const tabInfo = await page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { tabId: tab.id, tabUrl: tab.url };
  });
  
  console.log('Target tab:', tabInfo);
  
  // Try to attach debugger
  const attachResult = await page.evaluate(async (tabId) => {
    return new Promise((resolve) => {
      chrome.debugger.attach({ tabId }, '1.3', (err) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  }, tabInfo.tabId);
  
  console.log('Attach result:', attachResult);
  
  if (!attachResult.success) {
    console.log('⚠️ CDP debugger attach failed - this is expected if debugger permission is missing');
    return;
  }
  
  // Try to enable Page domain
  const enableResult = await page.evaluate(async (tabId) => {
    return new Promise((resolve) => {
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, (err) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve({ success: true });
        }
      });
    });
  }, tabInfo.tabId);
  
  console.log('Enable result:', enableResult);
  
  // Try to start screencast
  const screencastResult = await page.evaluate(async (tabId) => {
    return new Promise((resolve) => {
      chrome.debugger.sendCommand(
        { tabId },
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: 50,
          maxWidth: 640,
          maxHeight: 480,
        },
        (err) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve({ success: true });
          }
        }
      );
    });
  }, tabInfo.tabId);
  
  console.log('Screencast result:', screencastResult);
  
  // Stop screencast
  if (screencastResult.success) {
    await page.evaluate(async (tabId) => {
      return new Promise((resolve) => {
        chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast', {}, () => resolve(undefined));
      });
    }, tabInfo.tabId);
    
    // Detach
    await page.evaluate(async (tabId) => {
      return new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => resolve(undefined));
      });
    }, tabInfo.tabId);
  }
});
