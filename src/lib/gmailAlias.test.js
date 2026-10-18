import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }))

import { supabase } from './supabase.js'
import {
  GMAIL_ALIAS_LOOKUP_MS,
  gmailAliasDecision,
  gmailCanonicalNote,
  isGmailFamily,
  isMaskedGmailHint,
  lookupGmailAlias,
  prepareGmailAlias,
} from './gmailAlias.js'

const TICKET = '11111111-1111-4111-8111-111111111111'

describe('gmail alias warning', () => {
  it('recognizes only gmail.com and googlemail.com', () => {
    expect(isGmailFamily('Jane.Doe@Gmail.com')).toBe(true)
    expect(isGmailFamily('a+tag@googlemail.com')).toBe(true)
    expect(isGmailFamily('doctor@clinic.edu')).toBe(false)
    expect(isGmailFamily('jane@gmail.com.evil.test')).toBe(false)
  })

  it('accepts a one-character hint and rejects a full address', () => {
    expect(isMaskedGmailHint('j…@gmail.com')).toBe(true)
    expect(isMaskedGmailHint('f…@googlemail.com')).toBe(true)
    expect(isMaskedGmailHint('fa…@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('janedoe@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('f...@gmail.com')).toBe(false)
    expect(isMaskedGmailHint('f…@clinic.edu')).toBe(false)
  })

  it('sends a different spelling to the existing account and stays quiet otherwise', () => {
    const canonical = gmailAliasDecision({ match: true, hint: 'j…@gmail.com', ticket: TICKET })
    expect(canonical).toEqual({
      send: 'canonical',
      note: 'Signing you in as j…@gmail.com (the account already on this inbox)',
      ticket: TICKET,
    })
    expect(gmailCanonicalNote('j…@gmail.com')).toBe(canonical.note)
    expect(gmailAliasDecision({ match: true, hint: 'j…@gmail.com', ticket: TICKET }, { force: true })).toEqual({ send: 'typed', note: '' })
    expect(gmailAliasDecision({ match: true, hint: 'j…@gmail.com' })).toEqual({ send: 'blocked', note: '' })
    expect(gmailAliasDecision({ match: true, hint: 'janedoe@gmail.com', ticket: TICKET })).toEqual({ send: 'typed', note: '' })
    expect(gmailAliasDecision({ match: false })).toEqual({ send: 'typed', note: '' })
    expect(gmailAliasDecision({ match: false, hint: 'j…@gmail.com', email: 'jane.doe@gmail.com' })).toEqual({ send: 'typed', note: '' })
  })

  it('asks the server only for gmail addresses and drops an unsafe hint', async () => {
    supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
    await expect(lookupGmailAlias('doctor@clinic.edu')).resolves.toEqual({ match: false })
    expect(supabase.rpc).not.toHaveBeenCalled()

    supabase.rpc.mockResolvedValue({ data: { match: true, hint: 'j…@gmail.com' }, error: null })
    await expect(lookupGmailAlias('jane.doe+notes@gmail.com')).resolves.toEqual({ match: true, hint: 'j…@gmail.com' })
    expect(supabase.rpc).toHaveBeenCalledWith('gmail_alias_hint', { p_email: 'jane.doe+notes@gmail.com' })

    supabase.rpc.mockResolvedValue({ data: { match: true, hint: 'janedoe@gmail.com', email: 'janedoe@gmail.com' }, error: null })
    await expect(lookupGmailAlias('jane.doe@gmail.com')).resolves.toEqual({ match: false })

    supabase.rpc.mockRejectedValue(new Error('function gmail_alias_hint does not exist'))
    await expect(lookupGmailAlias('jane.doe@googlemail.com')).resolves.toEqual({ match: false })
  })

  it('prepares a gmail spelling and drops any address on the response', async () => {
    supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
    await expect(prepareGmailAlias('doctor@clinic.edu')).resolves.toEqual({ match: false })

    supabase.rpc.mockResolvedValue({
      data: { match: true, hint: 'j…@gmail.com', ticket: TICKET, email: 'jane.doe@gmail.com' },
      error: null,
    })
    await expect(prepareGmailAlias('jane.doe+notes@gmail.com')).resolves.toEqual({
      match: true,
      hint: 'j…@gmail.com',
      ticket: TICKET,
    })
    expect(supabase.rpc).toHaveBeenCalledWith('gmail_alias_prepare', { p_email: 'jane.doe+notes@gmail.com' })

    supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
    await expect(prepareGmailAlias('janedoe@gmail.com')).resolves.toEqual({ match: false })

    supabase.rpc.mockRejectedValue(new Error('function gmail_alias_prepare does not exist'))
    await expect(prepareGmailAlias('jane.doe@gmail.com')).resolves.toEqual({ match: false })
  })

  it('treats a lookup that never returns as no match', async () => {
    vi.useFakeTimers()
    supabase.rpc.mockReturnValue(new Promise(() => {}))
    const pending = lookupGmailAlias('jane.doe@gmail.com')
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
  const sql = readFileSync('supabase/migrations/20261013050000_gmail_alias_hint_audit.sql', 'utf8')
  const body = sql.replace(/--[^\n]*/g, '')

  it('exposes only a definer wrapper and keeps the lookup private', () => {
    expect(body).toMatch(/function private\.gmail_alias_lookup\(p_email text\)[\s\S]*security definer[\s\S]*set search_path = ''/)
    expect(body).toMatch(/function public\.gmail_alias_hint\(p_email text\)[\s\S]*security definer[\s\S]*set search_path = ''/)
    expect(body).toContain('select private.gmail_alias_lookup(p_email)')
    expect(body).toContain('revoke usage on schema private from anon')
    expect(body).toContain('revoke all on function private.gmail_alias_lookup(text) from public, anon')
    expect(body).toContain("jsonb_build_object('match', true, 'hint', v_hint)")
    expect(body).toContain("jsonb_build_object('match', false)")
    expect(body).not.toMatch(/jsonb_build_object\([^)]*email/i)
    expect(body).toContain('v_raw = v_canon')
    expect(body).toContain('v_email_count > 3 or v_ip_count > 8')
    expect(body).toContain("p_headers ->> 'cf-connecting-ip'")
    expect(body).toContain("regexp_replace(v_xff, '^.*,', '')")
    expect(body).not.toContain('x-real-ip')
    expect(body).not.toContain("split_part(coalesce(v_headers ->> 'x-forwarded-for'")
    expect(body).toContain('grant execute on function public.gmail_alias_hint(text) to anon, authenticated, service_role')
  })
})

describe('gmail alias prepare migration', () => {
  const sql = readFileSync('supabase/migrations/20261013120000_gmail_alias_prepare.sql', 'utf8')
  const body = sql.replace(/--[^\n]*/g, '')

  it('keeps the address in a private permit and the same hourly caps', () => {
    expect(body).toMatch(/function private\.gmail_alias_decide\(p_email text, p_issue boolean\)[\s\S]*security definer[\s\S]*set search_path = ''/)
    expect(body).toContain('return private.gmail_alias_decide(p_email, false)')
    expect(body).toContain('select private.gmail_alias_decide(p_email, true)')
    expect(body).toContain('v_email_count > 3 or v_ip_count > 8')
    expect(body).toContain('v_raw = v_canon')
    const exactAt = body.indexOf('lower(pg_catalog.btrim(u.email)) = v_raw')
    const otherAt = body.indexOf('private.gmail_canonical(u.email) = v_canon')
    expect(exactAt).toBeGreaterThan(-1)
    expect(otherAt).toBeGreaterThan(exactAt)
    expect(body.slice(exactAt, otherAt)).toContain("jsonb_build_object('match', false)")
    expect(body).toContain("jsonb_build_object('match', true, 'hint', v_hint, 'ticket', v_ticket)")
    expect(body).not.toMatch(/jsonb_build_object\([^)]*email/i)
    expect(body).toContain('revoke all on function private.gmail_alias_decide(text, boolean) from public, anon, authenticated, service_role')
    expect(body).toContain('revoke all on table private.gmail_alias_permits from public, anon, authenticated, service_role')
    expect(body).toContain('grant execute on function public.gmail_alias_prepare(text) to anon, authenticated, service_role')
    expect(body).toContain('revoke all on function public.gmail_alias_take_send(uuid) from public, anon, authenticated')
    expect(body).toContain('grant execute on function public.gmail_alias_take_send(uuid) to service_role')
    expect(body).toContain('revoke all on function public.gmail_alias_read_verify(uuid) from public, anon, authenticated')
    expect(body).toContain('grant execute on function public.gmail_alias_keep_verify(text) to service_role')
  })
})
