// lib/migrate.js — the one-time IndexedDB → account migration on first sign-in.
//
// When someone who already has a local library signs in for the first time, the
// cloud is empty and their papers are in this browser's IndexedDB. App offers
// "Move this library into your account"; this module does the move. Policy
// (locked in the build plan): cloud wins — the offer only appears when the cloud
// is empty, so a second device with stale demo data can never clobber a real
// account library. Device-local keys (the folder handle) never migrate: they are
// structured-clone-only and meaningless on another device.

import { COLLECTIONS, idbEntries, isDeviceLocal } from './store.js'
import { kvRow } from './storeSupabase.js'

// Upserts go up in batches — one giant insert risks payload limits, one row per
// request is needlessly slow for a few hundred papers.
export const MIGRATION_BATCH_SIZE = 200

// Pure: turn local [key, value] entries per collection into kv rows to upsert,
// skipping device-local keys and anything that can't survive JSON (a
// structured-clone object like a FileSystemDirectoryHandle under an unexpected
// key must not break the whole migration).
export function migrationRows(entriesByCollection, userId, now = new Date().toISOString()) {
  const rows = []
  for (const [collection, entries] of Object.entries(entriesByCollection)) {
    for (const [key, value] of entries || []) {
      if (isDeviceLocal(collection, key)) continue
      if (!jsonSafe(value)) continue
      rows.push(kvRow(userId, collection, String(key), value, now))
    }
  }
  return rows
}

export function jsonSafe(value) {
  if (value === undefined) return false
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

export function chunk(rows, size = MIGRATION_BATCH_SIZE) {
  const out = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// Pure: the offer appears only on first sign-in — local library present, cloud
// truly empty (no profile AND no papers). Once they migrate or onboard signed-in,
// the cloud is non-empty and the offer never returns.
export function shouldOfferMigration({ localPapersCount, localProfile, cloudProfile, cloudPapersCount }) {
  const localHasData = localPapersCount > 0 || Boolean(localProfile?.onboarded)
  const cloudEmpty = !cloudProfile && cloudPapersCount === 0
  return localHasData && cloudEmpty
}

// Read every local collection and upsert it into the account. Idempotent: rerunning
// upserts the same primary keys. Resolves to the number of records moved.
export async function migrateLocalToAccount({ client, userId }) {
  const entriesByCollection = {}
  for (const collection of COLLECTIONS) {
    entriesByCollection[collection] = await idbEntries(collection)
  }
  const rows = migrationRows(entriesByCollection, userId)
  for (const batch of chunk(rows)) {
    const { error } = await client.from('kv').upsert(batch)
    if (error) throw new Error(`Moving your library failed: ${error.message}`)
  }
  return rows.length
}
