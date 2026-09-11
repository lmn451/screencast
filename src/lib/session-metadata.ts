import type { SessionSnapshot } from '../machines/types.js';

/**
 * Atomic coordination for the one capture session that can own the browser
 * capture context at a time.
 *
 * chrome.storage.local has no compare-and-swap primitive. A service worker
 * that was suspended can therefore finish an old `set()` after a new worker
 * has claimed a session. Keep the ownership fence in a tiny, separate
 * IndexedDB database so each worker's transaction is serialized by the
 * browser. Recording data and the approved CaptureCastDB schema are unrelated
 * to this metadata store.
 */

export const SESSION_METADATA_DB_NAME = 'CaptureCastSessionMetadata';
const SESSION_METADATA_DB_VERSION = 1;
const SESSION_METADATA_STORE = 'session';
const OWNER_KEY = 'owner';

export type SessionOwnerStatus = 'active' | 'retired';

export interface SessionOwner {
  recordingId: string;
  generation: number;
  status: SessionOwnerStatus;
  strategy: 'offscreen' | 'page' | null;
  recorderTabId: number | null;
  overlayTabId: number | null;
  updatedAt: number;
  snapshot?: SessionSnapshot;
}

type SessionOwnerPatch = Omit<SessionOwner, 'generation' | 'status' | 'updatedAt'>;

function isOwner(value: unknown): value is SessionOwner {
  if (typeof value !== 'object' || value === null) return false;
  const owner = value as Partial<SessionOwner>;
  return (
    typeof owner.recordingId === 'string' &&
    typeof owner.generation === 'number' &&
    (owner.status === 'active' || owner.status === 'retired') &&
    (owner.strategy === 'offscreen' || owner.strategy === 'page' || owner.strategy === null) &&
    (owner.recorderTabId === null || typeof owner.recorderTabId === 'number') &&
    (owner.overlayTabId === null || typeof owner.overlayTabId === 'number') &&
    typeof owner.updatedAt === 'number'
  );
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_METADATA_DB_NAME, SESSION_METADATA_DB_VERSION);
    request.onerror = () =>
      reject(request.error || new Error('Failed to open session metadata DB'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_METADATA_STORE)) {
        db.createObjectStore(SESSION_METADATA_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

/** Run one metadata transaction and close its connection after completion. */
function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, setResult: (value: T) => void) => void
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result!: T;
        let settled = false;
        let tx: IDBTransaction | undefined;
        try {
          tx = db.transaction(SESSION_METADATA_STORE, mode);
          const store = tx.objectStore(SESSION_METADATA_STORE);
          tx.oncomplete = () => {
            db.close();
            if (!settled) {
              settled = true;
              resolve(result);
            }
          };
          tx.onerror = () => {
            db.close();
            if (!settled) {
              settled = true;
              reject(tx?.error || new Error('Session metadata transaction failed'));
            }
          };
          tx.onabort = () => {
            db.close();
            if (!settled) {
              settled = true;
              reject(tx?.error || new Error('Session metadata transaction aborted'));
            }
          };
          operation(store, (value) => {
            result = value;
          });
        } catch (error) {
          try {
            tx?.abort();
          } catch {
            db.close();
          }
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      })
  );
}

export async function readSessionOwner(): Promise<SessionOwner | null> {
  return transaction<SessionOwner | null>('readonly', (store, setResult) => {
    const request = store.get(OWNER_KEY);
    request.onsuccess = () => {
      setResult(isOwner(request.result) ? request.result : null);
    };
  });
}

/**
 * Claim the ownership fence for a newly-starting or restored recording.
 * Retired recordings cannot reclaim their own fence. A different active
 * recording always wins until it is retired by its own worker.
 */
export async function claimSessionOwner(owner: SessionOwnerPatch): Promise<SessionOwner | null> {
  return transaction<SessionOwner | null>('readwrite', (store, setResult) => {
    const request = store.get(OWNER_KEY);
    request.onsuccess = () => {
      const current = isOwner(request.result) ? request.result : null;
      if (
        current &&
        (current.status === 'active' || current.recordingId === owner.recordingId) &&
        current.recordingId !== owner.recordingId
      ) {
        setResult(null);
        return;
      }
      if (current?.status === 'retired' && current.recordingId === owner.recordingId) {
        setResult(null);
        return;
      }
      const claimed: SessionOwner = {
        ...(current?.recordingId === owner.recordingId ? current : {}),
        ...owner,
        generation:
          current?.recordingId === owner.recordingId
            ? current.generation
            : (current?.generation ?? 0) + 1,
        status: 'active',
        updatedAt: Date.now(),
      } satisfies SessionOwner;
      if (claimed.snapshot) {
        claimed.snapshot = { ...claimed.snapshot, generation: claimed.generation };
      }
      store.put(claimed, OWNER_KEY);
      setResult(claimed);
    };
  });
}

/** Retire the current owner if it still belongs to `recordingId`. */
export async function retireSessionOwner(
  recordingId: string,
  resources: Omit<SessionOwnerPatch, 'recordingId'>
): Promise<boolean> {
  return transaction<boolean>('readwrite', (store, setResult) => {
    const request = store.get(OWNER_KEY);
    request.onsuccess = () => {
      const current = isOwner(request.result) ? request.result : null;
      if (current && current.recordingId !== recordingId) {
        setResult(false);
        return;
      }
      store.put(
        {
          ...current,
          recordingId,
          generation: current?.generation ?? 0,
          ...resources,
          status: 'retired',
          updatedAt: Date.now(),
        } satisfies SessionOwner,
        OWNER_KEY
      );
      setResult(true);
    };
  });
}

/** Refresh browser resource IDs after a page recorder has been created. */
export async function updateSessionOwner(
  recordingId: string,
  resources: Omit<SessionOwnerPatch, 'recordingId'>
): Promise<boolean> {
  return transaction<boolean>('readwrite', (store, setResult) => {
    const request = store.get(OWNER_KEY);
    request.onsuccess = () => {
      const current = isOwner(request.result) ? request.result : null;
      if (!current || current.status !== 'active' || current.recordingId !== recordingId) {
        setResult(false);
        return;
      }
      store.put(
        {
          ...current,
          recordingId,
          generation: current.generation,
          ...resources,
          snapshot: resources.snapshot ?? current.snapshot,
          status: 'active',
          updatedAt: Date.now(),
        } satisfies SessionOwner,
        OWNER_KEY
      );
      setResult(true);
    };
  });
}
