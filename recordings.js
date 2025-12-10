import { getAllRecordings, deleteRecording } from "./db.js";
import { createLogger } from "./logger.js";

const logger = createLogger("Recordings");

// Global error handlers
globalThis.addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled Rejection:", event.reason);
});
globalThis.addEventListener("error", (event) => {
  logger.error("Uncaught Exception:", event.error || event.message);
});
const listEl = document.getElementById("list");

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms) {
  if (!ms) return "Unknown duration";
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes) {
  if (!bytes) return "Unknown size";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

async function render() {
  try {
    const recordings = await getAllRecordings();

    if (recordings.length === 0) {
      listEl.innerHTML = '<div class="empty">No recordings found.</div>';
      return;
    }

    listEl.innerHTML = "";
    recordings.forEach((rec) => {
      const item = document.createElement("div");
      item.className = "item";

      const info = document.createElement("div");
      info.className = "info";

      const date = document.createElement("div");
      date.className = "date";
      date.textContent = formatDate(rec.createdAt);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${rec.mimeType || "video/webm"} • ${formatDuration(
        rec.duration
      )} • ${formatSize(rec.size)}`;

      info.appendChild(date);
      info.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "actions";

      const playBtn = document.createElement("button");
      playBtn.className = "btn-play";
      playBtn.textContent = "Play / Download";
      playBtn.onclick = () => {
        chrome.tabs.create({
          url: `preview.html?id=${encodeURIComponent(rec.id)}`,
        });
      };

      const delBtn = document.createElement("button");
      delBtn.className = "btn-delete";
      delBtn.textContent = "Delete";
      delBtn.onclick = async () => {
        if (confirm("Are you sure you want to delete this recording?")) {
          try {
            await deleteRecording(rec.id);
            item.remove();
            if (listEl.children.length === 0) {
              listEl.innerHTML =
                '<div class="empty">No recordings found.</div>';
            }
          } catch (e) {
            alert("Failed to delete: " + e.message);
          }
        }
      };

      actions.appendChild(playBtn);
      actions.appendChild(delBtn);

      item.appendChild(info);
      item.appendChild(actions);
      listEl.appendChild(item);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="empty">Error loading recordings: ${e.message}</div>`;
    logger.error("Failed to load recordings:", e);
  }
}

document.addEventListener("DOMContentLoaded", render);
