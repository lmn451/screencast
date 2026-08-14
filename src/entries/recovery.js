// Recovery page: handles partial/interrupted recordings
// Phase 4 recovery flow

import { STORE_RECORDINGS, STORE_CHUNKS, openDB } from '../lib/db-shared.js';
const SESSION_SNAPSHOT_KEY = 'sessionSnapshot';

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
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
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
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
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

    // Prepend active session if exists.
    // Status comes from the XState machine and is always lowercase
    // ('idle', 'starting', 'recording', 'stopping', 'saved', 'failed', 'recoverable').
    if (snapshot && snapshot.recordingId && snapshot.status !== 'idle') {
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
      const empty = document.createElement('div');
      empty.className = 'empty';
      const icon = document.createElement('div');
      icon.className = 'empty-icon';
      icon.textContent = '✅';
      const message = document.createElement('div');
      message.textContent = 'No partial or failed recordings to recover.';
      empty.append(icon, message);
      listEl.replaceChildren(empty);
      return;
    }

    subtitleEl.textContent = `${recordings.length} recording${
      recordings.length !== 1 ? 's' : ''
    } need attention.`;

    listEl.replaceChildren();
    for (const rec of recordings) {
      const chunkCount = await countChunks(rec.id);
      const item = document.createElement('div');
      item.className = 'item';

      const statusClass = rec.status === 'recoverable' ? 'status-recoverable' : 'status-partial';
      const statusLabel =
        {
          recoverable: 'Recoverable',
          partial: 'Partial',
          failed: 'Failed',
          active: 'Active',
        }[rec.status] || 'Partial';

      const header = document.createElement('div');
      header.className = 'item-header';
      const details = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'item-name';
      name.textContent = rec.name || rec.id;
      const date = document.createElement('div');
      date.className = 'item-date';
      date.textContent = `${formatDate(rec.createdAt)} · ${chunkCount} chunks · ${formatSize(
        rec.size
      )}`;
      details.append(name, date);

      const status = document.createElement('span');
      status.className = `item-status ${statusClass}`;
      status.textContent = statusLabel;
      header.append(details, status);

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const saveButton = document.createElement('button');
      saveButton.className = 'btn-retry';
      saveButton.dataset.id = rec.id;
      saveButton.dataset.action = 'save-partial';
      saveButton.textContent = 'Save partial';
      const discardButton = document.createElement('button');
      discardButton.className = 'btn-discard';
      discardButton.dataset.id = rec.id;
      discardButton.dataset.action = 'discard';
      discardButton.textContent = 'Discard';
      actions.append(saveButton, discardButton);

      item.append(header, actions);
      listEl.appendChild(item);
    }

    // Wire buttons
    listEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        try {
          if (action === 'discard') {
            if (confirm('Discard this recording? This cannot be undone.')) {
              // Check if this is an active session (has sessionSnapshot)
              try {
                const snapshot = await chrome.storage.local.get('sessionSnapshot');
                if (snapshot.sessionSnapshot && snapshot.sessionSnapshot.recordingId === id) {
                  // Background owns the machine transition and snapshot cleanup.
                  await chrome.runtime.sendMessage({ type: 'RECOVERY_DISCARD', recordingId: id });
                } else {
                  await deleteRecording(id);
                }
              } catch (storageErr) {
                // Fall back to direct delete if storage/message fails
                console.error('[Recovery] Storage/message error during discard:', storageErr);
                try {
                  await deleteRecording(id);
                } catch (deleteErr) {
                  alert(
                    'ScreenSilo: Failed to discard recording: ' + (deleteErr.message || deleteErr)
                  );
                  return;
                }
              }
              render();
            }
          } else if (action === 'save-partial') {
            // Resume is gone in MV3 (dead MediaStream, no tab/gesture to
            // reattach to). The only recoverable artifact is the persisted
            // chunk set, so just open the preview — it assembles the partial
            // blob via getRecording() (chunks + metadata stub row).
            window.location.href = `preview.html?id=${encodeURIComponent(id)}`;
          }
        } catch (e) {
          console.error('[Recovery] Button action failed:', e);
          alert('ScreenSilo: Operation failed: ' + (e.message || e));
        }
      });
    });
  } catch (err) {
    subtitleEl.textContent = 'Failed to load recoverable recordings.';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `Error: ${err.message}`;
    listEl.replaceChildren(empty);
  }
}

document.addEventListener('DOMContentLoaded', render);
