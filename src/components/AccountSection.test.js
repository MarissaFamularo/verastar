import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'

vi.mock('../lib/supabase.js', () => ({
  supabaseConfigured: true,
  sendMagicLink: vi.fn(),
  verifyEmailCode: vi.fn(),
  adoptEmailSession: vi.fn(async () => ({ id: 'user-1' })),
  signOut: vi.fn(),
  isSignedIn: () => true,
  supabase: {
    rpc: vi.fn(async () => ({ data: { match: false }, error: null })),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}))
vi.mock('../lib/sponsor.js', () => ({ isSponsored: () => false, refreshSponsorship: vi.fn() }))
vi.mock('../lib/inviteCode.js', () => ({
  canRedeem: () => true,
  redeemInviteCode: vi.fn(),
  normalizeInviteCode: (s) => String(s || '').toUpperCase(),
  INVITE_MESSAGES: {
    invalid: 'That code is not recognized. Check it and try again.',
    exhausted: 'That code has been used up. Ask for a new one.',
    slow_down: 'Too many attempts. Try again in an hour.',
    enrolled: 'You are in.',
    error: 'Something went wrong. Try again in a moment.',
  },
}))

import { redeemInviteCode } from '../lib/inviteCode.js'
import { sendMagicLink, supabase } from '../lib/supabase.js'
import AccountSection from './AccountSection.jsx'

const TICKET = '11111111-1111-4111-8111-111111111111'
const VERIFY = '22222222-2222-4222-8222-222222222222'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
  dom = await mountDom()
})
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await dom.unmount() })

describe('settings account', () => {
  it('sends a code immediately for an exact gmail account address', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
    await dom.render(React.createElement(AccountSection))
    expect(dom.q('label[for="settings-account-email"]').textContent).toContain('Account email')
    await dom.type(dom.q('#settings-account-email'), 'famularomarissa@gmail.com')
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).toHaveBeenCalledWith('famularomarissa@gmail.com')
    expect(dom.text()).toContain('Code sent to famularomarissa@gmail.com')
    expect(dom.text()).not.toContain('Signing you in')
    expect(dom.text()).not.toContain('You already have an account')
  })

  it('names the masked account when a different gmail spelling is used', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    supabase.rpc.mockResolvedValue({
      data: { match: true, hint: 'f…@gmail.com', ticket: TICKET, email: 'famularo.marissa@gmail.com' },
      error: null,
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ sent: true, verifyTicket: VERIFY, email: 'famularo.marissa@gmail.com' }),
    })))
    await dom.render(React.createElement(AccountSection))
    await dom.type(dom.q('#settings-account-email'), 'famularo.marissa+notes@gmail.com')
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect(dom.text()).not.toContain('famularo.marissa@gmail.com')
    expect(dom.button('Create a separate account with this spelling instead')).toBeTruthy()
  })

  it('lets a signed-in reader redeem a beta invite code', async () => {
    redeemInviteCode.mockResolvedValueOnce({ status: 'invalid' })
      .mockResolvedValueOnce({ status: 'exhausted' })
      .mockResolvedValueOnce({ status: 'slow_down' })
    await dom.render(React.createElement(AccountSection, { account: { email: 'f…@gmail.com' } }))
    expect(dom.q('label[for="beta-invite-code"]').textContent).toContain('Have a beta invite code?')
    await dom.type(dom.q('#beta-invite-code'), 'nope')
    await dom.submit(dom.q('#beta-invite-code').closest('form'))
    expect(dom.text()).toContain('That code is not recognized')
    await dom.submit(dom.q('#beta-invite-code').closest('form'))
    expect(dom.text()).toContain('That code has been used up')
    await dom.submit(dom.q('#beta-invite-code').closest('form'))
    expect(dom.text()).toContain('Too many attempts')
    expect(redeemInviteCode).toHaveBeenCalledTimes(3)
  })
})
