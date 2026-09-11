// migrate.test.js — the one-time local → account move. Locks the two rules that
// matter: device-local keys (the folder handle) never reach the cloud, and the
// offer appears only when local data meets an empty account (cloud wins otherwise).

import { describe, it, expect } from 'vitest'
import { migrationRows, shouldOfferMigration, chunk, jsonSafe, MIGRATION_BATCH_SIZE } from './migrate.js'
import { isDeviceLocal, COLLECTIONS, SEEN_KEY } from './store.js'

const USER = 'user-uuid-1'
const NOW = '2026-07-21T12:00:00.000Z'

describe('isDeviceLocal', () => {
  it('flags only the profile libraryHandle slot', () => {
    expect(isDeviceLocal('profile', 'libraryHandle')).toBe(true)
    expect(isDeviceLocal('profile', 'me')).toBe(false)
    expect(isDeviceLocal('papers', 'libraryHandle')).toBe(false)
  })
})

describe('migrationRows', () => {
  it('maps every collection entry to a scoped kv row', () => {
    const rows = migrationRows(
      {
        profile: [['me', { name: 'Dr. F', onboarded: true }]],
        papers: [['111', { id: '111' }], ['222', { id: '222' }]],
      },
      USER,
      NOW,
    )
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ user_id: USER, collection: 'profile', key: 'me', value: { name: 'Dr. F', onboarded: true }, updated_at: NOW })
    expect(rows.map((r) => `${r.collection}:${r.key}`)).toEqual(['profile:me', 'papers:111', 'papers:222'])
  })

  it('never migrates the device-local folder handle', () => {
    const rows = migrationRows(
      { profile: [['me', { onboarded: true }], ['libraryHandle', { kind: 'directory' }]] },
      USER,
      NOW,
    )
    expect(rows.map((r) => r.key)).toEqual(['me'])
  })

  it('skips values that cannot survive JSON instead of failing the whole move', () => {
    const circular = {}
    circular.self = circular
    const rows = migrationRows({ papers: [['ok', { id: 'ok' }], ['bad', circular], ['und', undefined]] }, USER, NOW)
    expect(rows.map((r) => r.key)).toEqual(['ok'])
  })

  it('stringifies non-string IDB keys', () => {
    const rows = migrationRows({ digests: [[20260721, { kind: 'daily' }]] }, USER, NOW)
    expect(rows[0].key).toBe('20260721')
  })

  it('tolerates missing collections', () => {
    expect(migrationRows({ papers: undefined }, USER, NOW)).toEqual([])
  })

  // The migration walks COLLECTIONS, so a new collection is carried the moment it is
  // declared — this locks that the seen ledger is declared and survives the move. Losing
  // it on sign-in would resurface every paper she has already been shown.
  it('carries the cross-day seen ledger into the account', () => {
    expect(COLLECTIONS).toContain('seen')
    const ledger = { ids: { 111: '2026-07-20' }, updatedAt: '2026-07-20' }
    const rows = migrationRows({ seen: [[SEEN_KEY, ledger]] }, USER, NOW)
    expect(rows).toEqual([{ user_id: USER, collection: 'seen', key: 'pmids', value: ledger, updated_at: NOW }])
  })
})

describe('jsonSafe', () => {
  it('accepts plain data, rejects undefined and circular structures', () => {
    expect(jsonSafe({ a: 1 })).toBe(true)
    expect(jsonSafe(0)).toBe(true)
    expect(jsonSafe(null)).toBe(true)
    expect(jsonSafe(undefined)).toBe(false)
    const c = {}
    c.self = c
    expect(jsonSafe(c)).toBe(false)
  })
})

describe('chunk', () => {
  it('splits rows into batch-sized groups without dropping any', () => {
    const rows = Array.from({ length: MIGRATION_BATCH_SIZE * 2 + 1 }, (_, i) => i)
    const batches = chunk(rows)
    expect(batches).toHaveLength(3)
    expect(batches[2]).toEqual([MIGRATION_BATCH_SIZE * 2])
    expect(batches.flat()).toEqual(rows)
  })
})

describe('shouldOfferMigration', () => {
  const base = { localPapersCount: 0, localProfile: null, cloudProfile: null, cloudPapersCount: 0 }

  it('offers when local papers meet an empty cloud', () => {
    expect(shouldOfferMigration({ ...base, localPapersCount: 12 })).toBe(true)
  })

  it('offers when only an onboarded local profile exists (fresh setup, nothing saved yet)', () => {
    expect(shouldOfferMigration({ ...base, localProfile: { onboarded: true } })).toBe(true)
  })

  it('offers recovery despite an existing cloud or starter library', () => {
    expect(shouldOfferMigration({ ...base, localPapersCount: 12, cloudPapersCount: 40 })).toBe(true)
    expect(shouldOfferMigration({ ...base, localPapersCount: 12, cloudProfile: { onboarded: true } })).toBe(true)
  })

  it('never offers when this browser has nothing to move', () => {
    expect(shouldOfferMigration(base)).toBe(false)
    expect(shouldOfferMigration({ ...base, localProfile: { onboarded: false } })).toBe(false)
  })
})

// Exercise the exported importer across real pause/resume boundaries.
describe('resumable migration orchestration', () => {
  function fixture() {
    let progress
    let signedIn = USER
    let calls = 0
    let failSecond = true
    const cloud = new Map([['papers:0', { id:'0', notes:'cloud edit' }]])
    const state = async (userId, patch) => {
      if (patch) {
        if(progress && progress.userId!==userId) throw new Error('other account')
        progress = progress ? {...progress,...patch} : {...patch,userId}
      }
      return progress
    }
    const client={
      auth:{getUser:async()=>({data:{user:{id:signedIn}}})},
      rpc:async(name,{p_rows})=>{
        calls++
        if(calls===2 && failSecond) return {error:{message:'offline'}}
        for(const r of p_rows) if(!cloud.has(`${r.collection}:${r.key}`)) cloud.set(`${r.collection}:${r.key}`,r.value)
        return {data:p_rows.length}
      },
    }
    return {client,state,cloud,entries:async(c)=>c==='papers'?Array.from({length:401},(_,i)=>[String(i),{id:String(i),notes:'local'}]):[], progress:()=>progress, resume:()=>{failSecond=false}, switch:()=>{signedIn='other'} }
  }
  it('batch-two failure remains offered, reload resumes, cloud edits survive, retries do not duplicate', async()=>{
    const f=fixture()
    const {migrateLocalToAccount}=await import('./migrate.js')
    await expect(migrateLocalToAccount({...f,userId:USER})).rejects.toThrow(/paused/)
    expect(f.progress().nextBatch).toBe(1)
    expect(shouldOfferMigration({userId:USER,progress:f.progress(),cloudPapersCount:200})).toBe(true)
    f.resume()
    await migrateLocalToAccount({...f,userId:USER})
    await migrateLocalToAccount({...f,userId:USER})
    expect(f.cloud.size).toBe(401)
    expect(f.cloud.get('papers:0').notes).toBe('cloud edit')
    expect(f.progress().complete).toBe(true)
  })
  it('a different account cannot resume or import the claimed browser library', async()=>{
    const f=fixture();const {migrateLocalToAccount}=await import('./migrate.js')
    await expect(migrateLocalToAccount({...f,userId:USER})).rejects.toThrow(/paused/)
    f.switch()
    await expect(migrateLocalToAccount({...f,userId:USER})).rejects.toThrow(/Account changed/)
    await expect(migrateLocalToAccount({...f,userId:'other'})).rejects.toThrow(/another account/)
    expect(shouldOfferMigration({userId:'other',progress:f.progress(),localPapersCount:401})).toBe(false)
  })
})
