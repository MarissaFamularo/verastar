import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { handleGmailCanonicalOtp, safeRedirect } from '../../supabase/functions/gmail-canonical-otp/handler.js'

const STORED = 'famularo.marissa@gmail.com'
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
      email: 'famularo.marissa+notes@gmail.com',
      redirectTo: 'https://verastar.papertrellis.com/app',
    }), bound)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ sent: true, verifyTicket: VERIFY })
    expect(JSON.stringify(body)).not.toContain(STORED)
    expect(JSON.stringify(body)).not.toContain('notes')
    expect(bound.takeSend).toHaveBeenCalledWith(TICKET)
    expect(bound.sendOtp).toHaveBeenCalledWith(STORED, 'https://verastar.papertrellis.com')
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

  it('keeps redirects to an origin and refuses other targets', () => {
    expect(safeRedirect('https://verastar.papertrellis.com/settings')).toBe('https://verastar.papertrellis.com')
    expect(safeRedirect('javascript:alert(1)')).toBe('')
    expect(safeRedirect('https://user:pass@evil.test')).toBe('')
  })

  it('sends the code with account creation off and does not return a user', () => {
    const src = readFileSync('supabase/functions/gmail-canonical-otp/index.ts', 'utf8')
    expect(src).toContain('shouldCreateUser: false')
    expect(src).toContain("rpc('gmail_alias_take_send'")
    expect(src).toContain('access_token: data.session.access_token')
    expect(src).not.toContain('session.user')
  })
})
