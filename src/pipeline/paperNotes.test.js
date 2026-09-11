import { it, expect, vi } from 'vitest'
import { makeSupabaseStore } from '../lib/storeSupabase.js'
const facade = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('../lib/store.js', () => ({ store: facade, getProfile: async () => ({}) }))
vi.mock('../lib/events.js', () => ({ logEvent: vi.fn() }))
import { setPaperNote } from './save.js'

it('save-prompt baseline rejects a note changed while drafting through the actual cloud writer', async () => {
  let current = { id: '1', notes: 'first', finding: 'evidence' }
  const client = {
    from() {
      const query = { select:()=>query, eq:()=>query, maybeSingle:async()=>({data:{value:{...current}}}) }
      return query
    },
    async rpc(_name, args) {
      if (args.p_expected.notes !== current.notes) return {data:{status:'conflict'}}
      current={...current,...args.p_value}
      return {data:{status:'linked',value:current}}
    },
  }
  const cloud=makeSupabaseStore({client,userId:'alice'})
  facade.get.mockImplementation(cloud.get)
  facade.put.mockImplementation(cloud.put)
  const promptBaseline=await cloud.get('papers','1')
  current={...current,notes:'another device'}
  await expect(setPaperNote('1','my unfinished draft',promptBaseline)).rejects.toThrow(/another tab/)
  expect(current.notes).toBe('another device')
  expect(facade.get).not.toHaveBeenCalled()
})
