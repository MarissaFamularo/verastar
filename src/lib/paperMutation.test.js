import { describe, it, expect } from 'vitest'
import { makeSupabaseStore } from './storeSupabase.js'
import { PAPER_BASE } from './paperMutation.js'

// Simulated transport only. Production read and mutation orchestration is used.
function server() {
  const rows = new Map([['1', { id: '1', notes: 'original', finding: 'old', favorite: true, tags: ['a'], trellisProjects: [] }]])
  const deleted = new Set()
  const copy = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
  let caller = 'alice'
  const client = {
    changeAccount(id) { caller = id },
    from() {
      const filters = {}
      const q = {
        select() { return q }, eq(k,v) { filters[k]=v; return q },
        async maybeSingle() { return { data: rows.has(filters.key) ? { value: copy(rows.get(filters.key)) } : null } },
      }
      return q
    },
    async rpc(name, p) {
      if (p.p_user_id !== caller) return { error: { message: 'Account mismatch' } }
      const current = rows.get(p.p_key)
      if (p.p_action === 'delete') { rows.delete(p.p_key); deleted.add(p.p_key); return { data: { status: 'removed' } } }
      if (p.p_action === 'clear') { for(const key of rows.keys()) deleted.add(key); rows.clear(); return { data: { status: 'cleared' } } }
      if (deleted.has(p.p_key) || (!current && p.p_action === 'patch')) return { data: { status: 'deleted' } }
      if (p.p_action === 'create') {
        if (current) return { data: { status: JSON.stringify(current) === JSON.stringify(p.p_value) ? 'unchanged' : 'conflict', value: copy(current) } }
        rows.set(p.p_key, copy(p.p_value))
      } else {
        for (const f of p.p_fields) {
          if (JSON.stringify(current[f]) !== JSON.stringify(p.p_expected[f]) && JSON.stringify(current[f]) !== JSON.stringify(p.p_value[f])) return { data: { status: 'conflict' } }
        }
        for (const f of p.p_fields) {
          if (f in p.p_value) current[f] = copy(p.p_value[f]); else delete current[f]
        }
      }
      return { data: { status: 'linked', value: copy(rows.get(p.p_key)) } }
    },
  }
  return { rows, client, store: makeSupabaseStore({ client, userId: 'alice' }) }
}

describe('actual cloud paper writer concurrency', () => {
  it('keeps interleaved note, refresh, provenance and personal fields', async () => {
    const s=server()
    const note=await s.store.get('papers','1')
    const fresh=await s.store.get('papers','1')
    // Another app appends provenance after both SELECTs.
    s.rows.get('1').trellisProjects.push({ id:'project' })
    await s.store.put('papers','1',{ ...note, notes:'new note' })
    await s.store.put('papers','1',{ ...fresh, finding:'fresh evidence' })
    expect(s.rows.get('1')).toMatchObject({ notes:'new note',finding:'fresh evidence',favorite:true,tags:['a'],trellisProjects:[{id:'project'}] })
  })
  it('rejects a competing same-field edit and permits an exact duplicate retry', async () => {
    const s=server(); const a=await s.store.get('papers','1'); const b=await s.store.get('papers','1')
    const edit={...a,notes:'A'}
    await s.store.put('papers','1',edit)
    await s.store.put('papers','1',edit)
    await expect(s.store.put('papers','1',{...b,notes:'B'})).rejects.toThrow(/another tab/)
    expect(s.rows.get('1').notes).toBe('A')
  })
  it.each(['delete','clear'])('does not resurrect after %s during enrichment', async (action) => {
    const s=server();const pending=await s.store.get('papers','1')
    await s.store[action]('papers','1')
    await expect(s.store.put('papers','1',{...pending,finding:'late'})).rejects.toThrow(/removed/)
    expect(s.rows.size).toBe(0)
  })
  it('denies account-switch writes and transporting another account baseline', async () => {
    const s=server();const p=await s.store.get('papers','1');s.client.changeAccount('bob')
    await expect(s.store.put('papers','1',{...p,notes:'wrong'})).rejects.toThrow(/Account mismatch/)
    const bob=makeSupabaseStore({client:s.client,userId:'bob'})
    await expect(bob.put('papers','1',{...p,notes:'wrong'})).rejects.toThrow(/account changed/)
  })
  it('does not serialize the baseline or replace an existing row without a baseline', async () => {
    const s=server();const p=await s.store.get('papers','1')
    expect(p[PAPER_BASE]).toBeDefined()
    expect(JSON.stringify(p)).not.toContain('baseline')
    await expect(s.store.put('papers','1',{id:'1',notes:'blind'})).rejects.toThrow(/another tab/)
  })
})
