import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), lookupNpi: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))
vi.mock('../../supabase/functions/_shared/npiMatch.js', async (original) => ({ ...await original(), lookupNpi: mocks.lookupNpi }))
let handlers = {}, user, admin, countResult, logResult, inviteResult, accountResult
const receipt = { version: 1, npi: '1234567893', firstName: 'Jane', lastName: 'Doe', matchedAt: '2026-10-12T12:00:00Z' }
const request = (body) => new Request('https://example.test/', { method: 'POST', headers: { authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  user = { id: 'u1', app_metadata: { existing: 'kept' } }
  countResult = { count: 0, error: null }; logResult = { error: null }
  inviteResult = { data: { revoked_at: null, expires_at: null, uses: 0, max_uses: 10 } }
  accountResult = { data: null }
  const chain = { eq: () => chain, gte: async () => countResult }
  admin = {
    from: vi.fn((table) => {
      if (table === 'events' || table === 'invite_attempts') return { select: () => chain, insert: vi.fn(async () => logResult) }
      const lookup = { eq: vi.fn(() => lookup), maybeSingle: async () => table === 'sponsor_invites' ? inviteResult : accountResult }
      return { select: () => lookup }
    }),
    auth: { admin: { updateUserById: vi.fn(async () => ({ error: null })) } },
    rpc: vi.fn(async (name) => {
      if (name === 'spending_contract_version') return { data: '2026-10-09.spending-v2' }
      if (name === 'record_invite_attempt') return { data: 'allow' }
      return { data: { status: 'enrolled' } }
    }),
  }
  mocks.createClient.mockImplementation((url, key) => key === 'service' ? admin : { auth: { getUser: async () => ({ data: { user } }) } })
  let name = 'match'
  vi.stubGlobal('Deno', { env: { get: (key) => ({ SUPABASE_URL: 'https://test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' })[key] }, serve: (handler) => { handlers[name] = handler } })
  await import('../../supabase/functions/match-npi/index.ts')
  name = 'redeem'
  await import('../../supabase/functions/redeem-invite/index.ts')
  mocks.lookupNpi.mockResolvedValue({ status: 'matched', match: receipt })
})
describe('NPI Edge boundaries', () => {
  const input = { firstName: 'Jane', lastName: 'Doe', npi: '1234567893' }
  it('routes an empty optional code only to atomic NPI enrollment with the verified JWT user', async () => {
    const response = await handlers.redeem(request({ code:'', user_id:'attacker', npi_match:receipt }))
    expect(response.status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('enroll_npi_beta', {p_user_id:'u1'})
    expect(admin.rpc).not.toHaveBeenCalledWith('redeem_sponsor_invite',expect.anything())
  })
  it('denies anonymous alternate enrollment before any enrollment RPC', async () => {
    user=null
    expect((await handlers.redeem(request({code:''}))).status).toBe(401)
    expect(admin.rpc).not.toHaveBeenCalled()
  })
  it('does not report paused or rejected enrollment as successful health evidence', async () => {
    admin.rpc.mockImplementation(async name=>name==='spending_contract_version'?{data:'2026-10-09.spending-v2'}:name==='record_invite_attempt'?{data:'allow'}:{data:{status:'paused'}})
    expect(await (await handlers.redeem(request({code:''}))).json()).toEqual({status:'paused'})
    expect(admin.rpc).not.toHaveBeenCalledWith('beta_monitor_record',expect.anything())
  })
  it('requires authentication before registry call', async () => {
    user = null
    expect((await handlers.match(request(input))).status).toBe(401)
    expect(mocks.lookupNpi).not.toHaveBeenCalled()
  })
  it('persists only server match and preserves existing app metadata', async () => {
    const response = await handlers.match(request(input))
    expect(response.status).toBe(200)
    expect(admin.auth.admin.updateUserById).toHaveBeenCalledWith('u1', { app_metadata: { existing: 'kept', npi_match: receipt } })
  })
  it('never reports success on failed persistence', async () => {
    admin.auth.admin.updateUserById.mockResolvedValue({ error: new Error('fail') })
    expect((await handlers.match(request(input))).status).toBe(503)
  })
  it('rate limits and fails closed if attempts cannot be counted or logged', async () => {
    countResult.count = 10
    expect((await handlers.match(request(input))).status).toBe(429)
    countResult = { error: new Error('failed') }
    expect((await handlers.match(request(input))).status).toBe(503)
    countResult = { count: 0 }; logResult.error = new Error('failed')
    expect((await handlers.match(request(input))).status).toBe(503)
    expect(mocks.lookupNpi).not.toHaveBeenCalled()
  })
  it('does not persist mismatch or unavailable results', async () => {
    for (const status of ['mismatch', 'unavailable']) {
      mocks.lookupNpi.mockResolvedValue({ status })
      expect((await handlers.match(request(input))).status).toBe(status === 'unavailable' ? 503 : 422)
    }
    expect(admin.auth.admin.updateUserById).not.toHaveBeenCalled()
  })
  it('rejects fabricated client receipts without consuming invite', async () => {
    user.user_metadata = { npi_match: receipt }
    const response = await handlers.redeem(request({ code: 'BETA', npi_match: receipt }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'npi_required' })
    expect(admin.rpc).not.toHaveBeenCalledWith('redeem_sponsor_invite', expect.anything())
  })
  it('rejects nonexistent, revoked, expired and exhausted codes before asking for NPI', async () => {
    const good = { ...inviteResult.data }
    for (const [invite, status] of [[null, 'invalid'], [{ ...good, revoked_at: '2026-01-01' }, 'inactive'],
      [{ ...good, expires_at: '2000-01-01T00:00:00Z' }, 'expired'], [{ ...good, uses: 10 }, 'exhausted']]) {
      inviteResult = { data: invite }
      expect(await (await handlers.redeem(request({ code: 'BETA' }))).json()).toEqual({ status })
    }
    expect(admin.rpc).not.toHaveBeenCalledWith('redeem_sponsor_invite', expect.anything())
  })
  it('fails closed on preflight lookup failures', async () => {
    inviteResult.error = new Error('database')
    expect((await handlers.redeem(request({ code: 'BETA' }))).status).toBe(503)
    inviteResult.error = null; accountResult.error = new Error('database')
    expect((await handlers.redeem(request({ code: 'BETA' }))).status).toBe(503)
    expect(admin.rpc).not.toHaveBeenCalledWith('redeem_sponsor_invite', expect.anything())
  })
  it('preserves already/revoked precedence for existing accounts without requiring NPI', async () => {
    inviteResult.data.revoked_at = '2026-01-01'
    accountResult.data = { active: true, ends_at: null, cohort: 'existing' }
    expect(await (await handlers.redeem(request({ code: 'BETA' }))).json()).toEqual({ status: 'already', cohort: 'existing' })
    accountResult.data.active = false
    expect(await (await handlers.redeem(request({ code: 'BETA' }))).json()).toEqual({ status: 'revoked' })
    expect(admin.rpc).not.toHaveBeenCalledWith('redeem_sponsor_invite', expect.anything())
  })
  it('retains invite rate limits before preflight lookup', async () => {
    admin.rpc.mockImplementation(async (name) => {
      if (name === 'spending_contract_version') return { data: '2026-10-09.spending-v2' }
      if (name === 'record_invite_attempt') return { data: 'deny' }
      return { data: { status: 'enrolled' } }
    })
    expect((await handlers.redeem(request({ code: 'BETA' }))).status).toBe(429)
    expect(admin.rpc).toHaveBeenCalledWith('record_invite_attempt', { p_user_id: 'u1' })
    expect(admin.from).not.toHaveBeenCalledWith('invite_attempts')
    expect(admin.from).not.toHaveBeenCalledWith('events')
    expect(admin.from).not.toHaveBeenCalledWith('sponsor_invites')
    admin.rpc.mockImplementation(async (name) => {
      if (name === 'spending_contract_version') return { data: '2026-10-09.spending-v2' }
      if (name === 'record_invite_attempt') return { error: new Error('failed') }
      return { data: { status: 'enrolled' } }
    })
    expect((await handlers.redeem(request({ code: 'BETA' }))).status).toBe(503)
    expect(admin.from).not.toHaveBeenCalledWith('sponsor_invites')
  })
  it('lets final atomic redemption reject a code changed after NPI', async () => {
    user.app_metadata.npi_match = receipt
    admin.rpc.mockImplementation(async (name) => {
      if (name === 'spending_contract_version') return { data: '2026-10-09.spending-v2' }
      if (name === 'record_invite_attempt') return { data: 'allow' }
      return { data: { status: 'exhausted' } }
    })
    expect(await (await handlers.redeem(request({ code: 'BETA' }))).json()).toEqual({ status: 'exhausted' })
  })
  it('redeems a code issued without the NPI requirement for an account with no match', async () => {
    inviteResult.data.npi_required = false
    expect(await (await handlers.redeem(request({ code: 'INTL' }))).json()).toEqual({ status: 'enrolled' })
    expect(admin.rpc).toHaveBeenCalledWith('redeem_sponsor_invite', { p_code: 'INTL', p_user_id: 'u1' })
  })
  it('still refuses a used-up or revoked no-NPI code before redemption', async () => {
    for (const [change, status] of [[{ uses: 10 }, 'exhausted'], [{ revoked_at: '2026-01-01' }, 'inactive']]) {
      inviteResult = { data: { revoked_at: null, expires_at: null, uses: 0, max_uses: 10, npi_required: false, ...change } }
      expect(await (await handlers.redeem(request({ code: 'INTL' }))).json()).toEqual({ status })
    }
    expect(admin.rpc).not.toHaveBeenCalledWith('redeem_sponsor_invite', expect.anything())
  })
  it('redeems only with persisted server-owned receipt', async () => {
    user.app_metadata.npi_match = receipt
    expect((await handlers.redeem(request({ code: 'BETA' }))).status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('redeem_sponsor_invite', { p_code: 'BETA', p_user_id: 'u1' })
  })
})
