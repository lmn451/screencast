import { test, expect } from '../lib/fixtures';
import type { BrowserContext, Page } from '@playwright/test';

const RECORDING_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Return live synthetic capture streams so the recorder page exercises its
 * actual getDisplayMedia/getUserMedia and Web Audio mixer path.
 */
async function installSyntheticCapture(context: BrowserContext) {
  await context.addInitScript(() => {
    const makeToneStream = async (frequency: number, includeVideo: boolean) => {
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.2;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await audioContext.resume();

      const stream = includeVideo
        ? (() => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 180;
            const drawing = canvas.getContext('2d');
            if (!drawing) throw new Error('Synthetic capture canvas is unavailable');
            drawing.fillStyle = '#202124';
            drawing.fillRect(0, 0, canvas.width, canvas.height);
            return canvas.captureStream(10);
          })()
        : new MediaStream();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      return stream;
    };

    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getDisplayMedia = () => makeToneStream(440, true);
    navigator.mediaDevices.getUserMedia = () => makeToneStream(880, false);
  });
}

function recorderUrl(extensionId: string) {
  return `chrome-extension://${extensionId}/recorder.html?id=${RECORDING_ID}&mode=tab&mic=1&sys=1`;
}

function previewUrl(extensionId: string) {
  return `chrome-extension://${extensionId}/preview.html?test=1`;
}

async function waitForTestDatabase(page: Page) {
  await page.waitForFunction(() => typeof window.__TEST__?.getRecording === 'function');
}

async function decodeToneMagnitudes(page: Page) {
  return page.evaluate(async (recordingId) => {
    const recording = await window.__TEST__.getRecording(recordingId);
    if (!recording?.blob) return null;

    const decoder = new AudioContext();
    try {
      const decoded = await decoder.decodeAudioData(await recording.blob.arrayBuffer());
      const samples = decoded.getChannelData(0);
      const sampleCount = Math.min(samples.length, Math.floor(decoded.sampleRate * 2));
      const start = samples.length - sampleCount;

      const magnitudeAt = (frequency: number) => {
        const bin = Math.round((sampleCount * frequency) / decoded.sampleRate);
        const omega = (2 * Math.PI * bin) / sampleCount;
        const coefficient = 2 * Math.cos(omega);
        let previous = 0;
        let previousPrevious = 0;
        for (let i = start; i < samples.length; i++) {
          const current = samples[i] + coefficient * previous - previousPrevious;
          previousPrevious = previous;
          previous = current;
        }
        return (
          Math.sqrt(
            previousPrevious * previousPrevious +
              previous * previous -
              coefficient * previous * previousPrevious
          ) / sampleCount
        );
      };

      return {
        sampleRate: decoded.sampleRate,
        duration: decoded.duration,
        size: recording.blob.size,
        system440: magnitudeAt(440),
        microphone880: magnitudeAt(880),
      };
    } finally {
      await decoder.close();
    }
  }, RECORDING_ID);
}

async function waitForSavedRecording(reader: Page) {
  await expect
    .poll(
      async () =>
        reader.evaluate(async (recordingId) => {
          const recording = await window.__TEST__.getRecording(recordingId);
          return { status: recording?.status, size: recording?.blob?.size ?? 0 };
        }, RECORDING_ID),
      { timeout: 15_000 }
    )
    .toMatchObject({ status: 'saved', size: expect.any(Number) });
}

test('preserves system and microphone tones through the mixed MediaRecorder track', async ({
  context,
  extensionId,
}) => {
  await installSyntheticCapture(context);
  const recorder = await context.newPage();
  const reader = await context.newPage();

  try {
    await recorder.goto(recorderUrl(extensionId));
    await expect(recorder.locator('#status')).toHaveText('Recording…', { timeout: 15_000 });

    // Leave enough time for several real MediaRecorder chunks and stable tone
    // samples, then stop through the recorder page's production control.
    await recorder.waitForTimeout(2_500);
    await recorder.locator('#stop').click();

    await reader.goto(previewUrl(extensionId));
    await waitForTestDatabase(reader);
    await waitForSavedRecording(reader);

    const tones = await decodeToneMagnitudes(reader);
    expect(tones).not.toBeNull();
    expect(tones?.duration).toBeGreaterThan(1);
    expect(tones?.size).toBeGreaterThan(0);
    expect(tones?.system440).toBeGreaterThan(0.005);
    expect(tones?.microphone880).toBeGreaterThan(0.005);
  } finally {
    await reader.close().catch(() => {});
    await recorder.close().catch(() => {});
  }
});
