// lib/store.js — the ONE storage interface for Verastar.
//
// Locked decision (BUILD_PLAN): local-first / IndexedDB, behind a single interface so
// Supabase can be swapped in later (P2) without touching any page. Nothing else in the
// app talks to IndexedDB directly — everyone imports `store`.
//
// Shape is a small set of named collections, each a keyed object store:
//   - profile   : singleton steering profile (north stars, projects, rubric)  [key 'me']
//   - papers    : saved Knowledge Base papers, keyed by id (pmid/doi)
//   - digests   : generated daily/weekend digests, keyed by date
//   - graphNodes: knowledge-graph nodes (papers + projects), keyed by id
//   - graphEdges: knowledge-graph edges, keyed by id
//   - domains   : the user's domain taxonomy { key, label, color }, keyed by key
//
// The API is deliberately generic (get/put/all/delete/clear) so the Supabase impl is a
// drop-in: same method names, same return contracts.

const DB_NAME = 'verastar'
const DB_VERSION = 2 // v2: + domains collection
export const COLLECTIONS = ['profile', 'papers', 'digests', 'graphNodes', 'graphEdges', 'domains']

let _dbPromise = null

// How long a DB open may take before we call it failed. Opens are normally instant;
// a hang here means another tab holds an old-version connection (or the browser's
// storage queue is stuck) — surface that instead of a silent black screen.
const OPEN_TIMEOUT_MS = 6000

function openDb() {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    const timer = setTimeout(() => {
      _dbPromise = null // let a later call retry
      reject(new Error('Storage did not open — another Verastar tab may be holding it. Close other tabs and reload.'))
    }, OPEN_TIMEOUT_MS)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of COLLECTIONS) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name)
        }
      }
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      const db = req.result
      // A newer tab bumping DB_VERSION sends versionchange — close so it can upgrade
      // instead of blocking it into a black screen. Next call here reopens fresh.
      db.onversionchange = () => {
        db.close()
        _dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => {
      clearTimeout(timer)
      _dbPromise = null
      reject(req.error)
    }
  })
  return _dbPromise
}

function tx(collection, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(collection, mode)
        const objectStore = transaction.objectStore(collection)
        const request = fn(objectStore)
        transaction.oncomplete = () => resolve(request?.result)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }),
  )
}

export const store = {
  // Read one record by key. Resolves to the value or undefined.
  get(collection, key) {
    return tx(collection, 'readonly', (os) => os.get(key))
  },

  // Write one record under key. Value is stored as-is (structured clone).
  put(collection, key, value) {
    return tx(collection, 'readwrite', (os) => os.put(value, key))
  },

  // Read every record in a collection as an array (values only).
  all(collection) {
    return tx(collection, 'readonly', (os) => os.getAll())
  },

  // Delete one record by key.
  delete(collection, key) {
    return tx(collection, 'readwrite', (os) => os.delete(key))
  },

  // Empty a collection.
  clear(collection) {
    return tx(collection, 'readwrite', (os) => os.clear())
  },
}

// --- convenience helpers for the singleton profile ---

const PROFILE_KEY = 'me'

export function getProfile() {
  return store.get('profile', PROFILE_KEY)
}

export function saveProfile(profile) {
  return store.put('profile', PROFILE_KEY, profile)
}
