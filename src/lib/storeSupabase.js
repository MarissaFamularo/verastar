import { trackPaper, paperMutation, mutateCloudPaper } from './paperMutation.js'

// lib/storeSupabase.js — the cloud storage impl behind the store.js interface.
//
// One generic `kv` table mirrors the collection/key/value shape of the IndexedDB
// stores exactly, so this is a drop-in behind store.js: same five methods, same
// return contracts (`get` resolves value-or-undefined, `all` resolves a values
// array). Papers use atomic field compare-and-set; other collections retain
// their existing replacement contract. RLS scopes rows; the explicit user_id here
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
          return data ? (collection === 'papers' ? trackPaper(data.value, userId, key) : data.value) : undefined
        })
    },

    async put(collection, key, value, { restoreDeleted = false } = {}) {
      if (collection === 'papers') {
        const mutation = paperMutation(value, userId, key)
        // Only the explicit user Save action may restore a deleted record.
        if (restoreDeleted && mutation.p_action === 'create') mutation.p_action = 'restore'
        const result = await mutateCloudPaper(client, userId, key, mutation)
        if (result?.value) {
          for (const field of Object.keys(value)) delete value[field]
          Object.assign(value, result.value)
          trackPaper(value, userId, key)
        }
        return
      }
      return client
        .from('kv')
        .upsert(kvRow(userId, collection, key, value))
        .then(({ error }) => {
          if (error) fail('write', error)
        })
    },

    // PostgREST caps any single select at 1000 rows and truncates SILENTLY — a graph
    // that crosses 1000 edges would simply lose its newest links from every read (found
    // live: the map said exactly "1000 connections" while the table held more). Page
    // through in key order until a short page proves the end.
    async all(collection) {
      const PAGE = 1000
      const values = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await client
          .from('kv')
          .select(collection === 'papers' ? 'key,value' : 'value')
          .eq('user_id', userId)
          .eq('collection', collection)
          .order('key', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) fail('read', error)
        for (const row of data || []) values.push(collection === 'papers' ? trackPaper(row.value, userId, row.key ?? row.value?.id) : row.value)
        if (!data || data.length < PAGE) return values
      }
    },

    delete(collection, key) {
      if (collection === 'papers') return mutateCloudPaper(client, userId, key, { p_action: 'delete' }).then(() => undefined)
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
      if (collection === 'papers') return mutateCloudPaper(client, userId, '', { p_action: 'clear' }).then(() => undefined)
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
