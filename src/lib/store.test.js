import { it, expect, vi } from 'vitest'
const cloud = vi.hoisted(() => ({ clear: vi.fn(async () => {}) }))
vi.mock('./supabase.js', () => ({ supabase: {}, initAuth: async () => ({ id: 'alice' }) }))
vi.mock('./storeSupabase.js', () => ({ makeSupabaseStore: () => cloud }))
import { store, idbStore, initStore } from './store.js'

it('cloud profile erase removes the folder handle but preserves the local library account claim', async () => {
  const local = new Map([
    ['migrationState', { userId: 'alice', complete: false, rows: [{ collection: 'papers', key: '1' }] }],
    ['libraryHandle', { kind: 'directory' }],
    ['me', { onboarded: true }],
  ])
  const del = vi.spyOn(idbStore, 'delete').mockImplementation(async (_collection, key) => { local.delete(key) })
  const clear = vi.spyOn(idbStore, 'clear').mockImplementation(async () => { local.clear() })
  await initStore()
  await store.clear('profile')
  expect(cloud.clear).toHaveBeenCalledWith('profile')
  expect(local.has('libraryHandle')).toBe(false)
  expect(local.get('migrationState').userId).toBe('alice')
  expect(clear).not.toHaveBeenCalled()
  del.mockRestore(); clear.mockRestore()
})
