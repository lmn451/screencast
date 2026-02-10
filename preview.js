import { getRecording } from "./db.js";
import { createLogger } from "./logger.js";
import { DURATION_FIX_TIMEOUT_MS, SEEK_POSITION_LARGE } from "./constants.js";

const logger = createLogger("Preview");

// Global error handlers
globalThis.addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled Rejection:", event.reason);
});
globalThis.addEventListener("error", (event) => {
  logger.error("Uncaught Exception:", event.error || event.message);
});

function getQueryParam(name) {
  const url = new URL(location.href);
  return url.searchParams.get(name);
}

// Validate UUID format for security
function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
}

function saveFile(blob, filename) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

// Exported function to normalize duration and avoid jumpy preview
export function fixDurationAndReset(video, opts = {}) {
  const { timeoutMs = DURATION_FIX_TIMEOUT_MS } = opts;
  if (!video) return;

  // If metadata not loaded yet, wait and retry
  if (video.readyState < 1) {
    const onLM = () => {
      video.removeEventListener("loadedmetadata", onLM);
      fixDurationAndReset(video, opts);
    };
    video.addEventListener("loadedmetadata", onLM, { once: true });
    return;
  }

  // Idempotency: if already stable or already normalizing, do nothing
  if (video.dataset?.stable === "true" || video.__previewNormalizerActive) {
    return;
  }

  video.__previewNormalizerActive = true;

  const startNow =
    typeof performance !== "undefined" && performance.now
      ? performance.now.bind(performance)
      : Date.now;
  const t0 = startNow();
  const safeCT = () => {
    try {
      return video.currentTime || 0;
    } catch {
      return 0;
    }
  };

  // Metrics hook for tests/diagnostics
  const metrics = (window.__PREVIEW_METRICS__ = {
    normalizedAtMs: undefined,
    maxCTBeforeReset: 0,
    timedOut: false,
    events: [],
  });
  const record = (ev) =>
    metrics.events.push({
      ev,
      t: startNow() - t0,
      ct: safeCT(),
      dur: video.duration,
    });

  // If already finite, mark stable and return
  if (Number.isFinite(video.duration) && video.duration > 0) {
    video.dataset.stable = "true";
    video.__previewNormalizerStable = true;
    video.__previewNormalizerActive = false;
    record("already-finite");
    return;
  }

  // Begin normalization
  if (video.dataset) video.dataset.stable = "false";
  try {
    video.pause?.();
  } catch {}

  let fixed = false;
  let timer;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    video.removeEventListener("durationchange", onDurationChange);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.__previewNormalizerActive = false;
  };

  const stabilize = (reason) => {
    if (fixed) return;
    fixed = true;
    record("stabilize:" + reason);
    metrics.maxCTBeforeReset = Math.max(metrics.maxCTBeforeReset, safeCT());
    try {
      video.currentTime = 0;
    } catch {}
    if (video.dataset) video.dataset.stable = "true";
    metrics.normalizedAtMs = startNow() - t0;
    cleanup();
    video.__previewNormalizerStable = true;
  };

  const onDurationChange = () => {
    record("durationchange");
    if (Number.isFinite(video.duration) && video.duration > 0)
      stabilize("durationchange");
  };
  const onSeeked = () => {
    record("seeked");
    if (Number.isFinite(video.duration) && video.duration > 0)
      stabilize("seeked");
  };
  const onTimeUpdate = () => {
    const ct = safeCT();
    if (ct > metrics.maxCTBeforeReset) metrics.maxCTBeforeReset = ct;
    if (Number.isFinite(video.duration) && video.duration > 0)
      stabilize("timeupdate");
  };

  video.addEventListener("durationchange", onDurationChange);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("timeupdate", onTimeUpdate);

  // Timeout path
  timer = setTimeout(() => {
    metrics.timedOut = true;
    stabilize("timeout");
  }, timeoutMs);

  // Large seek with fallback to seekable end
  // Seeking to a very large time forces the browser to parse the entire WebM file
  // and calculate the actual duration. We use MAX_SAFE_INTEGER/2 to avoid overflow.
  const BIG = SEEK_POSITION_LARGE;
  let sought = false;
  try {
    record("seek-large");
    video.currentTime = BIG;
    sought = true;
  } catch (e) {
    record("seek-large-failed");
  }
  if (!sought) {
    try {
      if (video.seekable && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1);
        record("seek-fallback:" + end);
        video.currentTime = end;
      }
    } catch (e) {
      record("seek-fallback-failed");
    }
  }
}

// Test-only exposure when ?test is present
if (typeof window !== "undefined" && window.location.search.includes("test")) {
  window.__TEST__ = window.__TEST__ || {};
  window.__TEST__.fixDurationAndReset = fixDurationAndReset;
  // Expose DB helpers for tests
  import("./db.js").then((db) => {
    window.__TEST__.saveChunk = db.saveChunk;
    window.__TEST__.finishRecording = db.finishRecording;
    window.__TEST__.getRecording = db.getRecording;
  });
}

(async () => {
  const id = getQueryParam("id");
  let blob;
  let mimeType;
  let recordName = null;
  let recordCreatedAt = null;

  if (window.__TEST_BLOB__) {
    logger.log("Using injected __TEST_BLOB__ for video source");
    blob = window.__TEST_BLOB__;
    mimeType = blob.type || "video/webm";
  } else {
    if (!id) {
      document.body.textContent = "Missing recording id";
      return;
    }

    // Validate recording ID format for security
    if (!isValidUUID(id)) {
      logger.error("Invalid recording ID format:", id);
      document.body.textContent = "Invalid recording ID format";
      return;
    }

    // Load from DB
    try {
      const record = await getRecording(id);
      if (!record || !record.blob) {
        throw new Error("Recording not found in DB");
      }
      blob = record.blob;
      mimeType = record.mimeType;
      recordName = record.name;
      recordCreatedAt = record.createdAt;
      logger.log("Loaded from DB:", blob.size, "bytes");
    } catch (e) {
      logger.error("Failed to load from DB:", e);
      document.body.textContent = "Failed to load recording: " + e.message;
      return;
    }
  }

  const filenameInput = document.getElementById("filename-input");

  const mtForNaming = mimeType || "video/webm";
  let extForNaming = "webm";
  if (mtForNaming.includes("mp4")) extForNaming = "mp4";
  else if (mtForNaming.includes("webm")) extForNaming = "webm";

  // Deterministic default name so it stays stable across reloads/clicks.
  // Prefer createdAt from DB; fall back to "now" only if missing (should be rare).
  const tsSource = recordCreatedAt ?? Date.now();
  const tsForName = new Date(tsSource).toISOString().replaceAll(/[:.]/g, "-");
  const defaultBaseName = `CaptureCast-${tsForName}`;

  // Show current filename base in the input: saved name if present, otherwise default.
  // (Input holds base name only, without extension)
  const currentBaseName = recordName || defaultBaseName;
  if (filenameInput) {
    // Set value to the saved custom name if present, otherwise empty (so placeholder shows)
    filenameInput.value = recordName || "";

    // Select the text only when there's no saved name, to make it easy to overwrite.
    if (!recordName) {
      try {
        filenameInput.focus();
        filenameInput.select();
      } catch {
        // ignore
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const video = document.getElementById("video");
  video.src = url;
  // Start hidden until normalized to avoid visible jump
  if (video.dataset) video.dataset.stable = "false";

  // Important: Do NOT revoke the URL immediately; the video element may request ranges during playback.
  // Revoke on page unload to avoid net::ERR_FILE_NOT_FOUND and truncated playback.

  const startNormalization = () => {
    fixDurationAndReset(video, { timeoutMs: 2000 });
  };

  video.onloadedmetadata = () => {
    logger.log("Video metadata loaded:", {
      duration: video.duration,
      mimeType,
    });
    startNormalization();
  };
  // Reset to start if browser fires ended immediately after load
  const onEndedReset = () => {
    try {
      video.currentTime = 0;
    } catch (e) {
      logger.log("Error resetting video (non-fatal):", e);
    }
    try {
      video.pause();
    } catch (e) {
      logger.log("Error pausing video (non-fatal):", e);
    }
    logger.log("Ended event caught, reset to start");
  };
  video.addEventListener("ended", onEndedReset);

  // Extra guard in case metadata was already loaded
  if (video.readyState >= 1) startNormalization();

  window.addEventListener("beforeunload", () => URL.revokeObjectURL(url));
  video.onerror = (e) => {
    logger.error("Video failed to load:", e);
  };

  const downloadBtn = document.getElementById("btn-download");
  downloadBtn.addEventListener("click", async () => {
    // Input holds base name only (no extension)
    const inputBaseName = document
      .getElementById("filename-input")
      .value.trim();

    // If user cleared the input, fall back to deterministic default.
    const baseName = inputBaseName || defaultBaseName;
    const filename = `${baseName}.${extForNaming}`;

    // Persist to DB if:
    // 1. User provided a non-empty custom name, AND
    // 2. It's different from the default name, AND
    // 3. It's different from the current saved name (avoid redundant updates)
    const shouldPersistName =
      !!id &&
      !!inputBaseName &&
      inputBaseName !== defaultBaseName &&
      inputBaseName !== recordName;

    if (shouldPersistName) {
      try {
        const { updateRecordingName } = await import("./db.js");
        await updateRecordingName(id, inputBaseName);
        logger.log("Saved custom name to database:", inputBaseName);
      } catch (e) {
        logger.error("Failed to save custom name:", e);
      }
    }

    // If user cleared a previously saved custom name, clear it from DB
    if (!!id && !inputBaseName && recordName) {
      try {
        const { updateRecordingName } = await import("./db.js");
        await updateRecordingName(id, null);
        logger.log("Cleared custom name from database");
      } catch (e) {
        logger.error("Failed to clear custom name:", e);
      }
    }

    logger.log("Downloading file:", filename, "Size:", blob.size, "bytes");
    saveFile(blob, filename);
  });

  // Add cleanup button
  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "Delete Recording";
  deleteBtn.style.background = "#d93025";
  deleteBtn.style.color = "#fff";
  deleteBtn.style.border = "none";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm("Delete this recording? This cannot be undone.")) return;
    try {
      const { deleteRecording } = await import("./db.js");
      await deleteRecording(id);
      document.body.innerHTML =
        "<h1>Recording Deleted</h1><p>You can close this tab.</p>";
    } catch (e) {
      alert("Failed to delete recording: " + e.message);
    }
  });
  document.querySelector(".actions").appendChild(deleteBtn);

  const viewAllBtn = document.createElement("button");
  viewAllBtn.textContent = "View All Recordings";
  viewAllBtn.style.marginLeft = "10px";
  viewAllBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "recordings.html" });
  });
  document.querySelector(".actions").appendChild(viewAllBtn);
})();
