import { jest } from '@jest/globals';
import {
  MSG_GET_STATE,
  MSG_OVERLAY_REMOVE,
  MSG_STATE_UPDATE,
  MSG_STOP,
} from '../../src/messages.js';

let messageListener;

function flushPromises() {
  return Promise.resolve();
}

function overlayButton() {
  return document.querySelector('#cc-overlay button');
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  document.querySelector('#cc-overlay')?.remove();
  messageListener = null;
  global.chrome = {
    runtime: {
      sendMessage: jest.fn(),
      onMessage: {
        addListener: jest.fn((listener) => {
          messageListener = listener;
        }),
      },
    },
  };
});

afterEach(() => {
  document.querySelector('#cc-overlay')?.remove();
  jest.useRealTimers();
});

it.each([
  ['a rejected poll', () => Promise.reject(new Error('transient failure'))],
  ['a statusless poll', () => Promise.resolve({})],
])('recovers from %s while starting', async (_failure, failedPoll) => {
  chrome.runtime.sendMessage
    .mockResolvedValueOnce({ status: 'starting' })
    .mockImplementationOnce(failedPoll)
    .mockResolvedValueOnce({ status: 'recording' });

  await import('../../src/entries/overlay.js');
  await flushPromises();

  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG_GET_STATE });
  expect(overlayButton()).toMatchObject({ disabled: true, textContent: 'Starting…' });
  messageListener({ type: MSG_STATE_UPDATE, status: 'starting' });
  messageListener({ type: MSG_STATE_UPDATE, status: 'starting' });

  await jest.advanceTimersByTimeAsync(1000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  expect(overlayButton()).toMatchObject({ disabled: true, textContent: 'Starting…' });

  await jest.advanceTimersByTimeAsync(1000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
  expect(overlayButton()).toMatchObject({ disabled: false, textContent: 'Stop' });

  await jest.advanceTimersByTimeAsync(5000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(3);
});

it('cancels a scheduled starting poll when the overlay is removed', async () => {
  chrome.runtime.sendMessage.mockResolvedValueOnce({ status: 'starting' });

  await import('../../src/entries/overlay.js');
  await flushPromises();
  expect(overlayButton()).toMatchObject({ disabled: true, textContent: 'Starting…' });

  messageListener({ type: MSG_OVERLAY_REMOVE });
  expect(document.querySelector('#cc-overlay')).toBeNull();

  await jest.advanceTimersByTimeAsync(5000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
});

it('does not restart polling when an in-flight query finishes after removal', async () => {
  let resolvePoll;
  const inFlightPoll = new Promise((resolve) => {
    resolvePoll = resolve;
  });
  chrome.runtime.sendMessage
    .mockResolvedValueOnce({ status: 'starting' })
    .mockReturnValueOnce(inFlightPoll);

  await import('../../src/entries/overlay.js');
  await flushPromises();
  await jest.advanceTimersByTimeAsync(1000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);

  messageListener({ type: MSG_OVERLAY_REMOVE });
  resolvePoll({});
  await flushPromises();
  await jest.advanceTimersByTimeAsync(5000);

  expect(document.querySelector('#cc-overlay')).toBeNull();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
});

it('ignores an in-flight starting response after a newer recording update', async () => {
  let resolvePoll;
  const inFlightPoll = new Promise((resolve) => {
    resolvePoll = resolve;
  });
  chrome.runtime.sendMessage
    .mockResolvedValueOnce({ status: 'starting' })
    .mockReturnValueOnce(inFlightPoll);

  await import('../../src/entries/overlay.js');
  await flushPromises();
  await jest.advanceTimersByTimeAsync(1000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);

  messageListener({ type: MSG_STATE_UPDATE, status: 'recording' });
  expect(overlayButton()).toMatchObject({ disabled: false, textContent: 'Stop' });

  resolvePoll({ status: 'starting' });
  await flushPromises();
  await flushPromises();

  expect(overlayButton()).toMatchObject({ disabled: false, textContent: 'Stop' });
  await jest.advanceTimersByTimeAsync(5000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
});

it('keeps the local saving state when the initial query finishes after stop starts', async () => {
  let resolveInitialState;
  const initialState = new Promise((resolve) => {
    resolveInitialState = resolve;
  });
  chrome.runtime.sendMessage.mockReturnValueOnce(initialState).mockResolvedValueOnce({ ok: true });

  await import('../../src/entries/overlay.js');
  overlayButton().click();

  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG_STOP });
  expect(overlayButton()).toMatchObject({ disabled: true, textContent: 'Saving…' });

  resolveInitialState({ status: 'starting' });
  await flushPromises();
  await flushPromises();

  expect(overlayButton()).toMatchObject({ disabled: true, textContent: 'Saving…' });
  await jest.advanceTimersByTimeAsync(5000);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
});
