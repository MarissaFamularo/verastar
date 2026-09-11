import { COLLECTIONS, idbEntries, isDeviceLocal, migrationState } from './store.js'
import { kvRow } from './storeSupabase.js'

// Insert-only recovery runs in batches — one giant insert risks payload limits, one row per
// request is needlessly slow for a few hundred papers.
export const MIGRATION_BATCH_SIZE = 200

// Pure: turn local [key, value] entries per collection into kv rows to insert when absent,
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

// A nonempty/seeded cloud is not evidence that this device finished importing.
// The manifest is account-bound and retained on the device after completion.
export function shouldOfferMigration({ localPapersCount, localProfile, userId, progress }) {
  if (progress) return (!userId || progress.userId === userId) && !progress.complete
  return localPapersCount > 0 || Boolean(localProfile?.onboarded)
}

export async function getMigrationProgress(userId) {
  return migrationState(userId)
}

// A frozen manifest makes interrupted batches deterministic across reloads.
// Each batch is insert-only on the server; retry preserves cloud edits and deletes.
// Optional adapters exercise this actual control flow without a browser/network.
export async function migrateLocalToAccount({ client, userId, entries = idbEntries, state = migrationState }) {
  if (!userId) throw new Error('Sign in before moving this library.')
  async function assertAccount() {
    const { data, error } = await client.auth.getUser()
    if (error || data?.user?.id !== userId) throw new Error('Account changed. Sign in to the original account to resume moving this library.')
  }
  await assertAccount()
  let progress = await state(userId)
  if (progress && progress.userId !== userId) throw new Error('This local library is assigned to another account. Sign in to that account to resume.')
  if (progress?.complete) return progress.rows.length
  if (!progress) {
    const entriesByCollection = {}
    for (const collection of COLLECTIONS) entriesByCollection[collection] = await entries(collection)
    await assertAccount()
    progress = await state(userId, { rows: migrationRows(entriesByCollection, userId), nextBatch: 0, complete: false })
  }
  const batches = chunk(progress.rows)
  for (let i = progress.nextBatch; i < batches.length; i++) {
    await assertAccount()
    const { error } = await client.rpc('import_library_batch', { p_user_id: userId, p_rows: batches[i] })
    if (error) throw new Error(`Moving your library paused after ${i} batches. Retry to resume: ${error.message}`)
    await state(userId, { nextBatch: i + 1 })
  }
  await state(userId, { complete: true })
  return progress.rows.length
}
