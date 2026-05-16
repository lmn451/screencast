// Diagnostics page for CaptureCast
// Exports structured diagnostic logs from IndexedDB

const DB_NAME = 'CaptureCastDB';
const DB_VERSION = 3;
const DIAG_STORE = 'diagnostics';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DIAG_STORE)) {
        db.createObjectStore(DIAG_STORE, { keyPath: 'id' });
      }
    };
  });
}

async function getAllDiagnostics() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIAG_STORE, 'readonly');
    const store = tx.objectStore(DIAG_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function formatTimestamp(ts) {
  return new Date(ts).toLocaleString();
}

function renderEntries(entries) {
  const listEl = document.getElementById('log-list');
  const totalEl = document.getElementById('total-count');
  const latestEl = document.getElementById('latest-time');
  const exportBtn = document.getElementById('btn-export');

  if (entries.length === 0) {
    listEl.innerHTML = '<div class="empty">No diagnostic entries yet.</div>';
    totalEl.textContent = '0';
    latestEl.textContent = '—';
    exportBtn.disabled = true;
    return;
  }

  totalEl.textContent = String(entries.length);
  latestEl.textContent = formatTimestamp(entries[entries.length - 1].ts);
  exportBtn.disabled = false;

  // Sort newest first, show last 200
  const shown = entries
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200);

  listEl.innerHTML = shown
    .map(
      (e) => `
      <div class="log-entry">
        <div class="log-meta">
          <span class="log-level ${e.level}">${e.level.toUpperCase()}</span>
          <span class="log-code">${e.eventCode || '—'}</span>
          <span class="log-ts">${formatTimestamp(e.ts)}</span>
        </div>
        <div class="log-user">${escapeHtml(e.userMessage || '')}</div>
        ${e.technicalMessage ? `<div class="log-tech">${escapeHtml(e.technicalMessage)}</div>` : ''}
      </div>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function downloadJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `capturecast-diagnostics-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

async function clearDiagnostics() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIAG_STORE, 'readwrite');
    const store = tx.objectStore(DIAG_STORE);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const entries = await getAllDiagnostics();
    renderEntries(entries);

    document.getElementById('btn-export').addEventListener('click', async () => {
      try {
        const entries = await getAllDiagnostics();
        downloadJSON({
          exportedAt: new Date().toISOString(),
          count: entries.length,
          entries,
        });
      } catch (e) {
        console.error('[Diagnostics] Export failed:', e);
        alert('CaptureCast: Failed to export diagnostics: ' + (e.message || e));
      }
    });

    document.getElementById('btn-clear').addEventListener('click', async () => {
      if (confirm('Clear all diagnostic entries? This cannot be undone.')) {
        try {
          await clearDiagnostics();
          renderEntries([]);
        } catch (e) {
          console.error('[Diagnostics] Clear failed:', e);
          alert('CaptureCast: Failed to clear diagnostics: ' + (e.message || e));
        }
      }
    });
  } catch (err) {
    document.getElementById(
      'log-list'
    ).innerHTML = `<div class="empty">Failed to load diagnostics: ${escapeHtml(err.message)}</div>`;
  }
});
