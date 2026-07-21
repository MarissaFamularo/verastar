// lib/storeSupabase.js — the cloud storage impl behind the store.js interface.
//
// One generic `kv` table mirrors the collection/key/value shape of the IndexedDB
// stores exactly, so this is a drop-in behind store.js: same five methods, same
// return contracts (`get` resolves value-or-undefined, `all` resolves a values
// array). Conflict policy is last-write-wins on updated_at — fine for one person
// on two devices. RLS scopes every row to auth.uid(); the explicit user_id here
// is required anyway to satisfy the primary key on upsert.

// Build the kv row for an upsert. `updated_at` is stamped client-side because the
// column default only fires on INSERT — an upsert overwrite must refresh it for
// last-write-wins to mean anything.
export function kvRow(userId, collection, key, value, now = new Date().toISOString()) {
  return { user_id: userId, collection, key, value, updated_at: now }
}

export function makeSupabaseStore({ client, userId }) {
  const fail = (op, error) => {
    throw new Error(`Cloud ${op} failed: ${error.message || error}`)
  }
  return {
    get(collection, key) {
      return client
        .from('kv')
        .select('value')
        .eq('user_id', userId)
        .eq('collection', collection)
        .eq('key', key)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) fail('read', error)
          return data ? data.value : undefined
        })
    },

    put(collection, key, value) {
      return client
        .from('kv')
        .upsert(kvRow(userId, collection, key, value))
        .then(({ error }) => {
          if (error) fail('write', error)
        })
    },

    all(collection) {
      return client
        .from('kv')
        .select('value')
        .eq('user_id', userId)
        .eq('collection', collection)
        .then(({ data, error }) => {
          if (error) fail('read', error)
          return (data || []).map((row) => row.value)
        })
    },

    delete(collection, key) {
      return client
        .from('kv')
        .delete()
        .eq('user_id', userId)
        .eq('collection', collection)
        .eq('key', key)
        .then(({ error }) => {
          if (error) fail('delete', error)
        })
    },

    clear(collection) {
      return client
        .from('kv')
        .delete()
        .eq('user_id', userId)
        .eq('collection', collection)
        .then(({ error }) => {
          if (error) fail('clear', error)
        })
    },
  }
}
