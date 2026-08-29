import type { Aggregate } from './types.ts';

// The 633 MB export is parsed once; only the ~2 MB aggregate is kept.
const DB = 'health-visualizer', STORE = 'data';

export interface Saved { data: Aggregate; importedAt: string }

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, no) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => ok(rq.result);
    rq.onerror = () => no(rq.error);
  });
}

export async function idbGet(key: string): Promise<Saved | undefined> {
  const db = await idb();
  return new Promise((ok, no) => {
    const rq = db.transaction(STORE).objectStore(STORE).get(key);
    rq.onsuccess = () => ok(rq.result as Saved | undefined);
    rq.onerror = () => no(rq.error);
  });
}

export async function idbPut(key: string, value: Saved): Promise<void> {
  const db = await idb();
  return new Promise((ok, no) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => ok();
    tx.onerror = () => no(tx.error);
  });
}
