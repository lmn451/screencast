import { jest } from '@jest/globals';
import { findRecorderContextTabIds } from '../../src/lib/recorder-context.ts';

const originalChrome = global.chrome;
beforeEach(() => {
  global.chrome = { runtime: { getURL: (path) => `chrome-extension://test/${path}` } };
});
afterEach(() => {
  global.chrome = originalChrome;
});

it('uses extension contexts to identify only the matching recorder document', async () => {
  chrome.runtime.getContexts = jest.fn(async () => [
    { tabId: 10, documentUrl: 'chrome-extension://test/recorder.html?id=recording-1' },
    { tabId: 11, documentUrl: 'chrome-extension://test/recorder.html?id=recording-2' },
    { tabId: 12, documentUrl: 'chrome-extension://other/recorder.html?id=recording-1' },
    { tabId: 13, documentUrl: 'https://example.com/recorder.html?id=recording-1' },
  ]);
  expect(await findRecorderContextTabIds('recording-1')).toEqual([10]);
  expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['TAB'] });
});

it('uses extension-owned Firefox views when runtime contexts are unavailable', async () => {
  const getCurrent = jest.fn((callback) => callback({ id: 20 }));
  chrome.extension = {
    getViews: jest.fn(() => [
      {
        location: { href: 'chrome-extension://test/recorder.html?id=recording-1' },
        chrome: { tabs: { getCurrent }, runtime: {} },
      },
      { location: { href: 'chrome-extension://test/consent.html' } },
    ]),
  };
  expect(await findRecorderContextTabIds('recording-1')).toEqual([20]);
  expect(getCurrent).toHaveBeenCalledTimes(1);
});

it('keeps unavailable context discovery distinct from a recorder that is gone', async () => {
  await expect(findRecorderContextTabIds('recording-1')).rejects.toThrow('unavailable');
  chrome.runtime.getContexts = jest.fn(async () => []);
  expect(await findRecorderContextTabIds('recording-1')).toEqual([]);
});
