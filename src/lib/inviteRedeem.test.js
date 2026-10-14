import { beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('./supabase.js', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } },
  supabaseConfigured: true,
  isSignedIn: () => true,
}))
vi.mock('./sponsor.js', () => ({ refreshSponsorship: (...args) => flags.refresh(...args), isSponsored: () => true, markSponsored: () => {} }))

const { redeemInviteCode } = await import('./inviteCode.js')

function respond(status, body) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })))
}

beforeEach(() => {
  flags.refresh.mockReset()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
})

describe('redeem invite responses', () => {
  it('treats the NPI gate as the next step, including the old HTTP 403, and never as enrollment', async () => {
    respond(403, { status: 'npi_required' })
    expect(await redeemInviteCode('beta')).toEqual({ status: 'npi_required', cohort: null })
    respond(200, { status: 'npi_required' })
    expect(await redeemInviteCode(' friends-1 ')).toEqual({ status: 'npi_required', cohort: null })
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ code: 'FRIENDS-1' })
    expect(flags.refresh).not.toHaveBeenCalled()
  })

  it('does not enroll on a non-OK response even if the body says enrolled', async () => {
    respond(403, { status: 'enrolled', cohort: 'beta-2026' })
    expect(await redeemInviteCode('BETA')).toEqual({ status: 'error', cohort: null })
    expect(flags.refresh).not.toHaveBeenCalled()
  })

  it('surfaces a rate limit without a second attempt', async () => {
    respond(429, { status: 'slow_down' })
    expect(await redeemInviteCode('BETA')).toEqual({ status: 'slow_down', cohort: null })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(flags.refresh).not.toHaveBeenCalled()
  })

  it('enrolls only on a 2xx enrolled or already', async () => {
    respond(200, { status: 'enrolled', cohort: 'beta-2026' })
    expect(await redeemInviteCode('BETA')).toEqual({ status: 'enrolled', cohort: 'beta-2026' })
    respond(200, { status: 'already', cohort: 'beta-2026' })
    expect(await redeemInviteCode('BETA')).toEqual({ status: 'already', cohort: 'beta-2026' })
    expect(flags.refresh).toHaveBeenCalledTimes(2)
  })
})
