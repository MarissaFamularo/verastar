// lib/inviteCode.test.js — what a friend types vs. what the server is asked about.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: null, supabaseConfigured: false, isSignedIn: () => false }))
vi.mock('./sponsor.js', () => ({ refreshSponsorship: async () => {} }))

const { normalizeInviteCode } = await import('./inviteCode.js')

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
