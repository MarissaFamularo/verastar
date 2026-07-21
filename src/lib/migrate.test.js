// migrate.test.js — the one-time local → account move. Locks the two rules that
// matter: device-local keys (the folder handle) never reach the cloud, and the
// offer appears only when local data meets an empty account (cloud wins otherwise).

import { describe, it, expect } from 'vitest'
import { migrationRows, shouldOfferMigration, chunk, jsonSafe, MIGRATION_BATCH_SIZE } from './migrate.js'
import { isDeviceLocal } from './store.js'

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

  it('never offers into a non-empty cloud — cloud wins', () => {
    expect(shouldOfferMigration({ ...base, localPapersCount: 12, cloudPapersCount: 40 })).toBe(false)
    expect(shouldOfferMigration({ ...base, localPapersCount: 12, cloudProfile: { onboarded: true } })).toBe(false)
  })

  it('never offers when this browser has nothing to move', () => {
    expect(shouldOfferMigration(base)).toBe(false)
    expect(shouldOfferMigration({ ...base, localProfile: { onboarded: false } })).toBe(false)
  })
})
