import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { handleGmailCanonicalOtp, safeRedirect, MAX_VERIFY_FAILURES } from '../../supabase/functions/gmail-canonical-otp/handler.js'

const STORED = 'jane.doe@gmail.com'
const TICKET = '11111111-1111-4111-8111-111111111111'
const VERIFY = '22222222-2222-4222-8222-222222222222'

function request(body) {
  return new Request('https://example.test/gmail-canonical-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deps(overrides = {}) {
  return {
    takeSend: vi.fn(async () => STORED),
    keepVerify: vi.fn(async () => VERIFY),
    readVerify: vi.fn(async () => STORED),
    consumeVerify: vi.fn(async () => {}),
    failVerify: vi.fn(async () => MAX_VERIFY_FAILURES - 1),
    sendOtp: vi.fn(async () => ({ ok: true })),
    verifyOtp: vi.fn(async () => ({ access_token: 'access-token', refresh_token: 'refresh-token' })),
    ...overrides,
  }
}

describe('gmail canonical otp', () => {
  it('sends to the stored account and returns only a verify ticket', async () => {
    const bound = deps()
    const res = await handleGmailCanonicalOtp(request({
      action: 'send',
      ticket: TICKET,
      email: 'jane.doe+notes@gmail.com',
      redirectTo: 'https://verastar.papertrellis.com/app',
    }), bound)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ sent: true, verifyTicket: VERIFY })
    expect(JSON.stringify(body)).not.toContain(STORED)
    expect(JSON.stringify(body)).not.toContain('notes')
    expect(bound.takeSend).toHaveBeenCalledWith(TICKET)
    expect(bound.sendOtp).toHaveBeenCalledWith(STORED, 'https://verastar.papertrellis.com', '')
    expect(bound.keepVerify).toHaveBeenCalledWith(STORED)
  })

  it('does not send when the ticket is unknown', async () => {
    const bound = deps({ takeSend: vi.fn(async () => '') })
    const res = await handleGmailCanonicalOtp(request({ action: 'send', ticket: TICKET }), bound)
    expect(res.status).toBe(400)
    expect(bound.sendOtp).not.toHaveBeenCalled()
    expect(JSON.stringify(await res.json())).not.toContain('@')
  })

  it('returns session tokens without the stored address', async () => {
    const bound = deps()
    const res = await handleGmailCanonicalOtp(request({
      action: 'verify',
      verifyTicket: VERIFY,
      code: '123456',
      email: STORED,
    }), bound)
    const body = await res.json()
    expect(body).toEqual({ access_token: 'access-token', refresh_token: 'refresh-token' })
    expect(JSON.stringify(body)).not.toContain(STORED)
    expect(bound.verifyOtp).toHaveBeenCalledWith(STORED, '123456')
    expect(bound.consumeVerify).toHaveBeenCalledWith(VERIFY)
  })

  it('reports an invalid code without the stored address', async () => {
    const bound = deps({ verifyOtp: vi.fn(async () => null) })
    const res = await handleGmailCanonicalOtp(request({ action: 'verify', verifyTicket: VERIFY, code: '000000' }), bound)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body).toEqual({ status: 'invalid' })
    expect(JSON.stringify(body)).not.toContain(STORED)
    expect(bound.consumeVerify).not.toHaveBeenCalled()
  })

  // A ticket-backed counter, as the migration keeps it: the fifth miss deletes the ticket.
  function ticketStore() {
    const tickets = new Map([[VERIFY, { email: STORED, failures: 0 }]])
    return {
      tickets,
      readVerify: vi.fn(async (t) => tickets.get(t)?.email || ''),
      consumeVerify: vi.fn(async (t) => { tickets.delete(t) }),
      failVerify: vi.fn(async (t) => {
        const row = tickets.get(t)
        if (!row) return 0
        row.failures += 1
        if (row.failures >= MAX_VERIFY_FAILURES) { tickets.delete(t); return 0 }
        return MAX_VERIFY_FAILURES - row.failures
      }),
    }
  }
  const verify = (code) => request({ action: 'verify', verifyTicket: VERIFY, code })

  it('counts each wrong code on the ticket and burns it at the fifth; the sixth never reaches Auth', async () => {
    const store = ticketStore()
    const bound = deps({ ...store, verifyOtp: vi.fn(async () => null) })
    const statuses = []
    for (let i = 0; i < MAX_VERIFY_FAILURES; i++) statuses.push((await (await handleGmailCanonicalOtp(verify('000000'), bound)).json()).status)
    expect(statuses).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'locked'])
    expect(bound.failVerify).toHaveBeenCalledTimes(MAX_VERIFY_FAILURES)
    expect(bound.verifyOtp).toHaveBeenCalledTimes(MAX_VERIFY_FAILURES)
    expect(store.tickets.has(VERIFY)).toBe(false)
    const sixth = await handleGmailCanonicalOtp(verify('123456'), bound)
    expect(sixth.status).toBe(400)
    expect(await sixth.json()).toEqual({ status: 'invalid' })
    expect(bound.verifyOtp).toHaveBeenCalledTimes(MAX_VERIFY_FAILURES)
    expect(bound.failVerify).toHaveBeenCalledTimes(MAX_VERIFY_FAILURES)
  })

  it('a right code after some misses still signs in and clears the ticket', async () => {
    const store = ticketStore()
    let calls = 0
    const bound = deps({ ...store, verifyOtp: vi.fn(async () => (++calls < 3 ? null : { access_token: 'a', refresh_token: 'r' })) })
    await handleGmailCanonicalOtp(verify('000000'), bound)
    await handleGmailCanonicalOtp(verify('000001'), bound)
    const res = await handleGmailCanonicalOtp(verify('123456'), bound)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access_token: 'a', refresh_token: 'r' })
    expect(store.tickets.has(VERIFY)).toBe(false)
  })

  it('a counter that cannot be recorded burns the ticket instead of allowing unlimited tries', async () => {
    const bound = deps({ verifyOtp: vi.fn(async () => null), failVerify: vi.fn(async () => { throw new Error('db down') }) })
    const res = await handleGmailCanonicalOtp(verify('000000'), bound)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ status: 'locked' })
    expect(bound.consumeVerify).toHaveBeenCalledWith(VERIFY)
    const nothing = deps({ verifyOtp: vi.fn(async () => null), failVerify: vi.fn(async () => undefined) })
    expect(await (await handleGmailCanonicalOtp(verify('000000'), nothing)).json()).toEqual({ status: 'locked' })
  })

  it('the locked answer carries no address and a right code does not touch the counter', async () => {
    const bound = deps()
    await handleGmailCanonicalOtp(verify('123456'), bound)
    expect(bound.failVerify).not.toHaveBeenCalled()
    const locked = await (await handleGmailCanonicalOtp(verify('000000'), deps({ verifyOtp: vi.fn(async () => null), failVerify: vi.fn(async () => 0) }))).json()
    expect(JSON.stringify(locked)).not.toContain('@')
  })

  it('keeps redirects to an origin and refuses other targets', () => {
    expect(safeRedirect('https://verastar.papertrellis.com/settings')).toBe('https://verastar.papertrellis.com')
    expect(safeRedirect('javascript:alert(1)')).toBe('')
    expect(safeRedirect('https://user:pass@evil.test')).toBe('')
  })

  it('sends the code with account creation off and does not return a user', () => {
    const src = readFileSync('supabase/functions/gmail-canonical-otp/index.ts', 'utf8')
    expect(src).toContain('shouldCreateUser: false')
    expect(src).toContain("rpc('gmail_alias_take_send'")
    expect(src).toContain("rpc('gmail_alias_fail_verify'")
    expect(src).toContain('access_token: data.session.access_token')
    expect(src).not.toContain('session.user')
  })
})
