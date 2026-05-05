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
      const cleanup2 = () => {
        try {
          db.close();
        } catch {
        }
      };
      request.onsuccess = () => {
        try {
          resolve();
        } finally {
          cleanup2();
        }
      };
      request.onerror = () => {
        cleanup2();
        reject(request.error);
      };
      tx.oncomplete = cleanup2;
      tx.onerror = cleanup2;
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

  // offscreen.js
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

  // media-recorder-utils.js
  init_db();
  var logger2 = createLogger("MediaRecorderUtils");
  var CHUNK_INTERVAL_MS = 1e3;
  var isCI = typeof process !== "undefined" && process.env?.CI === "true";
  function getOptimalCodec() {
    const codecsForCI = [
      "video/webm;codecs=vp8,opus",
      // Most reliable software codec
      "video/webm;codecs=vp8",
      // VP8 without audio
      "video/webm"
      // Generic fallback
    ];
    const codecsForNormal = [
      "video/webm;codecs=av01,opus",
      // AV1 (best compression, GPU preferred)
      "video/webm;codecs=av1,opus",
      "video/webm;codecs=vp9,opus",
      // VP9 (good compression)
      "video/webm;codecs=vp8,opus",
      // VP8 (reliable fallback)
      "video/webm"
    ];
    const codecs = isCI ? codecsForCI : codecsForNormal;
    for (const codec of codecs) {
      if (MediaRecorder.isTypeSupported(codec)) {
        logger2.log("Selected codec:", codec, isCI ? "(CI mode - software encoding)" : "");
        return codec;
      }
    }
    throw new Error("No supported video codec found. Your browser may not support video recording.");
  }
  function createMediaRecorder(stream, recordingId, callbacks = {}) {
    const { onStart, onStop, onError } = callbacks;
    const mimeType = getOptimalCodec();
    const recorder = new MediaRecorder(stream, { mimeType });
    let chunkIndex = 0;
    let totalSize = 0;
    let recordingStartTime = 0;
    recorder.onstart = () => {
      recordingStartTime = Date.now();
      logger2.log("MediaRecorder started, mimeType:", recorder.mimeType);
      onStart?.();
    };
    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        try {
          totalSize += e.data.size;
          await saveChunk(recordingId, e.data, chunkIndex++);
        } catch (err) {
          logger2.error("Failed to save chunk:", err);
        }
      }
    };
    recorder.onerror = (e) => {
      logger2.error("MediaRecorder error:", e);
      onError?.(e);
    };
    recorder.onstop = async () => {
      const duration = Date.now() - recordingStartTime;
      logger2.log(
        `MediaRecorder stopped after ${duration}ms. Total chunks: ${chunkIndex}, size: ${totalSize} bytes`
      );
      if (chunkIndex === 0) {
        logger2.warn("No chunks recorded! Recording may have been too short.");
      }
      const finalMimeType = recorder.mimeType || "video/webm";
      await onStop?.(finalMimeType, duration, totalSize);
    };
    return {
      recorder,
      getStats: () => ({ chunkIndex, totalSize, duration: Date.now() - recordingStartTime })
    };
  }
  function setupAutoStop(stream, recorder) {
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        logger2.log("Video track ended, auto-stopping recorder");
        if (recorder && recorder.state !== "inactive") {
          if (recorder.state === "recording") {
            recorder.requestData();
          }
          recorder.stop();
        }
      });
    });
  }

  // offscreen.js
  var logger3 = createLogger("Offscreen");
  globalThis.addEventListener("unhandledrejection", (event) => {
    logger3.error("Unhandled Rejection:", event.reason);
  });
  globalThis.addEventListener("error", (event) => {
    logger3.error("Uncaught Exception:", event.error || event.message);
  });
  logger3.log("Offscreen document loaded");
  var mediaStream = null;
  var mediaRecorder = null;
  var currentId = null;
  var canvas = null;
  var ctx = null;
  var cdpRecordingId = null;
  (async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "OFFSCREEN_TEST" });
      logger3.log("Test message response:", response);
    } catch (error2) {
      logger3.error("Test message failed:", error2);
    }
    try {
      const request = indexedDB.open("CaptureCastDB", 3);
      request.onerror = () => logger3.error("IndexedDB open failed:", request.error);
      request.onsuccess = () => logger3.log("IndexedDB open success");
    } catch (e) {
      logger3.error("IndexedDB threw error:", e);
    }
  })();
  async function startCapture(mode, recordingId, includeAudio, silent = false, streamId = null) {
    if (mediaRecorder) throw new Error("Already recording");
    currentId = recordingId;
    logger3.log(
      "Starting capture with mode:",
      mode,
      "includeAudio:",
      includeAudio,
      "silent:",
      silent,
      "streamId:",
      streamId ? "provided" : "none"
    );
    let stream;
    try {
      if (silent && streamId) {
        logger3.log("Using tabCapture streamId for capture");
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId
            }
          },
          audio: includeAudio ? {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: streamId
            }
          } : false
        });
        logger3.log("Tab capture via streamId succeeded:", {
          videoTracks: stream.getVideoTracks().length,
          audioTracks: stream.getAudioTracks().length
        });
      } else {
        logger3.log("Using getDisplayMedia (auto-select mode)");
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: includeAudio
        });
        logger3.log("getDisplayMedia succeeded:", {
          videoTracks: stream.getVideoTracks().length,
          audioTracks: stream.getAudioTracks().length
        });
      }
      mediaStream = stream;
    } catch (error2) {
      logger3.error("Capture failed:", error2);
      throw error2;
    }
    const { recorder } = createMediaRecorder(mediaStream, currentId, {
      onStart: () => {
        logger3.log("Recording started");
      },
      onStop: async (mimeType, duration, totalSize) => {
        try {
          await finishRecording(currentId, mimeType, duration, totalSize);
          logger3.log("Finished recording in DB");
          try {
            await chrome.runtime.sendMessage({
              type: "OFFSCREEN_DATA",
              recordingId: currentId,
              mimeType
            });
            logger3.log("OFFSCREEN_DATA response sent");
          } catch (error2) {
            logger3.error("Failed to send OFFSCREEN_DATA:", error2);
          }
        } catch (dbError) {
          logger3.error("Failed to finish recording in DB:", dbError);
          chrome.runtime.sendMessage({
            type: "OFFSCREEN_ERROR",
            error: "Failed to save recording: " + dbError.message
          });
          throw dbError;
        } finally {
          cleanup();
        }
      },
      onError: (e) => {
        logger3.error("MediaRecorder error:", e);
      }
    });
    mediaRecorder = recorder;
    setupAutoStop(mediaStream, mediaRecorder);
    mediaRecorder.start(CHUNK_INTERVAL_MS);
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STARTED" });
  }
  async function startCDPCapture(recordingId, width, height) {
    if (mediaRecorder) throw new Error("Already recording");
    if (canvas) throw new Error("Already has canvas");
    cdpRecordingId = recordingId;
    currentId = recordingId;
    logger3.log("Starting CDP capture:", { recordingId, width, height });
    canvas = document.createElement("canvas");
    canvas.width = width || 1280;
    canvas.height = height || 720;
    ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    mediaStream = stream;
    const mimeType = "video/webm;codecs=vp8";
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : "video/webm"
    });
    let chunkIndex = 0;
    let totalSize = 0;
    let recordingStartTime = 0;
    recorder.onstart = () => {
      recordingStartTime = Date.now();
      logger3.log("CDP MediaRecorder started, mimeType:", recorder.mimeType);
    };
    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        try {
          totalSize += e.data.size;
          const { saveChunk: saveChunk2 } = await Promise.resolve().then(() => (init_db(), db_exports));
          await saveChunk2(recordingId, e.data, chunkIndex++);
        } catch (err) {
          logger3.error("Failed to save chunk:", err);
        }
      }
    };
    recorder.onerror = (e) => {
      logger3.error("CDP MediaRecorder error:", e);
    };
    recorder.onstop = async () => {
      const duration = Date.now() - recordingStartTime;
      logger3.log(`CDP MediaRecorder stopped after ${duration}ms`);
      try {
        const { finishRecording: fin } = await Promise.resolve().then(() => (init_db(), db_exports));
        await fin(cdpRecordingId, recorder.mimeType || "video/webm", duration, totalSize);
        await chrome.runtime.sendMessage({
          type: "CDP_FINISHED",
          recordingId: cdpRecordingId
        });
      } catch (e) {
        logger3.error("Failed to finish CDP recording:", e);
      } finally {
        cleanup();
      }
    };
    mediaRecorder = recorder;
    recorder.start(CHUNK_INTERVAL_MS);
    logger3.log("CDP capture started");
  }
  function paintCDPFrame(data, metadata) {
    if (!ctx || !canvas) {
      logger3.warn("No canvas context to paint frame");
      return;
    }
    try {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = "data:image/jpeg;base64," + data;
      if (metadata?.deviceHeight) {
        canvas.height = metadata.deviceHeight;
        canvas.width = metadata.deviceWidth;
      }
    } catch (e) {
      logger3.error("Failed to paint CDP frame:", e);
    }
  }
  function cleanup() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stream?.getTracks().forEach((t) => t.stop());
      } catch (e) {
        logger3.log("Error stopping recorder stream tracks:", e);
      }
    }
    if (mediaStream) {
      try {
        mediaStream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        logger3.log("Error stopping media stream tracks:", e);
      }
    }
    mediaStream = null;
    mediaRecorder = null;
    currentId = null;
    cdpRecordingId = null;
    canvas = null;
    ctx = null;
  }
  function stopCapture() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      logger3.log("Stopping MediaRecorder, current state:", mediaRecorder.state);
      if (mediaRecorder.state === "recording") {
        mediaRecorder.requestData();
      }
      mediaRecorder.stop();
    }
  }
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "cdpScreencast") return;
    port.onMessage.addListener((msg) => {
      if (msg.type === "CDP_START") {
        startCDPCapture(msg.recordingId, msg.width, msg.height).catch((e) => {
          logger3.error("CDP start failed:", e);
          chrome.runtime.sendMessage({
            type: "OFFSCREEN_ERROR",
            error: String(e)
          });
        });
      } else if (msg.type === "CDP_FRAME") {
        paintCDPFrame(msg.data, msg.metadata);
        port.postMessage({ type: "CDP_ACK", ackId: msg.ackId });
      } else if (msg.type === "CDP_STOP") {
        stopCapture();
      }
    });
    port.onDisconnect.addListener(() => {
      logger3.log("CDP port disconnected");
      stopCapture();
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message.type === "OFFSCREEN_START") {
        try {
          logger3.log("Received OFFSCREEN_START message:", message);
          await startCapture(
            message.mode,
            message.recordingId,
            message.includeAudio,
            message.silent,
            message.streamId
          );
          sendResponse({ ok: true });
        } catch (e) {
          logger3.error("startCapture failed:", e);
          sendResponse({ ok: false, error: String(e) });
        }
      } else if (message.type === "OFFSCREEN_STOP") {
        logger3.log("Received OFFSCREEN_STOP message");
        stopCapture();
        sendResponse({ ok: true });
      }
    })();
    return true;
  });
})();
