// lib/inviteCode.test.js — what a friend types vs. what the server is asked about.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: null, supabaseConfigured: false, isSignedIn: () => false }))
vi.mock('./sponsor.js', () => ({ refreshSponsorship: async () => {} }))

const { normalizeInviteCode, INVITE_MESSAGES } = await import('./inviteCode.js')

describe('normalizeInviteCode', () => {
  it('accepts a code typed in lowercase or mixed case', () => {
    expect(normalizeInviteCode('friends-1')).toBe('FRIENDS-1')
    expect(normalizeInviteCode('Friends-1')).toBe('FRIENDS-1')
    expect(normalizeInviteCode('FRIENDS-1')).toBe('FRIENDS-1')
  })

  it('forgives stray spaces and an autocorrected long dash', () => {
    expect(normalizeInviteCode('  friends-1 ')).toBe('FRIENDS-1')
    expect(normalizeInviteCode('friends - 1')).toBe('FRIENDS-1')
    expect(normalizeInviteCode('friends\u20131')).toBe('FRIENDS-1') // en dash
    expect(normalizeInviteCode('friends\u20141')).toBe('FRIENDS-1') // em dash
  })

  it('never throws on junk', () => {
    expect(normalizeInviteCode(null)).toBe('')
    expect(normalizeInviteCode(undefined)).toBe('')
    expect(normalizeInviteCode(42)).toBe('42')
  })
})

describe('redemption states', () => {
  it('every status redeem_sponsor_invite can return has its own message', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync(new URL('../../supabase/migrations/20261009120000_beta_spending_safeguards.sql', import.meta.url), 'utf8')
    const body = sql.slice(sql.indexOf('create or replace function public.redeem_sponsor_invite'))
    const statuses = [...new Set([...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]))]
    expect(statuses.sort()).toEqual(['already', 'enrolled', 'exhausted', 'expired', 'full', 'inactive', 'invalid', 'paused', 'revoked'])
    for (const s of statuses) expect(INVITE_MESSAGES[s]).toBeTruthy()
    expect(INVITE_MESSAGES.invalid).toMatch(/not recognized/i)
    expect(INVITE_MESSAGES.exhausted).toMatch(/used up/i)
    expect(INVITE_MESSAGES.slow_down).toMatch(/too many attempts/i)
  })
})
