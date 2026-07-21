import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const outputDir = path.join(root, 'store-assets');

const screenshots = [
  {
    file: 'capturecast-01-consent-1280x800.png',
    page: 'consent.html?mode=tab&mic=false&systemAudio=false',
    title: 'Choose what to capture',
    subtitle: 'CaptureCast keeps every recording on your device.',
    width: 560,
  },
  {
    file: 'capturecast-02-popup-1280x800.png',
    page: 'popup.html',
    title: 'Record from your browser toolbar',
    subtitle: 'Choose audio options, then start recording in one click.',
    width: 420,
  },
  {
    file: 'capturecast-03-recordings-1280x800.png',
    page: 'recordings.html',
    title: 'Your recordings, stored locally',
    subtitle: 'Preview, download, or delete recordings without an account.',
    width: 980,
  },
  {
    file: 'capturecast-04-recovery-1280x800.png',
    page: 'recovery.html',
    title: 'Crash recovery when you need it',
    subtitle: 'Recover interrupted recordings from the browser.',
    width: 900,
  },
];

async function decorate(page, config) {
  await page.evaluate((settings) => {
    const original = document.createElement('div');
    while (document.body.firstChild) original.append(document.body.firstChild);

    document.body.style.cssText = [
      'margin: 0',
      'min-width: 1280px',
      'min-height: 800px',
      'background: linear-gradient(135deg, #eef4ff 0%, #f8fbff 55%, #eaf7f1 100%)',
      'font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    ].join(';');

    const stage = document.createElement('main');
    stage.style.cssText = [
      'width: 1120px',
      'min-height: 680px',
      'margin: 60px auto',
      'padding: 42px 56px',
      'box-sizing: border-box',
      'background: rgba(255,255,255,0.92)',
      'border: 1px solid rgba(26,115,232,0.12)',
      'border-radius: 28px',
      'box-shadow: 0 20px 60px rgba(32,50,80,0.16)',
    ].join(';');

    const title = document.createElement('h1');
    title.textContent = settings.title;
    title.style.cssText = 'margin:0;color:#17345f;font-size:34px;line-height:1.15;font-weight:750;';
    const subtitle = document.createElement('p');
    subtitle.textContent = settings.subtitle;
    subtitle.style.cssText = 'margin:12px 0 30px;color:#526581;font-size:18px;';

    const panel = document.createElement('section');
    panel.style.cssText = [
      'width: ' + settings.width + 'px',
      'min-height: 360px',
      'margin: 0 auto',
      'padding: 26px',
      'box-sizing: border-box',
      'background: #fff',
      'border: 1px solid #dce5f2',
      'border-radius: 18px',
      'box-shadow: 0 8px 24px rgba(32,50,80,0.10)',
      'overflow: hidden',
    ].join(';');

    panel.append(original);
    stage.append(title, subtitle, panel);
    document.body.replaceChildren(stage);
  }, config);
}

async function capturePreviewScreenshot(context, extensionId) {
  const controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/preview.html?test=1`, {
    waitUntil: 'networkidle',
  });

  const start = await controlPage.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage(
          { type: 'START', mode: 'tab', mic: false, systemAudio: false },
          resolve
        )
      )
  );
  if (!start?.ok) throw new Error(`Unable to start screenshot recording: ${start?.error}`);

  const state = await controlPage.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve))
  );
  const recordingId = state?.recordingId;
  if (!recordingId) throw new Error('Screenshot recording did not produce a recording ID');

  await controlPage.waitForFunction(() => Boolean(window.__TEST__?.saveChunk));
  const generated = await controlPage.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const draw = canvas.getContext('2d');
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      if (!draw) return;
      draw.fillStyle = '#16345f';
      draw.fillRect(0, 0, canvas.width, canvas.height);
      draw.fillStyle = '#2d8cff';
      draw.fillRect((frame * 12) % canvas.width, 130, 90, 90);
      draw.fillStyle = '#fff';
      draw.font = 'bold 32px system-ui';
      draw.fillText('CaptureCast demo recording', 32, 70);
    }, 100);
    const stream = canvas.captureStream(10);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    window.clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    return { type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });

  await controlPage.evaluate(
    async ({ recordingId, generated }) => {
      const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.type });
      await window.__TEST__.saveChunk(recordingId, blob, 0);
      await window.__TEST__.finishRecording(recordingId, 'video/webm', 900, blob.size);
    },
    { recordingId, generated }
  );

  const expectedPrefix = `chrome-extension://${extensionId}/preview.html?id=${encodeURIComponent(recordingId)}`;
  const previewPromise = context.waitForEvent('page', {
    predicate: (page) => page.url().startsWith(expectedPrefix),
  });
  const dataResult = await controlPage.evaluate(
    ({ recordingId }) =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage(
          { type: 'OFFSCREEN_DATA', recordingId, mimeType: 'video/webm' },
          resolve
        )
      ),
    { recordingId }
  );
  if (!dataResult?.ok) throw new Error(`Unable to open preview screenshot: ${dataResult?.error}`);

  const preview = await previewPromise;
  await preview.waitForSelector('#video');
  await preview.waitForFunction(
    () => document.querySelector('#video')?.dataset.stable === 'true',
    null,
    { timeout: 15000 }
  );
  await preview.locator('#video').evaluate((video) => {
    video.style.width = '760px';
    video.style.height = '300px';
    video.style.objectFit = 'contain';
  });
  await decorate(preview, {
    title: 'Preview, name, and download',
    subtitle: 'Review the result instantly, then download your WebM file.',
    width: 980,
  });
  await preview.screenshot({
    path: path.join(outputDir, 'capturecast-05-preview-1280x800.png'),
    type: 'png',
    animations: 'disabled',
  });
  await preview.close();
  await controlPage.close();
  console.log('Created capturecast-05-preview-1280x800.png');
}

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});

try {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(serviceWorker.url()).host;

  for (const config of screenshots) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${config.page}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    await decorate(page, config);
    await page.screenshot({
      path: path.join(outputDir, config.file),
      type: 'png',
      animations: 'disabled',
    });
    await page.close();
    console.log(`Created ${config.file}`);
  }
  await capturePreviewScreenshot(context, extensionId);
} finally {
  await context.close();
}
