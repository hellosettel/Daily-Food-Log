/* ============================================================
   db.js — IndexedDB wrapper
   ============================================================
   Local-first storage. Every write goes here first (instant,
   works offline), and sync.js pushes/pulls from Supabase in
   the background.

   Stores:
     meals        — keyPath: id (uuid)
     weights      — keyPath: id (uuid)
     foods        — keyPath: id (uuid), shared catalog
     targets      — keyPath: user_id (one row per user)
     notes        — keyPath: date (YYYY-MM-DD), per user
     pending      — keyPath: id (auto), queue of unsynced ops
     meta         — keyPath: key (kv store for last-sync timestamps etc.)
   ============================================================ */

const DB_NAME = 'daily-log';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('meals')) {
        const s = db.createObjectStore('meals', { keyPath: 'id' });
        s.createIndex('by_date', 'date');
        s.createIndex('by_user', 'user_id');
      }

      if (!db.objectStoreNames.contains('weights')) {
        const s = db.createObjectStore('weights', { keyPath: 'id' });
        s.createIndex('by_date', 'date');
        s.createIndex('by_user', 'user_id');
      }

      if (!db.objectStoreNames.contains('foods')) {
        const s = db.createObjectStore('foods', { keyPath: 'id' });
        s.createIndex('by_name', 'name');
      }

      if (!db.objectStoreNames.contains('targets')) {
        db.createObjectStore('targets', { keyPath: 'user_id' });
      }

      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: ['user_id', 'date'] });
        s.createIndex('by_user', 'user_id');
      }

      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode = 'readonly') {
  return openDB().then(db => db.transaction(stores, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ===== generic CRUD ===== */

async function dbPut(store, value) {
  const t = await tx([store], 'readwrite');
  return reqToPromise(t.objectStore(store).put(value));
}

async function dbGet(store, key) {
  const t = await tx([store]);
  return reqToPromise(t.objectStore(store).get(key));
}

async function dbDelete(store, key) {
  const t = await tx([store], 'readwrite');
  return reqToPromise(t.objectStore(store).delete(key));
}

async function dbAll(store) {
  const t = await tx([store]);
  return reqToPromise(t.objectStore(store).getAll());
}

async function dbAllByIndex(store, indexName, key) {
  const t = await tx([store]);
  const idx = t.objectStore(store).index(indexName);
  return reqToPromise(idx.getAll(key));
}

async function dbClear(store) {
  const t = await tx([store], 'readwrite');
  return reqToPromise(t.objectStore(store).clear());
}

/* ===== meta (kv) ===== */

async function metaGet(key) {
  const row = await dbGet('meta', key);
  return row ? row.value : null;
}

async function metaSet(key, value) {
  return dbPut('meta', { key, value });
}

/* ===== pending ops queue ===== */
/*
   Every local mutation enqueues a pending op:
     { id (auto), op: 'upsert'|'delete', table, record }
   sync.js drains this queue when online.
*/

async function enqueue(op) {
  const t = await tx(['pending'], 'readwrite');
  return reqToPromise(t.objectStore('pending').add(op));
}

async function pendingAll() {
  return dbAll('pending');
}

async function pendingRemove(id) {
  return dbDelete('pending', id);
}

/* ===== utils ===== */

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function todayLocalDate() {
  const d = new Date();
  return ymd(d);
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

window.DB = {
  openDB,
  put: dbPut,
  get: dbGet,
  delete: dbDelete,
  all: dbAll,
  allByIndex: dbAllByIndex,
  clear: dbClear,
  metaGet,
  metaSet,
  enqueue,
  pendingAll,
  pendingRemove,
  uuid,
  todayLocalDate,
  ymd,
  parseYMD
};
