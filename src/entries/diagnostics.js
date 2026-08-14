// Diagnostics page for ScreenSilo
// Exports structured diagnostic logs from IndexedDB

import { DIAG_STORE, openDB } from '../lib/db-shared.js';
import { redactDiagnosticsEntry } from '../diagnostics.js';

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

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function showEmpty(listEl, message) {
  listEl.replaceChildren(createTextElement('div', 'empty', message));
}

function renderEntries(entries) {
  const listEl = document.getElementById('log-list');
  const totalEl = document.getElementById('total-count');
  const latestEl = document.getElementById('latest-time');
  const exportBtn = document.getElementById('btn-export');

  if (entries.length === 0) {
    showEmpty(listEl, 'No diagnostic entries yet.');
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

  listEl.replaceChildren();
  for (const entry of shown) {
    const row = document.createElement('div');
    row.className = 'log-entry';
    const meta = document.createElement('div');
    meta.className = 'log-meta';

    const level = createTextElement('span', 'log-level', String(entry.level).toUpperCase());
    const levelClass = String(entry.level).match(/^[a-z0-9_-]+$/i) ? entry.level : 'unknown';
    level.classList.add(levelClass);
    meta.append(
      level,
      createTextElement('span', 'log-code', entry.eventCode || '—'),
      createTextElement('span', 'log-ts', formatTimestamp(entry.ts))
    );

    row.append(meta, createTextElement('div', 'log-user', entry.userMessage || ''));
    if (entry.technicalMessage) {
      row.append(createTextElement('div', 'log-tech', entry.technicalMessage));
    }
    listEl.appendChild(row);
  }
}

function downloadJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `screensilo-diagnostics-${Date.now()}.json`;
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
    renderEntries(entries.map(redactDiagnosticsEntry));

    document.getElementById('btn-export').addEventListener('click', async () => {
      try {
        const entries = (await getAllDiagnostics()).map(redactDiagnosticsEntry);
        downloadJSON({
          exportedAt: new Date().toISOString(),
          count: entries.length,
          entries,
        });
      } catch (e) {
        console.error('[Diagnostics] Export failed:', e);
        alert('ScreenSilo: Failed to export diagnostics: ' + (e.message || e));
      }
    });

    document.getElementById('btn-clear').addEventListener('click', async () => {
      if (confirm('Clear all diagnostic entries? This cannot be undone.')) {
        try {
          await clearDiagnostics();
          renderEntries([]);
        } catch (e) {
          console.error('[Diagnostics] Clear failed:', e);
          alert('ScreenSilo: Failed to clear diagnostics: ' + (e.message || e));
        }
      }
    });
  } catch (err) {
    showEmpty(document.getElementById('log-list'), `Failed to load diagnostics: ${err.message}`);
  }
});
