import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendCanonicalGmailCode, verifyCanonicalGmailCode } from './gmailCanonical.js'

const TICKET = '11111111-1111-4111-8111-111111111111'
const VERIFY = '22222222-2222-4222-8222-222222222222'
const STORED = 'famularo.marissa@gmail.com'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('gmail canonical client', () => {
  it('posts the ticket and keeps the stored address off the result', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sent: true, verifyTicket: VERIFY, email: STORED }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendCanonicalGmailCode({
      ticket: TICKET,
      redirectTo: 'https://verastar.papertrellis.com/library',
    })).resolves.toEqual({ ok: true, verifyTicket: VERIFY })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({
      action: 'send',
      ticket: TICKET,
      redirectTo: 'https://verastar.papertrellis.com',
    })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer anon-key')
    expect(JSON.stringify(body)).not.toContain(STORED)
  })

  it('returns only the session tokens from a verified code', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'access',
        refresh_token: 'refresh',
        email: STORED,
        user: { email: STORED },
      }),
    })))
    await expect(verifyCanonicalGmailCode({ verifyTicket: VERIFY, code: '123456' })).resolves.toEqual({
      access_token: 'access',
      refresh_token: 'refresh',
    })
  })
})
