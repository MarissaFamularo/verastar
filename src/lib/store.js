// lib/store.js — the ONE storage interface for Verastar.
//
// Since day 1 this file promised the Supabase swap would happen behind this
// interface — this is that swap. `store` is now a facade: signed OUT it is the
// original IndexedDB impl, byte-for-byte the old behavior (keyless demo, judges,
// ?firstrun=1 all untouched). Signed IN it is the Supabase-backed impl and the
// cloud is the source of truth. App boot calls initStore() before any read.
//
// Shape is a small set of named collections, each a keyed object store:
//   - profile   : singleton steering profile (north stars, projects, rubric)  [key 'me']
//   - papers    : saved Knowledge Base papers, keyed by id (pmid/doi)
//   - digests   : generated daily/weekend digests, keyed by date
//   - graphNodes: knowledge-graph nodes (papers + projects), keyed by id
//   - graphEdges: knowledge-graph edges, keyed by id
//   - domains   : the user's domain taxonomy { key, label, color }, keyed by key
//
// Device-local exception: `libraryHandle` (a FileSystemDirectoryHandle in the
// profile collection) is structured-clone-only — it cannot serialize to JSON and
// is meaningless on another device. It ALWAYS routes to IndexedDB, signed in or
// not. The Anthropic key never touches this module at all (sessionStorage/
// localStorage only — see lib/anthropic.js).

import { supabase, initAuth } from './supabase.js'
import { makeSupabaseStore } from './storeSupabase.js'

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

// The original IndexedDB impl, unchanged — the signed-out backend and the home
// of device-local keys. Exported for the one-time account migration, which reads
// local data directly regardless of which backend is active.
export const idbStore = {
  get(collection, key) {
    return tx(collection, 'readonly', (os) => os.get(key))
  },
  put(collection, key, value) {
    return tx(collection, 'readwrite', (os) => os.put(value, key))
  },
  all(collection) {
    return tx(collection, 'readonly', (os) => os.getAll())
  },
  delete(collection, key) {
    return tx(collection, 'readwrite', (os) => os.delete(key))
  },
  clear(collection) {
    return tx(collection, 'readwrite', (os) => os.clear())
  },
}

// [key, value] pairs for one local collection — the migration needs keys, which
// getAll() alone doesn't give. Two reads in one readonly tx keeps them aligned.
export function idbEntries(collection) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(collection, 'readonly')
        const os = transaction.objectStore(collection)
        const keysReq = os.getAllKeys()
        const valsReq = os.getAll()
        transaction.oncomplete = () => resolve(keysReq.result.map((k, i) => [k, valsReq.result[i]]))
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }),
  )
}

// --- device-local routing ---

// Keys that must never reach the cloud backend. libraryHandle is a
// FileSystemDirectoryHandle: structured-clone-only, meaningless off this device.
const DEVICE_LOCAL_KEYS = new Set(['libraryHandle'])

export function isDeviceLocal(collection, key) {
  return collection === 'profile' && DEVICE_LOCAL_KEYS.has(key)
}

// --- the facade ---

// Set by initStore() when a session exists; null means signed out → IndexedDB.
let _cloud = null

// Resolve auth and pick the backend. Must complete before the first store read —
// App's boot effect awaits it ahead of getProfile()/loadDomains().
export async function initStore() {
  const user = await initAuth()
  _cloud = user ? makeSupabaseStore({ client: supabase, userId: user.id }) : null
  return user
}

function backend() {
  return _cloud || idbStore
}

export const store = {
  // Read one record by key. Resolves to the value or undefined.
  get(collection, key) {
    return isDeviceLocal(collection, key) ? idbStore.get(collection, key) : backend().get(collection, key)
  },

  // Write one record under key.
  put(collection, key, value) {
    return isDeviceLocal(collection, key) ? idbStore.put(collection, key, value) : backend().put(collection, key, value)
  },

  // Read every record in a collection as an array (values only). Signed in, this
  // reads the cloud — device-local keys live only in IndexedDB, so they never
  // appear here (nothing depends on them appearing; library.js gets the handle by key).
  all(collection) {
    return backend().all(collection)
  },

  // Delete one record by key.
  delete(collection, key) {
    return isDeviceLocal(collection, key) ? idbStore.delete(collection, key) : backend().delete(collection, key)
  },

  // Empty a collection. Signed in, clearing `profile` also clears the device-local
  // slot so "erase everything" can't leave a stale folder handle behind — parity
  // with what the signed-out clear has always done.
  clear(collection) {
    if (_cloud && collection === 'profile') {
      return Promise.all([_cloud.clear(collection), idbStore.clear(collection)]).then(() => undefined)
    }
    return backend().clear(collection)
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
