// Recovery page: handles partial/interrupted recordings
// Phase 4 recovery flow

const DB_NAME = 'CaptureCastDB';
const DB_VERSION = 3;
const STORE_RECORDINGS = 'recordings';
const STORE_CHUNKS = 'chunks';
const SESSION_SNAPSHOT_KEY = 'sessionSnapshot';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * Get active session snapshot from chrome.storage.local
 * @returns {Promise<object|null>} Session snapshot or null
 */
async function getActiveSessionSnapshot() {
  try {
    const result = await chrome.storage.local.get(SESSION_SNAPSHOT_KEY);
    return result[SESSION_SNAPSHOT_KEY] || null;
  } catch (e) {
    return null;
  }
}

async function getRecoverableRecordings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDINGS, 'readonly');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.getAll();
    req.onsuccess = () => {
      const recordings = req.result.filter(
        (r) => r.status === 'partial' || r.status === 'recoverable' || r.status === 'failed'
      );
      resolve(recordings);
    };
    req.onerror = () => reject(req.error);
  });
}

async function countChunks(recordingId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, 'readonly');
    const store = tx.objectStore(STORE_CHUNKS);
    const index = store.index('recordingId');
    const req = index.getAllKeys(IDBKeyRange.only(recordingId));
    req.onsuccess = () => resolve(req.result.length);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRecording(recordingId) {
  const db = await openDB();
  const tx = db.transaction([STORE_RECORDINGS, STORE_CHUNKS], 'readwrite');

  // Delete metadata
  const recStore = tx.objectStore(STORE_RECORDINGS);
  recStore.delete(recordingId);

  // Delete chunks
  const chunkStore = tx.objectStore(STORE_CHUNKS);
  const index = chunkStore.index('recordingId');
  const keysReq = index.getAllKeys(IDBKeyRange.only(recordingId));
  keysReq.onsuccess = () => {
    for (const key of keysReq.result) {
      chunkStore.delete(key);
    }
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown size';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function render() {
  const listEl = document.getElementById('list');
  const subtitleEl = document.getElementById('subtitle');

  try {
    const recordings = await getRecoverableRecordings();
    const snapshot = await getActiveSessionSnapshot();

    // Prepend active session if exists
    if (snapshot && snapshot.recordingId && snapshot.status !== 'IDLE') {
      recordings.unshift({
        id: snapshot.recordingId,
        name: `Active Recording (${snapshot.status})`,
        createdAt: snapshot.startedAt || Date.now(),
        status: 'active',
        chunkCount: 0,
        size: 0,
      });
    }

    if (recordings.length === 0) {
      subtitleEl.textContent = 'No recoverable recordings found.';
      listEl.innerHTML = `
        <div class="empty">
          <div class="empty-icon">✅</div>
          <div>No partial or failed recordings to recover.</div>
        </div>`;
      return;
    }

    subtitleEl.textContent = `${recordings.length} recording${
      recordings.length !== 1 ? 's' : ''
    } need attention.`;

    listEl.innerHTML = '';
    for (const rec of recordings) {
      const chunkCount = await countChunks(rec.id);
      const item = document.createElement('div');
      item.className = 'item';

      const statusClass = rec.status === 'recoverable' ? 'status-recoverable' : 'status-partial';
      const statusLabel = rec.status === 'recoverable' ? 'Recoverable' : 'Partial';

      item.innerHTML = `
        <div class="item-header">
          <div>
            <div class="item-name">${escapeHtml(rec.name || rec.id)}</div>
            <div class="item-date">${formatDate(
              rec.createdAt
            )} · ${chunkCount} chunks · ${formatSize(rec.size)}</div>
          </div>
          <span class="item-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="item-actions">
          <button class="btn-retry" data-id="${rec.id}" data-action="retry">Retry save</button>
          <button class="btn-discard" data-id="${rec.id}" data-action="discard">Discard</button>
        </div>`;
      listEl.appendChild(item);
    }

    // Wire buttons
    listEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === 'discard') {
          if (confirm('Discard this recording? This cannot be undone.')) {
            // Check if this is an active session (has sessionSnapshot)
            const snapshot = await chrome.storage.local.get('sessionSnapshot');
            if (snapshot.sessionSnapshot && snapshot.sessionSnapshot.recordingId === id) {
              // Active session: clear via background message
              await chrome.runtime.sendMessage({ type: 'RECOVERY_DISCARD', id });
              // Also clear from storage
              await chrome.storage.local.remove('sessionSnapshot');
            } else {
              await deleteRecording(id);
            }
            render();
          }
        } else if (action === 'retry') {
          // Send resume message for active sessions
          const snapshot = await chrome.storage.local.get('sessionSnapshot');
          if (snapshot.sessionSnapshot && snapshot.sessionSnapshot.recordingId === id) {
            await chrome.runtime.sendMessage({ type: 'RECOVERY_RESUME', id });
          }
          // Navigate to preview with this ID
          window.location.href = `preview.html?id=${encodeURIComponent(id)}`;
        }
      });
    });
  } catch (err) {
    subtitleEl.textContent = 'Failed to load recoverable recordings.';
    listEl.innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', render);
