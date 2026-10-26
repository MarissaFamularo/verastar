import { beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ sponsored: true, row: null, upserts: [], upsertError: null }))
vi.mock('./supabase.js', () => ({
  supabaseConfigured: true,
  isSignedIn: () => true,
  currentUser: () => ({ id: 'user-1' }),
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: flags.row, error: null }) }) }),
      upsert: async (row) => {
        if (flags.upsertError) return { error: flags.upsertError }
        flags.upserts.push(row)
        flags.row = row
        return { error: null }
      },
    }),
  },
}))
vi.mock('./sponsor.js', () => ({ isSponsored: () => flags.sponsored, CAP_MESSAGE: 'cap message.' }))

const { browserTimezone, digestRefusalMessage, runScheduledDigestNow } = await import('./digestSchedule.js')

beforeEach(() => {
  flags.sponsored = true
  flags.row = null
  flags.upserts = []
  flags.upsertError = null
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ran: true, phase: 'reading' }) })))
})

describe('digest refusal copy', () => {
  it('says why a run did not start, and keeps an unknown server reason', () => {
    expect(digestRefusalMessage('nothing due')).toMatch(/No digest schedule is turned on/)
    expect(digestRefusalMessage("today's digest already exists")).toMatch(/already here/)
    expect(digestRefusalMessage('already running')).toMatch(/already being prepared/)
    expect(digestRefusalMessage('spending stopped: unresolved_liability')).toMatch(/held for a quick review/)
    expect(digestRefusalMessage('spending stopped: overrun_review')).toMatch(/billing check/)
    expect(digestRefusalMessage('spending stopped: spending_paused')).toMatch(/paused right now/)
    expect(digestRefusalMessage('spending stopped: cap_day')).toMatch(/read a lot today/)
    expect(digestRefusalMessage('attempt cap reached')).toMatch(/several times today/)
    for (const r of ['spending stopped: unresolved_liability', 'spending stopped: overrun_review', 'spending stopped: cap_day', 'attempt cap reached']) expect(digestRefusalMessage(r)).not.toMatch(/\$|\d/)
    expect(digestRefusalMessage('schedules unavailable')).toMatch(/schedules unavailable/)
    expect(digestRefusalMessage(undefined)).toMatch(/did not start a run/)
  })
})

describe('run now without a saved schedule', () => {
  it('creates the default enabled schedule, then asks the server to run', async () => {
    const out = await runScheduledDigestNow()
    expect(out).toMatchObject({ ran: true, phase: 'reading' })
    expect(flags.upserts).toEqual([{ user_id: 'user-1', enabled: true, hour_local: 6, timezone: browserTimezone(), email_digest: true }])
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://example.supabase.co/functions/v1/digest-run')
    expect(JSON.parse(init.body)).toEqual({ timezone: browserTimezone() })
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('does not turn a saved schedule back on, and still reports the server reason', async () => {
    flags.row = { enabled: false, hour_local: 7, timezone: 'America/Chicago' }
    fetch.mockResolvedValue({ ok: true, json: async () => ({ ran: false, reason: 'nothing due' }) })
    const out = await runScheduledDigestNow({ days: 7 })
    expect(flags.upserts).toEqual([])
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ days: 7, timezone: browserTimezone() })
    expect(digestRefusalMessage(out.reason)).toMatch(/No digest schedule is turned on/)
  })

  it('still calls the server when the schedule write fails', async () => {
    flags.upsertError = { message: 'rls' }
    const out = await runScheduledDigestNow()
    expect(out.ran).toBe(true)
    expect(flags.upserts).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an account that cannot schedule', async () => {
    flags.sponsored = false
    expect(await runScheduledDigestNow()).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('runScheduledDigestNow failures', () => {
  it('carries the HTTP status and the server reason on the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ status: 'paused' }) })))
    const err = await runScheduledDigestNow().catch((e) => e)
    expect(err.status).toBe(503)
    expect(err.reason).toBe('paused')
  })
  it('a network failure stays a TypeError with no status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await runScheduledDigestNow().catch((e) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err.status).toBeUndefined()
  })
})
