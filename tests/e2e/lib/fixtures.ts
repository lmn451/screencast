import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const pathToExtension = path.resolve(__dirname, '../../..');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
      ],
    });

    await context.addInitScript(() => {
      const makeVideoStream = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        let frame = 0;
        const timer = window.setInterval(() => {
          frame += 1;
          if (!context) return;
          context.fillStyle = '#222';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#0f0';
          context.fillRect((frame * 10) % canvas.width, 60, 40, 40);
        }, 100);
        const stream = canvas.captureStream(10);
        stream.getVideoTracks()[0]?.addEventListener('ended', () => window.clearInterval(timer));
        return stream;
      };

      if (navigator.mediaDevices) {
        navigator.mediaDevices.getDisplayMedia = async () => makeVideoStream();
        navigator.mediaDevices.getUserMedia = async () => new MediaStream();
      }
    });

    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
});

export { expect } from '@playwright/test';

export async function generateWebmBlobInPage(page: Page) {
  return await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const draw = canvas.getContext('2d');
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      if (!draw) return;
      draw.fillStyle = '#222';
      draw.fillRect(0, 0, canvas.width, canvas.height);
      draw.fillStyle = '#0f0';
      draw.fillRect((frame * 10) % canvas.width, 60, 40, 40);
    }, 100);

    const stream = canvas.captureStream(10);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    window.clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: 'video/webm' });
    return {
      size: blob.size,
      type: blob.type,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    };
  });
}
