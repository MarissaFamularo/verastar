// storeSupabase.test.js — locks the cloud impl to the store.js contract: same five
// methods, `get` resolves value-or-undefined, `all` resolves a values array, every
// query scoped to (user_id, collection[, key]), and upserts stamp updated_at so
// last-write-wins actually advances. Runs against a fake PostgREST builder — the
// point is the mapping, not the network.

import { describe, it, expect } from 'vitest'
import { makeSupabaseStore, kvRow } from './storeSupabase.js'

// Minimal chainable stand-in for supabase-js's query builder: records every op,
// resolves the canned response when awaited.
function makeFakeClient(response = { data: null, error: null }) {
  const calls = []
  const client = {
    calls,
    response,
    from(table) {
      const call = { table, ops: [] }
      calls.push(call)
      const builder = {
        select: (cols) => { call.ops.push(['select', cols]); return builder },
        upsert: (rows) => { call.ops.push(['upsert', rows]); return builder },
        delete: () => { call.ops.push(['delete']); return builder },
        eq: (col, val) => { call.ops.push(['eq', col, val]); return builder },
        maybeSingle: () => { call.ops.push(['maybeSingle']); return builder },
        then: (onOk, onErr) => Promise.resolve(client.response).then(onOk, onErr),
      }
      return builder
    },
  }
  return client
}

const USER = 'user-uuid-1'
const cloudStore = (client) => makeSupabaseStore({ client, userId: USER })

const opNames = (call) => call.ops.map(([name]) => name)
const eqs = (call) => Object.fromEntries(call.ops.filter(([n]) => n === 'eq').map(([, col, val]) => [col, val]))

describe('kvRow', () => {
  it('builds the upsert row with an explicit updated_at', () => {
    const row = kvRow(USER, 'papers', '12345', { title: 'BASIL-3' }, '2026-07-21T12:00:00.000Z')
    expect(row).toEqual({
      user_id: USER,
      collection: 'papers',
      key: '12345',
      value: { title: 'BASIL-3' },
      updated_at: '2026-07-21T12:00:00.000Z',
    })
  })

  it('stamps now as an ISO timestamp by default', () => {
    const row = kvRow(USER, 'papers', 'k', 1)
    expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at)
  })
})

describe('get', () => {
  it('resolves the stored value when the row exists', async () => {
    const client = makeFakeClient({ data: { value: { title: 'BEST-CLI' } }, error: null })
    await expect(cloudStore(client).get('papers', '99')).resolves.toEqual({ title: 'BEST-CLI' })
    const call = client.calls[0]
    expect(call.table).toBe('kv')
    expect(eqs(call)).toEqual({ user_id: USER, collection: 'papers', key: '99' })
    expect(opNames(call)).toContain('maybeSingle')
  })

  it('resolves undefined (not null) when the row is missing — the IDB contract', async () => {
    const client = makeFakeClient({ data: null, error: null })
    await expect(cloudStore(client).get('profile', 'me')).resolves.toBeUndefined()
  })

  it('preserves falsy stored values instead of collapsing them to undefined', async () => {
    const client = makeFakeClient({ data: { value: 0 }, error: null })
    await expect(cloudStore(client).get('papers', 'zero')).resolves.toBe(0)
  })

  it('rejects with the server message on error', async () => {
    const client = makeFakeClient({ data: null, error: { message: 'JWT expired' } })
    await expect(cloudStore(client).get('papers', '1')).rejects.toThrow(/JWT expired/)
  })
})

describe('put', () => {
  it('upserts one fully-scoped row with a fresh updated_at', async () => {
    const client = makeFakeClient({ data: null, error: null })
    await cloudStore(client).put('digests', 'daily:latest', { kind: 'daily' })
    const [op, row] = client.calls[0].ops[0]
    expect(op).toBe('upsert')
    expect(row.user_id).toBe(USER)
    expect(row.collection).toBe('digests')
    expect(row.key).toBe('daily:latest')
    expect(row.value).toEqual({ kind: 'daily' })
    expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at)
  })

  it('rejects on error', async () => {
    const client = makeFakeClient({ data: null, error: { message: 'RLS violation' } })
    await expect(cloudStore(client).put('papers', '1', {})).rejects.toThrow(/RLS violation/)
  })
})

describe('all', () => {
  it('resolves values only, in an array', async () => {
    const client = makeFakeClient({ data: [{ value: { id: 'a' } }, { value: { id: 'b' } }], error: null })
    await expect(cloudStore(client).all('papers')).resolves.toEqual([{ id: 'a' }, { id: 'b' }])
    expect(eqs(client.calls[0])).toEqual({ user_id: USER, collection: 'papers' })
  })

  it('resolves [] for an empty collection', async () => {
    const client = makeFakeClient({ data: [], error: null })
    await expect(cloudStore(client).all('graphEdges')).resolves.toEqual([])
  })
})

describe('delete / clear', () => {
  it('delete removes exactly one keyed row', async () => {
    const client = makeFakeClient({ data: null, error: null })
    await cloudStore(client).delete('papers', '42')
    const call = client.calls[0]
    expect(opNames(call)).toContain('delete')
    expect(eqs(call)).toEqual({ user_id: USER, collection: 'papers', key: '42' })
  })

  it('clear scopes to the whole collection but never beyond the user', async () => {
    const client = makeFakeClient({ data: null, error: null })
    await cloudStore(client).clear('digests')
    const call = client.calls[0]
    expect(opNames(call)).toContain('delete')
    expect(eqs(call)).toEqual({ user_id: USER, collection: 'digests' })
  })
})
