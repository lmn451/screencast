(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // db-shared.js
  var DB_NAME, DB_VERSION, STORE_RECORDINGS, STORE_CHUNKS;
  var init_db_shared = __esm({
    "db-shared.js"() {
      DB_NAME = "CaptureCastDB";
      DB_VERSION = 3;
      STORE_RECORDINGS = "recordings";
      STORE_CHUNKS = "chunks";
    }
  });

  // chunkStorage.js
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const chunkStore = db.createObjectStore(STORE_CHUNKS, {
            keyPath: ["recordingId", "index"]
          });
          chunkStore.createIndex("recordingId", "recordingId", { unique: false });
        }
        if (!db.objectStoreNames.contains("recordings")) {
          db.createObjectStore("recordings", { keyPath: "id" });
        }
      };
    });
  }
  async function saveChunk(recordingId, chunk, index) {
    let db;
    try {
      db = await openDB();
    } catch (e) {
      throw new Error(
        "[DB] Failed to open database for saveChunk: " + (e && e.message ? e.message : e)
      );
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, "readwrite");
      const store = tx.objectStore(STORE_CHUNKS);
      const request = store.put({ recordingId, index, chunk });
      const cleanup = () => {
        try {
          db.close();
        } catch {
        }
      };
      request.onsuccess = () => {
        try {
          resolve();
        } finally {
          cleanup();
        }
      };
      request.onerror = () => {
        cleanup();
        reject(request.error);
      };
      tx.oncomplete = cleanup;
      tx.onerror = cleanup;
    });
  }
  var init_chunkStorage = __esm({
    "chunkStorage.js"() {
      init_db_shared();
    }
  });

  // recording.js
  function isValidUUID(str) {
    return typeof str === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
  function validateId(id) {
    if (!isValidUUID(id)) {
      throw new Error("Invalid recording ID format");
    }
  }
  function openDB2() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
          db.createObjectStore(STORE_RECORDINGS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const chunkStore = db.createObjectStore(STORE_CHUNKS, {
            keyPath: ["recordingId", "index"]
          });
          chunkStore.createIndex("recordingId", "recordingId", { unique: false });
        }
      };
    });
  }
  async function finishRecording(id, mimeType, duration, size) {
    validateId(id);
    let db;
    try {
      db = await openDB2();
    } catch (e) {
      throw new Error(
        "[DB] Failed to open database for finishRecording: " + (e && e.message ? e.message : e)
      );
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECORDINGS, "readwrite");
      const store = tx.objectStore(STORE_RECORDINGS);
      const request = store.put({
        id,
        mimeType,
        duration,
        size,
        createdAt: Date.now(),
        name: null
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }
  async function updateRecordingName(id, name) {
    validateId(id);
    let db;
    try {
      db = await openDB2();
    } catch (e) {
      return Promise.reject(
        new Error(
          "[DB] Failed to open database for updateRecordingName: " + (e && e.message ? e.message : e)
        )
      );
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECORDINGS, "readwrite");
      const store = tx.objectStore(STORE_RECORDINGS);
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const recording = getRequest.result;
        if (recording) {
          recording.name = name;
          const putRequest = store.put(recording);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          reject(new Error("Recording not found"));
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }
  async function getRecording(id) {
    validateId(id);
    let db;
    try {
      db = await openDB2();
    } catch (e) {
      throw new Error(
        "[DB] Failed to open database for getRecording: " + (e && e.message ? e.message : e)
      );
    }
    const meta = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECORDINGS, "readonly");
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!meta) {
      db.close();
      return null;
    }
    const chunks = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, "readonly");
      const store = tx.objectStore(STORE_CHUNKS);
      const index = store.index("recordingId");
      const req = index.getAll(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const results = req.result;
        results.sort((a, b) => a.index - b.index);
        resolve(results.map((r) => r.chunk));
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    const blob = new Blob(chunks, { type: meta.mimeType });
    return {
      id,
      blob,
      mimeType: meta.mimeType,
      createdAt: meta.createdAt,
      duration: meta.duration,
      size: meta.size,
      name: meta.name
    };
  }
  async function getAllRecordings() {
    let db;
    try {
      db = await openDB2();
    } catch (e) {
      return Promise.reject(
        new Error(
          "[DB] Failed to open database for getAllRecordings: " + (e && e.message ? e.message : e)
        )
      );
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_RECORDINGS, "readonly");
      const store = tx.objectStore(STORE_RECORDINGS);
      const request = store.getAll();
      request.onsuccess = () => {
        const results = request.result;
        results.sort((a, b) => b.createdAt - a.createdAt);
        resolve(results);
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }
  var init_recording = __esm({
    "recording.js"() {
      init_db_shared();
    }
  });

  // cleanup.js
  function openDB3() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
          db.createObjectStore(STORE_RECORDINGS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const chunkStore = db.createObjectStore(STORE_CHUNKS, {
            keyPath: ["recordingId", "index"]
          });
          chunkStore.createIndex("recordingId", "recordingId", { unique: false });
        }
      };
    });
  }
  async function deleteRecording(id) {
    const db = await openDB3();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], "readwrite");
      tx.objectStore(STORE_RECORDINGS).delete(id);
      const chunkStore = tx.objectStore(STORE_CHUNKS);
      const index = chunkStore.index("recordingId");
      const req = index.openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          chunkStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  async function cleanupOldRecordings(maxAgeMs = 24 * 60 * 60 * 1e3) {
    const db = await openDB3();
    const cutoff = Date.now() - maxAgeMs;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], "readwrite");
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.openCursor();
      const idsToDelete = [];
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          if (cursor.value.createdAt < cutoff) {
            idsToDelete.push(cursor.value.id);
            cursor.delete();
          }
          cursor.continue();
        } else {
          if (idsToDelete.length === 0) return;
          const chunkStore = tx.objectStore(STORE_CHUNKS);
          const chunkIndex = chunkStore.index("recordingId");
          const deleteNext = (index) => {
            if (index >= idsToDelete.length) return;
            const id = idsToDelete[index];
            const chunkReq = chunkIndex.openKeyCursor(IDBKeyRange.only(id));
            chunkReq.onsuccess = (e) => {
              const c = e.target.result;
              if (c) {
                chunkStore.delete(c.primaryKey);
                c.continue();
              } else {
                deleteNext(index + 1);
              }
            };
            chunkReq.onerror = () => {
              logger.warn("Failed to delete chunks for recording:", id);
              deleteNext(index + 1);
            };
          };
          deleteNext(0);
        }
      };
      tx.oncomplete = () => {
        db.close();
        if (idsToDelete.length > 0) {
          console.log(`[CaptureCast DB] Cleanup: Deleted ${idsToDelete.length} old recordings`);
        }
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  var init_cleanup = __esm({
    "cleanup.js"() {
      init_db_shared();
    }
  });

  // db.js
  var db_exports = {};
  __export(db_exports, {
    DB_NAME: () => DB_NAME,
    DB_VERSION: () => DB_VERSION,
    STORE_CHUNKS: () => STORE_CHUNKS,
    STORE_RECORDINGS: () => STORE_RECORDINGS,
    cleanupOldRecordings: () => cleanupOldRecordings,
    deleteRecording: () => deleteRecording,
    finishRecording: () => finishRecording,
    getAllRecordings: () => getAllRecordings,
    getRecording: () => getRecording,
    saveChunk: () => saveChunk,
    updateRecordingName: () => updateRecordingName
  });
  var init_db = __esm({
    "db.js"() {
      init_db_shared();
      init_chunkStorage();
      init_recording();
      init_cleanup();
    }
  });

  // background.js
  init_db();

  // logger.js
  var isDev = typeof chrome !== "undefined" && chrome.runtime?.getManifest?.()?.content_security_policy?.includes("unsafe-eval") === true;
  var DEBUG = isDev || new URLSearchParams(globalThis.location?.search).get("debug") === "1";
  var log = DEBUG ? console.log.bind(console) : () => {
  };
  var warn = console.warn.bind(console);
  var error = console.error.bind(console);
  function createLogger(component) {
    return {
      log: (...args) => log(`[${component}]`, ...args),
      warn: (...args) => warn(`[${component}]`, ...args),
      error: (...args) => error(`[${component}]`, ...args)
    };
  }

  // constants.js
  var STOP_TIMEOUT_MS = 6e4;
  var AUTO_DELETE_AGE_MS = 24 * 60 * 60 * 1e3;
  var CHUNK_INTERVAL_MS = 1e3;
  var SEEK_POSITION_LARGE = Number.MAX_SAFE_INTEGER / 2;

  // storage-utils.js
  var logger2 = createLogger("StorageUtils");
  var MIN_FREE_SPACE_BYTES = 100 * 1024 * 1024;
  var ESTIMATED_BYTES_PER_MINUTE = 20 * 1024 * 1024;
  async function checkStorageQuota() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) {
        logger2.warn("StorageManager API not available, cannot check quota");
        return { ok: true };
      }
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;
      const available = quota - usage;
      logger2.log("Storage quota check:", {
        usage: `${(usage / 1024 / 1024).toFixed(1)} MB`,
        quota: `${(quota / 1024 / 1024).toFixed(1)} MB`,
        available: `${(available / 1024 / 1024).toFixed(1)} MB`,
        usagePercent: `${(usage / quota * 100).toFixed(1)}%`
      });
      if (available < MIN_FREE_SPACE_BYTES) {
        const availableMB = (available / 1024 / 1024).toFixed(1);
        const requiredMB = (MIN_FREE_SPACE_BYTES / 1024 / 1024).toFixed(1);
        return {
          ok: false,
          usage,
          quota,
          available,
          error: `Insufficient storage space. Available: ${availableMB} MB, Required: ${requiredMB} MB. Please delete old recordings or free up space.`
        };
      }
      return { ok: true, usage, quota, available };
    } catch (e) {
      logger2.error("Failed to check storage quota:", e);
      return { ok: true, error: "Could not check storage quota: " + e.message };
    }
  }

  // background.js
  var logger3 = createLogger("Background");
  function initBackground() {
    globalThis.addEventListener("unhandledrejection", (event) => {
      logger3.error("Unhandled Rejection:", event.reason);
    });
    globalThis.addEventListener("error", (event) => {
      logger3.error("Uncaught Exception:", event.error || event.message);
    });
    const STATE = {
      status: "IDLE",
      backend: null,
      mode: null,
      recordingId: null,
      overlayTabId: null,
      includeMic: false,
      includeSystemAudio: false,
      recorderTabId: null,
      strategy: null,
      stopTimeoutId: null,
      isAutomation: false,
      cdpTabId: null,
      cdpPort: null
    };
    async function updateBadge() {
      try {
        let color = "#00000000";
        let text = "";
        if (STATE.status === "RECORDING") {
          color = "#d93025";
          text = "REC";
        } else if (STATE.status === "SAVING") {
          color = "#f9ab00";
          text = "SAVE";
        }
        if (chrome.browserAction) {
          await chrome.browserAction.setBadgeBackgroundColor({ color });
          await chrome.browserAction.setBadgeText({ text });
        } else {
          await chrome.action.setBadgeBackgroundColor({ color });
          await chrome.action.setBadgeText({ text });
        }
      } catch (e) {
      }
    }
    function canUseOffscreen() {
      return !!(chrome.offscreen && chrome.offscreen.createDocument);
    }
    async function hasOffscreenDocument() {
      return await chrome.offscreen.hasDocument?.();
    }
    async function ensureOffscreenDocument() {
      if (!canUseOffscreen()) {
        throw new Error("Offscreen API is not available");
      }
      const existing = await hasOffscreenDocument();
      if (existing) return;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL("offscreen.html"),
        reasons: ["USER_MEDIA", "BLOBS"],
        justification: "Record a screen capture stream using MediaRecorder in an offscreen document."
      });
    }
    async function closeOffscreenDocumentIfIdle() {
      try {
        if (!canUseOffscreen()) return;
        const existing = await hasOffscreenDocument();
        if (existing && STATE.status === "IDLE") {
          await chrome.offscreen.closeDocument?.();
        }
      } catch (e) {
        logger3.warn("Failed to close offscreen document:", e);
      }
    }
    async function injectOverlay(tabId) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["overlay.js"]
        });
        return true;
      } catch (e) {
        logger3.log("Overlay injection failed (may be restricted page):", e.message);
        return false;
      }
    }
    async function removeOverlay(tabId) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const el = document.getElementById("cc-overlay");
            if (el) el.remove();
          }
        });
      } catch (e) {
      }
    }
    async function getActiveTabId() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    }
    async function focusTab(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.windowId) {
          try {
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch (e) {
          }
        }
        await chrome.tabs.update(tabId, { active: true });
      } catch (e) {
      }
    }
    async function startCDPScreencast(tabId, mode, includeMic, includeSystemAudio, options = {}) {
      if (STATE.status !== "IDLE") {
        return { ok: false, error: "Already recording or saving" };
      }
      const storageCheck = await checkStorageQuota();
      if (!storageCheck.ok) {
        return { ok: false, error: storageCheck.error };
      }
      STATE.backend = "cdpScreencast";
      STATE.mode = mode || "tab";
      STATE.recordingId = crypto.randomUUID();
      STATE.overlayTabId = options.targetTabId || tabId || await getActiveTabId();
      STATE.includeMic = !!includeMic;
      STATE.includeSystemAudio = !!includeSystemAudio;
      STATE.isAutomation = !!options.automation;
      STATE.cdpTabId = STATE.overlayTabId;
      if (canUseOffscreen()) {
        await ensureOffscreenDocument();
        const cdpPort = chrome.runtime.connect(void 0, { name: "cdpScreencast" });
        STATE.cdpPort = cdpPort;
        cdpPort.onMessage.addListener((msg) => {
          if (msg.type === "CDP_ERROR") {
            logger3.error("CDP backend error:", msg.error);
          }
        });
        cdpPort.onDisconnect.addListener(() => {
          logger3.log("CDP port disconnected");
          STATE.cdpPort = null;
          if (STATE.status === "RECORDING") {
            stopRecording();
          }
        });
        cdpPort.postMessage({
          type: "CDP_START",
          tabId: STATE.cdpTabId,
          recordingId: STATE.recordingId,
          mode: STATE.mode,
          includeAudio: STATE.includeSystemAudio || STATE.includeMic
        });
      } else {
        logger3.log("Starting CDP screencast without offscreen (background mode)");
        await startCDPBackgroundCapture(STATE.cdpTabId, STATE.recordingId);
      }
      let overlayInjected = false;
      if (STATE.overlayTabId) {
        overlayInjected = await injectOverlay(STATE.overlayTabId);
      }
      STATE.status = "RECORDING";
      await updateBadge();
      return { ok: true, overlayInjected, backend: "cdpScreencast" };
    }
    let cdpSession = null;
    let cdpCanvas = null;
    let cdpCtx = null;
    let cdpStream = null;
    let cdpRecorder = null;
    let cdpChunkIndex = 0;
    let cdpTotalSize = 0;
    let cdpRecordingStartTime = 0;
    let cdpAckPending = 0;
    let cdpTabIdForCapture = null;
    async function startCDPBackgroundCapture(tabId, recordingId) {
      try {
        cdpTabIdForCapture = tabId;
        logger3.log("Starting CDP background capture for tab:", tabId);
        cdpCanvas = document.createElement("canvas");
        cdpCanvas.width = 1920;
        cdpCanvas.height = 1080;
        cdpCtx = cdpCanvas.getContext("2d");
        cdpStream = cdpCanvas.captureStream(30);
        cdpChunkIndex = 0;
        cdpTotalSize = 0;
        const mimeType = "video/webm;codecs=vp8";
        cdpRecorder = new MediaRecorder(cdpStream, {
          mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : "video/webm"
        });
        cdpRecorder.onstart = () => {
          cdpRecordingStartTime = Date.now();
          logger3.log("CDP Background MediaRecorder started, mimeType:", cdpRecorder.mimeType);
        };
        cdpRecorder.ondataavailable = async (e) => {
          if (e.data && e.data.size > 0) {
            try {
              cdpTotalSize += e.data.size;
              const { saveChunk: saveChunk2 } = await Promise.resolve().then(() => (init_db(), db_exports));
              await saveChunk2(recordingId, e.data, cdpChunkIndex++);
            } catch (err) {
              logger3.error("Failed to save CDP chunk:", err);
            }
          }
        };
        cdpRecorder.onerror = (e) => {
          logger3.error("CDP Background MediaRecorder error:", e);
        };
        cdpRecorder.onstop = async () => {
          const duration = Date.now() - cdpRecordingStartTime;
          logger3.log(`CDP Background MediaRecorder stopped after ${duration}ms`);
          try {
            const { finishRecording: fin } = await Promise.resolve().then(() => (init_db(), db_exports));
            await fin(recordingId, cdpRecorder.mimeType || "video/webm", duration, cdpTotalSize);
            await chrome.runtime.sendMessage({
              type: "CDP_FINISHED",
              recordingId
            });
          } catch (e) {
            logger3.error("Failed to finish CDP background recording:", e);
          } finally {
            cleanupCDPBackground();
          }
        };
        cdpRecorder.start(CHUNK_INTERVAL_MS);
        logger3.log("CDP background capture recorder started");
        try {
          cdpSession = await chrome.debugger.attach({ tabId }, "1.3");
          chrome.debugger.onEvent.addListener(onCDPEvent);
          chrome.debugger.onDetach.addListener(onCDPDetach);
          await chrome.debugger.sendCommand({ tabId }, "Page.enable");
          await chrome.debugger.sendCommand({ tabId }, "Page.startScreencast", {
            format: "jpeg",
            quality: 80,
            maxWidth: 1920,
            maxHeight: 1080,
            everyNthFrame: 1
          });
          logger3.log("CDP screencast started");
        } catch (e) {
          logger3.error("Failed to start CDP debugger:", e);
          cleanupCDPBackground();
          throw e;
        }
      } catch (e) {
        logger3.error("CDP background capture failed:", e);
        cleanupCDPBackground();
        throw e;
      }
    }
    function onCDPEvent(source, method, params) {
      if (method === "Page.screencastFrame") {
        paintCDPFrameFromBase64(params.data);
        chrome.debugger.sendCommand(source, "Page.screencastFrameAck", {
          sessionId: params.sessionId
        }).catch((e) => logger3.warn("Frame ack failed:", e.message));
      }
    }
    function onCDPDetach(source, reason) {
      logger3.log("CDP debugger detached:", reason);
      if (STATE.status === "RECORDING" && STATE.backend === "cdpScreencast") {
        stopRecording();
      }
      cleanupCDPBackground();
    }
    function paintCDPFrameFromBase64(data) {
      if (!cdpCtx || !cdpCanvas) {
        logger3.warn("No canvas context to paint frame");
        return;
      }
      try {
        const img = new Image();
        img.onload = () => {
          if (cdpCanvas.width !== img.width || cdpCanvas.height !== img.height) {
            cdpCanvas.width = img.width;
            cdpCanvas.height = img.height;
          }
          cdpCtx.drawImage(img, 0, 0);
        };
        img.src = "data:image/jpeg;base64," + data;
      } catch (e) {
        logger3.error("Failed to paint CDP frame:", e);
      }
    }
    function cleanupCDPBackground() {
      if (cdpSession) {
        try {
          chrome.debugger.detach(cdpSession);
        } catch (e) {
          logger3.log("Error detaching CDP debugger:", e);
        }
        cdpSession = null;
      }
      if (cdpRecorder && cdpRecorder.state !== "inactive") {
        try {
          cdpRecorder.stream?.getTracks().forEach((t) => t.stop());
        } catch (e) {
          logger3.log("Error stopping CDP recorder stream:", e);
        }
      }
      if (cdpStream) {
        try {
          cdpStream.getTracks().forEach((t) => t.stop());
        } catch (e) {
          logger3.log("Error stopping CDP stream:", e);
        }
      }
      cdpStream = null;
      cdpRecorder = null;
      cdpCanvas = null;
      cdpCtx = null;
      cdpTabIdForCapture = null;
    }
    function stopCDPBackgroundCapture() {
      if (cdpRecorder && cdpRecorder.state !== "inactive") {
        logger3.log("Stopping CDP Background MediaRecorder, current state:", cdpRecorder.state);
        if (cdpRecorder.state === "recording") {
          cdpRecorder.requestData();
        }
        cdpRecorder.stop();
      }
    }
    async function startTabCapture(tabId, mode, includeMic, includeSystemAudio, options = {}) {
      if (STATE.status !== "IDLE") {
        return { ok: false, error: "Already recording or saving" };
      }
      const storageCheck = await checkStorageQuota();
      if (!storageCheck.ok) {
        return { ok: false, error: storageCheck.error };
      }
      STATE.backend = "tabCapture";
      STATE.mode = mode || "tab";
      STATE.recordingId = crypto.randomUUID();
      STATE.overlayTabId = options.targetTabId || tabId || await getActiveTabId();
      STATE.includeMic = !!includeMic;
      STATE.includeSystemAudio = !!includeSystemAudio;
      STATE.isAutomation = !!options.automation;
      const useOffscreen = !STATE.includeMic && canUseOffscreen();
      if (useOffscreen) {
        await ensureOffscreenDocument();
        let streamId = options.streamId || null;
        if (!streamId && STATE.overlayTabId) {
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({
              targetTabId: STATE.overlayTabId
            });
            logger3.log("Got streamId for tabCapture");
          } catch (e) {
            logger3.warn("Failed to get streamId:", e.message);
          }
        }
        await chrome.runtime.sendMessage({
          type: "OFFSCREEN_START",
          mode: STATE.mode,
          includeAudio: STATE.includeSystemAudio,
          recordingId: STATE.recordingId,
          targetTabId: STATE.overlayTabId,
          streamId
        });
        STATE.strategy = "offscreen";
      } else {
        let streamId = options.streamId || null;
        if (!streamId && STATE.overlayTabId) {
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({
              targetTabId: STATE.overlayTabId
            });
          } catch (e) {
            logger3.warn("Failed to get streamId:", e.message);
          }
        }
        const url = chrome.runtime.getURL(
          `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
            STATE.mode
          )}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}${streamId ? "&streamId=" + encodeURIComponent(streamId) : ""}`
        );
        const tab = await chrome.tabs.create({ url, active: true });
        STATE.recorderTabId = tab.id ?? null;
        STATE.strategy = "page";
      }
      let overlayInjected = false;
      if (STATE.overlayTabId) {
        overlayInjected = await injectOverlay(STATE.overlayTabId);
      }
      STATE.status = "RECORDING";
      await updateBadge();
      return { ok: true, overlayInjected, backend: "tabCapture" };
    }
    async function startDisplayMedia(tabId, mode, includeMic, includeSystemAudio, options = {}) {
      if (STATE.status !== "IDLE") {
        return { ok: false, error: "Already recording or saving" };
      }
      const storageCheck = await checkStorageQuota();
      if (!storageCheck.ok) {
        return { ok: false, error: storageCheck.error };
      }
      STATE.backend = "displayMedia";
      STATE.mode = mode || "screen";
      STATE.recordingId = crypto.randomUUID();
      STATE.overlayTabId = options.targetTabId || tabId || await getActiveTabId();
      STATE.includeMic = !!includeMic;
      STATE.includeSystemAudio = !!includeSystemAudio;
      STATE.isAutomation = !!options.automation;
      const useOffscreen = !STATE.includeMic && canUseOffscreen();
      if (useOffscreen) {
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({
          type: "OFFSCREEN_START",
          mode: STATE.mode,
          includeAudio: STATE.includeSystemAudio,
          recordingId: STATE.recordingId,
          targetTabId: STATE.overlayTabId,
          streamId: null
        });
        STATE.strategy = "offscreen";
      } else {
        const url = chrome.runtime.getURL(
          `recorder.html?id=${encodeURIComponent(STATE.recordingId)}&mode=${encodeURIComponent(
            STATE.mode
          )}&mic=${STATE.includeMic ? 1 : 0}&sys=${STATE.includeSystemAudio ? 1 : 0}`
        );
        const tab = await chrome.tabs.create({ url, active: true });
        STATE.recorderTabId = tab.id ?? null;
        STATE.strategy = "page";
      }
      let overlayInjected = false;
      if (STATE.overlayTabId) {
        overlayInjected = await injectOverlay(STATE.overlayTabId);
      }
      STATE.status = "RECORDING";
      await updateBadge();
      return { ok: true, overlayInjected, backend: "displayMedia" };
    }
    async function startRecording(mode, includeMic, includeSystemAudio, options = {}) {
      const backend = options.backend || "tabCapture";
      if (backend === "cdpScreencast") {
        return startCDPScreencast(options.targetTabId, mode, includeMic, includeSystemAudio, options);
      } else if (backend === "displayMedia") {
        return startDisplayMedia(options.targetTabId, mode, includeMic, includeSystemAudio, options);
      } else {
        return startTabCapture(options.targetTabId, mode, includeMic, includeSystemAudio, options);
      }
    }
    async function stopRecording() {
      if (STATE.status !== "RECORDING") return { ok: false, error: "Not recording" };
      STATE.status = "SAVING";
      await updateBadge();
      try {
        if (STATE.overlayTabId) {
          try {
            await chrome.tabs.sendMessage(STATE.overlayTabId, { type: "OVERLAY_REMOVE" });
          } catch (e) {
          }
          await removeOverlay(STATE.overlayTabId);
        }
      } catch (e) {
      }
      if (STATE.stopTimeoutId) clearTimeout(STATE.stopTimeoutId);
      STATE.stopTimeoutId = setTimeout(async () => {
        logger3.error(`Save timeout reached (${STOP_TIMEOUT_MS / 1e3}s) - forcing reset`);
        await resetRecordingState();
      }, STOP_TIMEOUT_MS);
      try {
        if (STATE.backend === "cdpScreencast") {
          if (STATE.cdpPort) {
            STATE.cdpPort.postMessage({ type: "CDP_STOP" });
            STATE.cdpPort.disconnect();
            STATE.cdpPort = null;
          } else if (cdpSession) {
            stopCDPBackgroundCapture();
          }
        } else if (STATE.strategy === "page") {
          await chrome.runtime.sendMessage({ type: "RECORDER_STOP" });
        } else {
          await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
        }
      } catch (e) {
        logger3.error("Failed to send stop message:", e);
        return { ok: false, error: "Failed to send stop signal: " + e.message };
      }
      return { ok: true };
    }
    async function resetRecordingState() {
      if (STATE.stopTimeoutId) {
        clearTimeout(STATE.stopTimeoutId);
        STATE.stopTimeoutId = null;
      }
      STATE.status = "IDLE";
      await updateBadge();
      try {
        if (STATE.overlayTabId) {
          await removeOverlay(STATE.overlayTabId);
        }
      } catch (e) {
      }
      try {
        if (STATE.recorderTabId) {
          await chrome.tabs.remove(STATE.recorderTabId);
        }
      } catch (e) {
      }
      if (STATE.cdpPort) {
        try {
          STATE.cdpPort.disconnect();
        } catch (e) {
        }
        STATE.cdpPort = null;
      }
      if (STATE.backend === "cdpScreencast") {
        cleanupCDPBackground();
      }
      STATE.backend = null;
      STATE.mode = null;
      STATE.overlayTabId = null;
      STATE.includeMic = false;
      STATE.includeSystemAudio = false;
      STATE.recorderTabId = null;
      STATE.strategy = null;
      STATE.isAutomation = false;
      STATE.cdpTabId = null;
    }
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) {
        logger3.warn("Ignoring message from unauthorized sender:", sender.id);
        sendResponse({ ok: false, error: "Unauthorized sender" });
        return;
      }
      (async () => {
        try {
          switch (message.type) {
            case "START": {
              const res = await startRecording(message.mode, message.mic, message.systemAudio, {
                streamId: message.streamId || null,
                targetTabId: message.targetTabId || null,
                backend: message.backend || "tabCapture"
              });
              sendResponse(res);
              break;
            }
            case "STOP": {
              const res = await stopRecording();
              sendResponse(res);
              break;
            }
            case "CONTROLLER_START": {
              const res = await startRecording(message.mode, false, false, {
                targetTabId: message.targetTabId || null,
                backend: message.backend || "tabCapture",
                automation: true
              });
              sendResponse(res);
              break;
            }
            case "CONTROLLER_STOP": {
              const res = await stopRecording();
              sendResponse(res);
              break;
            }
            case "CONTROLLER_STATE": {
              sendResponse({
                ...STATE,
                recording: STATE.status === "RECORDING" || STATE.status === "SAVING",
                mic: STATE.includeMic,
                systemAudio: STATE.includeSystemAudio
              });
              break;
            }
            case "OFFSCREEN_STARTED": {
              sendResponse({ ok: true });
              break;
            }
            case "OFFSCREEN_DATA": {
              const { recordingId } = message;
              logger3.log("Received OFFSCREEN_DATA:", { recordingId, isAutomation: STATE.isAutomation });
              await resetRecordingState();
              if (!STATE.isAutomation) {
                const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
                await chrome.tabs.create({ url });
              }
              await closeOffscreenDocumentIfIdle();
              sendResponse({ ok: true });
              break;
            }
            case "RECORDER_DATA": {
              const { recordingId } = message;
              logger3.log("Received RECORDER_DATA:", { recordingId, isAutomation: STATE.isAutomation });
              await resetRecordingState();
              if (!STATE.isAutomation) {
                const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
                await chrome.tabs.create({ url });
              }
              sendResponse({ ok: true });
              break;
            }
            case "RECORDER_STARTED": {
              if (STATE.overlayTabId) {
                await focusTab(STATE.overlayTabId);
              }
              sendResponse({ ok: true });
              break;
            }
            case "PREVIEW_READY": {
              sendResponse({ ok: true });
              break;
            }
            case "OFFSCREEN_ERROR": {
              logger3.error("Received OFFSCREEN_ERROR:", message.error);
              await resetRecordingState();
              sendResponse({ ok: false, error: message.error });
              break;
            }
            case "GET_STATE": {
              sendResponse({
                ...STATE,
                recording: STATE.status === "RECORDING" || STATE.status === "SAVING",
                mic: STATE.includeMic,
                systemAudio: STATE.includeSystemAudio
              });
              break;
            }
            case "OFFSCREEN_TEST": {
              sendResponse({ ok: true, message: "Test successful" });
              break;
            }
            case "GET_LAST_RECORDING_ID": {
              sendResponse({ ok: true, recordingId: STATE.recordingId });
              break;
            }
            case "CDP_FINISHED": {
              const { recordingId } = message;
              logger3.log("CDP recording finished:", recordingId);
              await resetRecordingState();
              if (!STATE.isAutomation) {
                const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(recordingId)}`);
                await chrome.tabs.create({ url });
              }
              sendResponse({ ok: true });
              break;
            }
            default:
              sendResponse({ ok: false, error: "Unknown message" });
          }
        } catch (e) {
          logger3.error("Error handling message", message.type, e);
          try {
            sendResponse({ ok: false, error: String(e) });
          } catch (e2) {
          }
        }
      })();
      return true;
    });
    chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
      logger3.log("External message received:", message.type, "from:", sender.id);
      const allowedIds = [];
      if (allowedIds.length > 0 && !allowedIds.includes(sender.id)) {
        logger3.warn("Ignoring external message from unauthorized sender:", sender.id);
        return;
      }
      (async () => {
        try {
          switch (message.type) {
            case "START": {
              const res = await startRecording(message.mode, message.mic, message.systemAudio, {
                backend: message.backend || "tabCapture",
                automation: true
              });
              sendResponse(res);
              break;
            }
            case "STOP": {
              const res = await stopRecording();
              sendResponse(res);
              break;
            }
            case "GET_LAST_RECORDING_ID": {
              sendResponse({ ok: true, recordingId: STATE.recordingId });
              break;
            }
            case "GET_STATE": {
              sendResponse({
                ...STATE,
                recording: STATE.status === "RECORDING" || STATE.status === "SAVING",
                mic: STATE.includeMic,
                systemAudio: STATE.includeSystemAudio
              });
              break;
            }
            default:
              sendResponse({ ok: false, error: "Unknown message type" });
          }
        } catch (e) {
          logger3.error("Error handling external message", message.type, e);
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    });
    chrome.runtime.onInstalled.addListener(async () => {
      await updateBadge();
      try {
        await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
      } catch (e) {
        logger3.error("Cleanup failed:", e);
      }
    });
    chrome.runtime.onStartup.addListener(async () => {
      try {
        await cleanupOldRecordings(AUTO_DELETE_AGE_MS);
      } catch (e) {
        logger3.error("Cleanup failed:", e);
      }
    });
    const actionClickHandler = async (tab) => {
      logger3.log("Extension icon clicked on tab:", tab?.id);
      if (STATE.status === "RECORDING") {
        await stopRecording();
      } else if (STATE.status === "IDLE" && tab?.id) {
        STATE.backend = "tabCapture";
        STATE.mode = "tab";
        STATE.recordingId = crypto.randomUUID();
        STATE.overlayTabId = tab.id;
        STATE.includeMic = false;
        STATE.includeSystemAudio = false;
        STATE.isAutomation = false;
        const useOffscreen = canUseOffscreen();
        if (useOffscreen) {
          await ensureOffscreenDocument();
          let streamId = null;
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({
              targetTabId: tab.id
            });
            logger3.log("Got streamId via action.onClicked");
          } catch (e) {
            logger3.warn("Failed to get streamId:", e.message);
          }
          await chrome.runtime.sendMessage({
            type: "OFFSCREEN_START",
            mode: "tab",
            includeAudio: false,
            recordingId: STATE.recordingId,
            targetTabId: tab.id,
            streamId
          });
          STATE.strategy = "offscreen";
        }
        STATE.status = "RECORDING";
        await updateBadge();
        logger3.log("Recording started via action click");
      }
    };
    if (chrome.browserAction) {
      chrome.browserAction.onClicked.addListener(actionClickHandler);
    } else if (chrome.action) {
      chrome.action.onClicked.addListener(actionClickHandler);
    }
  }

  // sw-entry.js
  initBackground();
})();
