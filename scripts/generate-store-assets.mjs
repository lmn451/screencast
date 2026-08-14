#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'store-assets');
const screenshotDir = path.join(outputDir, 'screenshots');
const iconPath = path.join(projectRoot, 'icons', 'icon-256.png');
const overlayBundlePath = path.join(projectRoot, 'build', 'overlay.js');

const palette = {
  ink: '#15182e',
  muted: '#62677f',
  blue: '#2495d0',
  blueDark: '#1c6fa8',
  violet: '#7377d8',
  cream: '#f7f8fc',
  white: '#ffffff',
  red: '#d93025',
};

function dataUrl(buffer, mimeType = 'image/png') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function htmlDocument(content, extraStyles = '') {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
      body {
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: ${palette.ink};
        -webkit-font-smoothing: antialiased;
      }
      ${extraStyles}
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

async function renderPage(context, { width, height, content, outputPath }) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width, height });
    await page.setContent(content, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await page.close();
  }
}

function brandMark(iconUrl, size = 44) {
  return `<div class="brand">
    <img src="${iconUrl}" alt="" width="${size}" height="${size}">
    <span>ScreenSilo</span>
  </div>`;
}

function framedScreenshot({
  iconUrl,
  eyebrow,
  title,
  description,
  imageUrl,
  objectFit = 'contain',
}) {
  return htmlDocument(
    `<main class="canvas">
      <div class="orb orb-one"></div>
      <div class="orb orb-two"></div>
      <header>
        ${brandMark(iconUrl)}
        <div class="privacy-pill"><span></span> Local by default</div>
      </header>
      <section class="copy">
        <p class="eyebrow">${eyebrow}</p>
        <h1>${title}</h1>
        <p class="description">${description}</p>
      </section>
      <section class="browser-shell">
        <div class="browser-bar">
          <div class="dots"><i></i><i></i><i></i></div>
          <div class="address">ScreenSilo · on-device recording</div>
        </div>
        <div class="shot"><img src="${imageUrl}" alt=""></div>
      </section>
    </main>`,
    `
      .canvas { position: relative; width: 100%; height: 100%; padding: 42px 60px; background: linear-gradient(145deg, #f8f9fd 0%, #eef3fb 100%); overflow: hidden; }
      .orb { position: absolute; border-radius: 999px; filter: blur(2px); opacity: .48; }
      .orb-one { width: 420px; height: 420px; right: -150px; top: -190px; background: #ccd6ff; }
      .orb-two { width: 330px; height: 330px; left: -180px; bottom: -220px; background: #bdeaf7; }
      header { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; }
      .brand { display: flex; align-items: center; gap: 12px; font-weight: 760; font-size: 23px; letter-spacing: -.4px; }
      .brand img { border-radius: 12px; box-shadow: 0 8px 22px rgba(29, 44, 84, .12); }
      .privacy-pill { display: flex; align-items: center; gap: 8px; color: #404761; background: rgba(255,255,255,.8); border: 1px solid rgba(94,104,148,.14); border-radius: 999px; padding: 9px 14px; font-size: 14px; font-weight: 650; }
      .privacy-pill span { width: 8px; height: 8px; background: #2aa876; border-radius: 50%; box-shadow: 0 0 0 4px rgba(42,168,118,.12); }
      .copy { position: relative; z-index: 1; margin-top: 29px; }
      .eyebrow { margin: 0 0 7px; color: ${palette.blueDark}; text-transform: uppercase; letter-spacing: 1.8px; font-size: 13px; font-weight: 800; }
      h1 { max-width: 700px; margin: 0; font-size: 38px; line-height: 1.08; letter-spacing: -1.35px; }
      .description { margin: 9px 0 0; color: ${palette.muted}; font-size: 17px; line-height: 1.45; }
      .browser-shell { position: absolute; z-index: 1; left: 60px; right: 60px; top: 245px; bottom: 34px; border-radius: 18px; overflow: hidden; background: white; border: 1px solid rgba(56, 64, 104, .14); box-shadow: 0 26px 70px rgba(36, 44, 82, .18); }
      .browser-bar { height: 43px; display: flex; align-items: center; padding: 0 16px; background: #f4f5f8; border-bottom: 1px solid #e1e4ec; }
      .dots { display: flex; gap: 7px; }
      .dots i { width: 9px; height: 9px; border-radius: 50%; background: #c7cad4; }
      .dots i:first-child { background: #ef8178; } .dots i:nth-child(2) { background: #e8bd58; } .dots i:last-child { background: #65be7d; }
      .address { margin: 0 auto; transform: translateX(-22px); padding: 6px 120px; border-radius: 8px; background: white; color: #85899a; font-size: 12px; }
      .shot { width: 100%; height: calc(100% - 43px); display: flex; align-items: center; justify-content: center; background: #fff; overflow: hidden; }
      .shot img { display: block; width: 100%; height: 100%; object-fit: ${objectFit}; object-position: center; }
    `
  );
}

function choiceScreenshot({ iconUrl, popupUrl, consentUrl }) {
  return htmlDocument(
    `<main class="canvas">
      <div class="glow"></div>
      <header>${brandMark(iconUrl)}<div class="chip">No sign-in · No cloud</div></header>
      <section class="copy">
        <p>CAPTURE WITH CLARITY</p>
        <h1>You decide exactly what gets recorded.</h1>
        <span>Choose audio and quality settings, then review them before capture starts.</span>
      </section>
      <section class="ui-stage">
        <div class="panel popup-panel">
          <div class="label"><b>1</b> Choose your settings</div>
          <div class="ui popup-ui"><img src="${popupUrl}" alt="ScreenSilo popup"></div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="panel consent-panel">
          <div class="label"><b>2</b> Confirm before recording</div>
          <div class="ui consent-ui"><img src="${consentUrl}" alt="ScreenSilo consent screen"></div>
        </div>
      </section>
    </main>`,
    `
      .canvas { position: relative; width: 100%; height: 100%; padding: 42px 60px; background: linear-gradient(145deg, #f9fafc, #edf3fb); overflow: hidden; }
      .glow { position: absolute; width: 500px; height: 500px; right: -110px; top: -220px; border-radius: 50%; background: radial-gradient(circle, rgba(115,119,216,.28), rgba(115,119,216,0)); }
      header { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; }
      .brand { display: flex; align-items: center; gap: 12px; font-weight: 760; font-size: 23px; letter-spacing: -.4px; }
      .brand img { border-radius: 12px; box-shadow: 0 8px 22px rgba(29,44,84,.12); }
      .chip { color: #39725f; border: 1px solid rgba(42,168,118,.25); background: rgba(236,251,246,.8); border-radius: 999px; padding: 9px 14px; font-size: 14px; font-weight: 700; }
      .copy { position: relative; z-index: 1; margin-top: 24px; text-align: center; }
      .copy p { margin: 0 0 7px; color: ${palette.blueDark}; letter-spacing: 1.7px; font-size: 13px; font-weight: 850; }
      .copy h1 { margin: 0 auto; max-width: 760px; font-size: 37px; line-height: 1.08; letter-spacing: -1.3px; }
      .copy span { display: block; margin-top: 8px; color: ${palette.muted}; font-size: 16px; }
      .ui-stage { position: absolute; z-index: 1; left: 100px; right: 100px; bottom: 32px; top: 245px; display: grid; grid-template-columns: .82fr 50px 1.18fr; align-items: center; }
      .panel { height: 100%; display: flex; flex-direction: column; align-items: center; }
      .label { height: 33px; color: #4d536a; font-size: 14px; font-weight: 650; }
      .label b { display: inline-grid; place-items: center; width: 24px; height: 24px; margin-right: 7px; color: white; background: ${palette.violet}; border-radius: 50%; font-size: 12px; }
      .ui { min-height: 0; flex: 1; width: 100%; display: flex; align-items: center; justify-content: center; }
      .ui img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; filter: drop-shadow(0 20px 28px rgba(32,42,80,.16)); }
      .popup-ui img { max-height: 335px; border-radius: 13px; }
      .consent-ui img { max-height: 420px; border-radius: 16px; }
      .flow-arrow { color: #9ba1bb; font-size: 38px; font-weight: 300; text-align: center; }
    `
  );
}

function demoPage() {
  return htmlDocument(
    `<main class="demo">
      <nav>
        <div class="demo-logo">Northstar</div>
        <div class="nav-items"><span>Overview</span><span>Projects</span><span>Reports</span><i>AS</i></div>
      </nav>
      <section class="heading">
        <div><small>PROJECT OVERVIEW</small><h1>Launch dashboard</h1><p>A sample page showing ScreenSilo's in-page recording control.</p></div>
        <div class="recording-pill"><b></b> ScreenSilo is recording</div>
      </section>
      <section class="metrics">
        <article><span>Completion</span><strong>78%</strong><em>↑ 12% this week</em></article>
        <article><span>Open tasks</span><strong>24</strong><em>6 due today</em></article>
        <article><span>Team members</span><strong>8</strong><em>All active</em></article>
      </section>
      <section class="work">
        <article class="chart-card"><div class="card-title"><b>Weekly activity</b><span>Last 7 days</span></div><div class="chart"><i style="height:31%"></i><i style="height:47%"></i><i style="height:40%"></i><i style="height:68%"></i><i style="height:56%"></i><i style="height:82%"></i><i style="height:73%"></i></div><div class="axis"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div></article>
        <article class="tasks"><div class="card-title"><b>Recent tasks</b><span>View all</span></div><ul><li><i></i><div><b>Review launch checklist</b><span>Product · Today</span></div><em>In progress</em></li><li><i></i><div><b>Prepare customer demo</b><span>Sales · Tomorrow</span></div><em>Ready</em></li><li><i></i><div><b>Update release notes</b><span>Engineering · Friday</span></div><em>Draft</em></li></ul></article>
      </section>
    </main>`,
    `
      body { background: #f4f6fa; }
      .demo { min-height: 100%; padding-bottom: 45px; }
      nav { height: 72px; padding: 0 62px; display: flex; align-items: center; justify-content: space-between; background: white; border-bottom: 1px solid #e4e7ef; }
      .demo-logo { font-size: 22px; font-weight: 850; letter-spacing: -.8px; color: #2f396a; }
      .nav-items { display: flex; align-items: center; gap: 30px; color: #6a6f82; font-size: 14px; }
      .nav-items i { display: grid; place-items: center; width: 38px; height: 38px; color: white; background: #6e73cf; border-radius: 50%; font-style: normal; font-weight: 700; }
      .heading { margin: 46px 62px 26px; display: flex; align-items: center; justify-content: space-between; }
      .heading small { color: #7b8094; letter-spacing: 1.5px; font-weight: 750; }
      .heading h1 { margin: 7px 0 6px; font-size: 35px; letter-spacing: -1.2px; }
      .heading p { margin: 0; color: #74798d; }
      .recording-pill { margin-right: 100px; display: flex; align-items: center; gap: 9px; color: #9e302a; background: #fff0ef; border: 1px solid #f2cac7; padding: 10px 15px; border-radius: 999px; font-size: 14px; font-weight: 700; }
      .recording-pill b { width: 9px; height: 9px; background: ${palette.red}; border-radius: 50%; box-shadow: 0 0 0 4px rgba(217,48,37,.11); }
      .metrics { margin: 0 62px 24px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
      .metrics article, .work article { background: white; border: 1px solid #e3e6ef; border-radius: 15px; box-shadow: 0 8px 25px rgba(42,49,84,.05); }
      .metrics article { padding: 21px 23px; display: grid; gap: 8px; }
      .metrics span { color: #777c8e; font-size: 13px; }
      .metrics strong { font-size: 29px; }
      .metrics em { color: #3b9876; font-size: 12px; font-style: normal; }
      .work { margin: 0 62px; display: grid; grid-template-columns: 1.2fr .8fr; gap: 20px; }
      .work article { height: 294px; padding: 22px; }
      .card-title { display: flex; justify-content: space-between; align-items: center; }
      .card-title span { color: #858a9c; font-size: 12px; }
      .chart { height: 178px; margin-top: 20px; padding: 0 12px; border-bottom: 1px solid #e8eaf0; display: flex; align-items: flex-end; justify-content: space-around; gap: 18px; }
      .chart i { width: 39px; border-radius: 8px 8px 2px 2px; background: linear-gradient(#7a80dd, #48a3d6); }
      .axis { display: flex; justify-content: space-around; padding: 8px 5px 0; color: #8b8fa0; font-size: 11px; }
      ul { list-style: none; padding: 9px 0 0; margin: 0; }
      li { display: flex; align-items: center; gap: 11px; padding: 13px 0; border-bottom: 1px solid #eef0f4; }
      li > i { width: 10px; height: 10px; border: 2px solid #6e73cf; border-radius: 3px; }
      li div { display: grid; gap: 3px; flex: 1; }
      li div b { font-size: 13px; } li div span { color: #8a8e9e; font-size: 11px; }
      li em { color: #6b7190; background: #f0f1f7; border-radius: 999px; padding: 5px 8px; font-size: 10px; font-style: normal; }
    `
  );
}

async function waitForExtensionId(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  return new URL(worker.url()).host;
}

async function seedGallery(page, posterUrl) {
  await page.evaluate(async (poster) => {
    const records = [
      {
        id: '3b77b5df-55a7-4dc5-99df-e998bb85b312',
        name: 'Product walkthrough',
        mimeType: 'video/webm',
        duration: 192_000,
        size: 18_559_303,
        createdAt: Date.now() - 42 * 60 * 1000,
        status: 'saved',
      },
      {
        id: '721e0e4f-6874-4db9-9bd6-a951308290d9',
        name: 'Design review',
        mimeType: 'video/webm',
        duration: 487_000,
        size: 41_838_182,
        createdAt: Date.now() - 24 * 60 * 60 * 1000,
        status: 'saved',
      },
      {
        id: 'efd03f9a-6a49-4704-987e-ad2f80aab521',
        name: 'Bug reproduction',
        mimeType: 'video/webm',
        duration: 74_000,
        size: 8_178_893,
        createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
        status: 'saved',
      },
    ];

    const image = new Image();
    image.src = poster;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 800;
    const drawing = canvas.getContext('2d');
    drawing.drawImage(image, 0, 0, canvas.width, canvas.height);

    const stream = canvas.captureStream(4);
    const preferredType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: preferredType });
    const videoChunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) videoChunks.push(event.data);
    });
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve));
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
    await new Promise((resolve) => setTimeout(resolve, 500));
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const previewVideo = new Blob(videoChunks, { type: preferredType });

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('CaptureCastDB', 3);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    await new Promise((resolve, reject) => {
      const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
      const recordingStore = tx.objectStore('recordings');
      records.forEach((record) => recordingStore.put(record));
      tx.objectStore('chunks').put({
        recordingId: records[0].id,
        index: 0,
        chunk: previewVideo,
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, posterUrl);
}

async function captureExtensionUi(context, extensionId) {
  const popupPage = await context.newPage();
  await popupPage.setViewportSize({ width: 420, height: 440 });
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.getByLabel('Include microphone audio').check();
  await popupPage.getByLabel('Best quality').check();
  const popup = await popupPage.locator('body').screenshot({ type: 'png' });
  await popupPage.close();

  const consentPage = await context.newPage();
  await consentPage.setViewportSize({ width: 520, height: 620 });
  await consentPage.goto(
    `chrome-extension://${extensionId}/consent.html?mode=screen&mic=true&sys=true&best=true`
  );
  await consentPage.locator('#capture-list li').first().waitFor();
  const consent = await consentPage.locator('.card').screenshot({ type: 'png' });
  await consentPage.close();

  const overlayPage = await context.newPage();
  await overlayPage.setViewportSize({ width: 1280, height: 800 });
  await overlayPage.goto(`data:text/html;charset=utf-8,${encodeURIComponent(demoPage())}`);
  await overlayPage.evaluate(() => {
    const listeners = [];
    globalThis.chrome.runtime = {
      sendMessage: async () => ({ status: 'recording', ok: true }),
      onMessage: { addListener: (listener) => listeners.push(listener) },
    };
  });
  await overlayPage.addScriptTag({ path: overlayBundlePath });
  await overlayPage.locator('#cc-overlay').waitFor();
  const overlay = await overlayPage.screenshot({ type: 'png' });
  await overlayPage.close();

  const galleryPage = await context.newPage();
  await galleryPage.setViewportSize({ width: 1080, height: 650 });
  await galleryPage.goto(`chrome-extension://${extensionId}/recordings.html`);
  await galleryPage.locator('#list').waitFor();
  await seedGallery(galleryPage, dataUrl(overlay));
  await galleryPage.reload();
  await galleryPage.getByText('Product walkthrough').waitFor();
  const gallery = await galleryPage.screenshot({ type: 'png' });

  const previewPage = await context.newPage();
  await previewPage.setViewportSize({ width: 1080, height: 690 });
  const previewId = '3b77b5df-55a7-4dc5-99df-e998bb85b312';
  await previewPage.goto(`chrome-extension://${extensionId}/preview.html?id=${previewId}`);
  await previewPage.locator('#video').waitFor({ state: 'attached' });
  await previewPage.addStyleTag({ content: 'video { height: 390px; object-fit: contain; }' });
  await previewPage.evaluate((poster) => {
    const video = document.querySelector('video');
    const filename = document.querySelector('#filename-input');
    if (video) {
      video.pause();
      video.poster = poster;
      video.dataset.stable = 'true';
    }
    if (filename) filename.value = 'Product walkthrough';
  }, dataUrl(overlay));
  await previewPage.waitForTimeout(1500);
  const preview = await previewPage.screenshot({ type: 'png' });

  await previewPage.close();
  await galleryPage.close();

  return { popup, consent, overlay, preview, gallery };
}

async function main() {
  await mkdir(screenshotDir, { recursive: true });

  await readFile(overlayBundlePath);
  const icon = await readFile(iconPath);
  const iconUrl = dataUrl(icon);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'screensilo-store-assets-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${projectRoot}`,
      `--load-extension=${projectRoot}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const extensionId = await waitForExtensionId(context);
    const captures = await captureExtensionUi(context, extensionId);

    await renderPage(context, {
      width: 1280,
      height: 800,
      outputPath: path.join(screenshotDir, '01-choose-and-confirm.png'),
      content: choiceScreenshot({
        iconUrl,
        popupUrl: dataUrl(captures.popup),
        consentUrl: dataUrl(captures.consent),
      }),
    });

    await renderPage(context, {
      width: 1280,
      height: 800,
      outputPath: path.join(screenshotDir, '02-stop-overlay.png'),
      content: framedScreenshot({
        iconUrl,
        eyebrow: 'Stay in control',
        title: 'Stop without breaking your flow.',
        description: 'A compact on-page control keeps the finish line one click away.',
        imageUrl: dataUrl(captures.overlay),
        objectFit: 'cover',
      }),
    });

    await renderPage(context, {
      width: 1280,
      height: 800,
      outputPath: path.join(screenshotDir, '03-preview-and-download.png'),
      content: framedScreenshot({
        iconUrl,
        eyebrow: 'Instant preview',
        title: 'Review, name, and download locally.',
        description: 'Your recording is ready without an upload step or an account.',
        imageUrl: dataUrl(captures.preview),
      }),
    });

    await renderPage(context, {
      width: 1280,
      height: 800,
      outputPath: path.join(screenshotDir, '04-local-library.png'),
      content: framedScreenshot({
        iconUrl,
        eyebrow: 'On-device library',
        title: 'Your recordings stay yours.',
        description: 'Reopen or delete saved captures from a simple local library.',
        imageUrl: dataUrl(captures.gallery),
      }),
    });

    await renderPage(context, {
      width: 300,
      height: 300,
      outputPath: path.join(outputDir, 'screensilo-logo-300.png'),
      content: htmlDocument(
        `<main><div class="halo"></div><img src="${iconUrl}" alt=""></main>`,
        `main { position: relative; display: grid; place-items: center; width: 100%; height: 100%; background: linear-gradient(145deg, #f8f9fd, #edf3fb); overflow: hidden; }
         .halo { position: absolute; width: 224px; height: 224px; border-radius: 50%; background: linear-gradient(145deg, rgba(115,119,216,.22), rgba(36,149,208,.2)); }
         img { position: relative; width: 218px; height: 218px; border-radius: 34px; box-shadow: 0 18px 42px rgba(25,39,78,.16); }`
      ),
    });

    await renderPage(context, {
      width: 440,
      height: 280,
      outputPath: path.join(outputDir, 'screensilo-promo-440x280.png'),
      content: htmlDocument(
        `<main><div class="orb"></div><img src="${iconUrl}" alt=""><section><small>PRIVATE SCREEN RECORDER</small><h1>ScreenSilo</h1><p>Record locally.<br>Share on your terms.</p><span><i></i> No account · No cloud</span></section></main>`,
        `main { position: relative; width: 100%; height: 100%; display: flex; align-items: center; gap: 23px; padding: 31px; background: linear-gradient(145deg, #f9fafc, #eaf2fb); overflow: hidden; }
         .orb { position: absolute; width: 240px; height: 240px; right: -90px; top: -110px; border-radius: 50%; background: rgba(115,119,216,.17); }
         img { position: relative; width: 128px; height: 128px; border-radius: 24px; box-shadow: 0 18px 38px rgba(28,40,79,.16); }
         section { position: relative; min-width: 0; }
         small { color: ${palette.blueDark}; font-size: 9px; font-weight: 850; letter-spacing: 1.2px; }
         h1 { margin: 5px 0 3px; font-size: 31px; line-height: 1; letter-spacing: -1.2px; }
         p { margin: 0; color: #555c76; font-size: 17px; line-height: 1.3; font-weight: 570; }
         span { display: flex; align-items: center; gap: 7px; margin-top: 14px; color: #39725f; font-size: 11px; font-weight: 750; }
         span i { width: 7px; height: 7px; border-radius: 50%; background: #2aa876; }`
      ),
    });

    await renderPage(context, {
      width: 1400,
      height: 560,
      outputPath: path.join(outputDir, 'screensilo-marquee-1400x560.png'),
      content: htmlDocument(
        `<main><div class="orb one"></div><div class="orb two"></div><section class="copy"><div class="brandline"><img src="${iconUrl}" alt=""><b>ScreenSilo</b></div><small>PRIVATE · LOCAL · LIGHTWEIGHT</small><h1>Screen recording<br>that stays with you.</h1><p>Capture a tab, window, or screen. Preview and download without an account, upload, tracker, or watermark.</p><div class="badges"><span><i></i> On-device</span><span>No sign-in</span><span>No cloud</span></div></section><section class="visual"><div class="window"><div class="bar"><i></i><i></i><i></i></div><div class="screen"><img src="${iconUrl}" alt=""><strong>Ready to record</strong><span>Choose what to capture, then keep complete control.</span><button><b></b> Start recording</button></div></div></section></main>`,
        `main { position: relative; width: 100%; height: 100%; display: grid; grid-template-columns: 1.04fr .96fr; background: linear-gradient(140deg, #f9fafc 0%, #e9f2fb 100%); overflow: hidden; }
         .orb { position: absolute; border-radius: 50%; } .one { width: 520px; height: 520px; right: -180px; top: -250px; background: rgba(115,119,216,.17); } .two { width: 380px; height: 380px; left: -230px; bottom: -250px; background: rgba(36,149,208,.14); }
         .copy { position: relative; padding: 60px 28px 48px 90px; }
         .brandline { display: flex; align-items: center; gap: 14px; margin-bottom: 34px; font-size: 25px; }
         .brandline img { width: 54px; height: 54px; border-radius: 13px; box-shadow: 0 9px 24px rgba(29,44,84,.13); }
         small { color: ${palette.blueDark}; font-size: 12px; font-weight: 850; letter-spacing: 2px; }
         h1 { margin: 10px 0 14px; font-size: 54px; line-height: 1.02; letter-spacing: -2.3px; }
         .copy > p { max-width: 590px; margin: 0; color: #5e647d; font-size: 18px; line-height: 1.52; }
         .badges { display: flex; gap: 9px; margin-top: 27px; }
         .badges span { display: flex; align-items: center; gap: 7px; color: #4b526a; background: rgba(255,255,255,.72); border: 1px solid rgba(85,95,139,.14); border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 720; }
         .badges i { width: 7px; height: 7px; background: #2aa876; border-radius: 50%; }
         .visual { position: relative; display: flex; align-items: center; padding: 58px 64px 58px 18px; }
         .window { width: 100%; height: 408px; background: white; border: 1px solid rgba(57,66,109,.15); border-radius: 22px; overflow: hidden; transform: rotate(-1.2deg); box-shadow: 0 38px 85px rgba(34,45,85,.2); }
         .bar { height: 48px; padding: 20px; display: flex; gap: 7px; background: #f3f4f7; border-bottom: 1px solid #e4e6ec; }
         .bar i { width: 9px; height: 9px; border-radius: 50%; background: #c7cad4; } .bar i:first-child { background: #ef8178; } .bar i:nth-child(2) { background: #e8bd58; } .bar i:last-child { background: #65be7d; }
         .screen { height: calc(100% - 48px); display: flex; flex-direction: column; align-items: center; justify-content: center; background: radial-gradient(circle at 50% 10%, #f5f8ff, #fff 58%); }
         .screen img { width: 96px; height: 96px; border-radius: 19px; box-shadow: 0 16px 30px rgba(29,44,84,.13); }
         .screen strong { margin-top: 19px; font-size: 24px; letter-spacing: -.6px; }
         .screen span { margin-top: 6px; color: #73788d; font-size: 13px; }
         button { margin-top: 24px; padding: 12px 20px; color: white; background: ${palette.blueDark}; border: 0; border-radius: 10px; font: 700 13px inherit; box-shadow: 0 10px 22px rgba(28,111,168,.2); }
         button b { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: white; }`
      ),
    });
  } finally {
    await context.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true });
  }

  console.log(`Generated store assets in ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
