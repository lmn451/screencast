import { getAllRecordings, deleteRecording } from '../lib/db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Recordings');

// Global error handlers
globalThis.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled Rejection:', event.reason);
});
globalThis.addEventListener('error', (event) => {
  logger.error('Uncaught Exception:', event.error || event.message);
});
const listEl = document.getElementById('list');
const versionEl = document.getElementById('app-version');

if (versionEl) {
  versionEl.textContent = `ScreenSilo v${chrome.runtime.getManifest().version}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms) {
  if (!ms) return 'Unknown duration';
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown size';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

// 'active', 'partial', 'recoverable', and 'failed' recordings belong to the
// recovery UI (recovery.html), not the completed-recordings list — an 'active'
// stub would otherwise show mid-recording with a broken Play button.
// 'recoverable' is never persisted today (interrupted rows become 'partial'),
// but is excluded here for symmetry with recovery.js's status query.
const EXCLUDED_STATUSES = new Set(['active', 'partial', 'recoverable', 'failed']);

function showEmpty(message) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  listEl.replaceChildren(empty);
}

async function render() {
  try {
    const recordings = (await getAllRecordings()).filter(
      (rec) => !EXCLUDED_STATUSES.has(rec.status)
    );

    if (recordings.length === 0) {
      showEmpty('No recordings found.');
      return;
    }

    listEl.replaceChildren();
    recordings.forEach((rec) => {
      const item = document.createElement('div');
      item.className = 'item';

      const info = document.createElement('div');
      info.className = 'info';

      // Show custom name if available, otherwise show date
      const title = document.createElement('div');
      title.className = 'date';
      title.textContent = rec.name || formatDate(rec.createdAt);

      const meta = document.createElement('div');
      meta.className = 'meta';
      // If custom name is used, show date in meta
      const metaText = rec.name
        ? `${formatDate(rec.createdAt)} • ${rec.mimeType || 'video/webm'} • ${formatDuration(
            rec.duration
          )} • ${formatSize(rec.size)}`
        : `${rec.mimeType || 'video/webm'} • ${formatDuration(rec.duration)} • ${formatSize(
            rec.size
          )}`;
      meta.textContent = metaText;

      info.appendChild(title);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'actions';

      const playBtn = document.createElement('button');
      playBtn.className = 'btn-play';
      playBtn.textContent = 'Play / Download';
      playBtn.onclick = () => {
        try {
          chrome.tabs.create({
            url: `preview.html?id=${encodeURIComponent(rec.id)}`,
          });
        } catch (e) {
          logger.error('Failed to open recording preview:', e);
          alert('ScreenSilo: Failed to open recording preview.');
        }
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-delete';
      delBtn.textContent = 'Delete';
      delBtn.onclick = async () => {
        if (confirm('Are you sure you want to delete this recording?')) {
          try {
            await deleteRecording(rec.id);
            item.remove();
            if (listEl.children.length === 0) {
              showEmpty('No recordings found.');
            }
          } catch (e) {
            alert('Failed to delete: ' + e.message);
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
    showEmpty(`Error loading recordings: ${e.message}`);
    logger.error('Failed to load recordings:', e);
  }
}

document.addEventListener('DOMContentLoaded', render);
