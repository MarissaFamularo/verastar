import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }))

import { supabase } from './supabase.js'
import {
  GMAIL_ALIAS_LOOKUP_MS,
  gmailAliasDecision,
  gmailAliasWarning,
  isGmailFamily,
  isMaskedGmailHint,
  lookupGmailAlias,
} from './gmailAlias.js'

describe('gmail alias warning', () => {
  it('recognizes only gmail.com and googlemail.com', () => {
    expect(isGmailFamily('Famularo.Marissa@Gmail.com')).toBe(true)
    expect(isGmailFamily('a+tag@googlemail.com')).toBe(true)
    expect(isGmailFamily('doctor@clinic.edu')).toBe(false)
    expect(isGmailFamily('famularo@gmail.com.evil.test')).toBe(false)
  })

  it('accepts a one-character hint and rejects a full address', () => {
    expect(isMaskedGmailHint('f…@gmail.com')).toBe(true)
    expect(isMaskedGmailHint('f…@googlemail.com')).toBe(true)
    expect(isMaskedGmailHint('fa…@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('famularomarissa@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('f...@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('f…@clinic.edu')).toBe(false)
  })

  it('warns with the masked hint and does not send until asked', () => {
    const blocked = gmailAliasDecision({ match: true, hint: 'f…@gmail.com' })
    expect(blocked).toEqual({
      send: false,
      warning: 'You already have an account as f…@gmail.com; sign in with that address?',
    })
    expect(gmailAliasWarning('f…@gmail.com')).toBe(blocked.warning)
    expect(gmailAliasDecision({ match: true, hint: 'f…@gmail.com' }, { force: true })).toEqual({ send: true, warning: '' })
    expect(gmailAliasDecision({ match: true, hint: 'famularomarissa@gmail.com' })).toEqual({ send: true, warning: '' })
    expect(gmailAliasDecision({ match: false })).toEqual({ send: true, warning: '' })
  })

  it('asks the server only for gmail addresses and drops an unsafe hint', async () => {
    supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
    await expect(lookupGmailAlias('doctor@clinic.edu')).resolves.toEqual({ match: false })
    expect(supabase.rpc).not.toHaveBeenCalled()

    supabase.rpc.mockResolvedValue({ data: { match: true, hint: 'f…@gmail.com' }, error: null })
    await expect(lookupGmailAlias('famularo.marissa+notes@gmail.com')).resolves.toEqual({ match: true, hint: 'f…@gmail.com' })
    expect(supabase.rpc).toHaveBeenCalledWith('gmail_alias_hint', { p_email: 'famularo.marissa+notes@gmail.com' })

    supabase.rpc.mockResolvedValue({ data: { match: true, hint: 'famularomarissa@gmail.com', email: 'famularomarissa@gmail.com' }, error: null })
    await expect(lookupGmailAlias('famularo.marissa@gmail.com')).resolves.toEqual({ match: false })

    supabase.rpc.mockRejectedValue(new Error('function gmail_alias_hint does not exist'))
    await expect(lookupGmailAlias('famularo.marissa@googlemail.com')).resolves.toEqual({ match: false })
  })

  it('treats a lookup that never returns as no match', async () => {
    vi.useFakeTimers()
    supabase.rpc.mockReturnValue(new Promise(() => {}))
    const pending = lookupGmailAlias('famularo.marissa@gmail.com')
    let settled = false
    const done = pending.then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(GMAIL_ALIAS_LOOKUP_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toEqual({ match: false })
    expect(GMAIL_ALIAS_LOOKUP_MS).toBeLessThan(8000)
    vi.useRealTimers()
  })
})

describe('gmail alias migration', () => {
  const sql = readFileSync('supabase/migrations/20261012213000_gmail_alias_hint.sql', 'utf8')
  const body = sql.replace(/--[^\n]*/g, '')

  it('keeps the user lookup in a private definer and returns only a boolean plus a mask', () => {
    expect(body).toMatch(/function private\.gmail_alias_lookup\(p_email text\)[\s\S]*security definer[\s\S]*set search_path = ''/)
    expect(body).toMatch(/function public\.gmail_alias_hint\(p_email text\)[\s\S]*security invoker[\s\S]*set search_path = ''/)
    expect(body).not.toMatch(/function public\.gmail_alias_hint[\s\S]*security definer/)
    expect(body).toContain("jsonb_build_object('match', true, 'hint', v_hint)")
    expect(body).toContain("jsonb_build_object('match', false)")
    expect(body).not.toMatch(/jsonb_build_object\([^)]*email/i)
    expect(body).toContain('enable row level security')
    expect(body).toContain('revoke all on table private.gmail_alias_limits from public, anon, authenticated')
    expect(body).toContain('on conflict (bucket) do update')
    expect(body).toContain('returning hits into v_hits')
    expect(body).toContain('revoke all on function private.gmail_alias_hit(text) from public, anon, authenticated')
    expect(body).toContain("v_domain not in ('gmail.com', 'googlemail.com')")
    expect(body).toContain("v_local := replace(v_local, '.', '')")
    expect(body).toContain("v_local := split_part(v_local, '+', 1)")
    expect(body).toContain('v_email_count > 8 or v_ip_count > 20')
    expect(body).not.toContain('gmail_alias_probes')
    expect(body).toContain('grant execute on function public.gmail_alias_hint(text) to anon, authenticated, service_role')
  })
})
