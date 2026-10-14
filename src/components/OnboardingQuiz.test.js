import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, mountDom } from '../test-utils/dom.js'
import { installOnboardHistory } from '../test-utils/onboardHistory.js'

vi.mock('../lib/supabase.js', () => ({
  supabaseConfigured: true,
  sendMagicLink: vi.fn(),
  verifyEmailCode: vi.fn(),
  adoptEmailSession: vi.fn(async () => ({ id: 'user-canonical' })),
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
    rpc: vi.fn(async () => ({ data: { match: false }, error: null })),
  },
  currentUser: () => null,
  isSignedIn: () => true,
  initAuth: async () => null,
  signOut: async () => {},
}))
vi.mock('../lib/sponsor.js', () => ({
  isSponsored: () => false,
  refreshSponsorship: vi.fn(async () => false),
}))
vi.mock('../lib/anthropic.js', () => ({
  hasApiKey: () => false,
  hasModelAccess: () => false,
  setApiKey: vi.fn(),
}))
vi.mock('../lib/store.js', () => ({
  getProfile: vi.fn(async () => null),
  saveProfile: vi.fn(async () => {}),
}))
vi.mock('../lib/npi.js', () => ({ currentNpiMatch: () => null }))
vi.mock('../lib/inviteCode.js', () => ({
  canRedeem: () => true,
  redeemInviteCode: vi.fn(),
  normalizeInviteCode: (s) => String(s || '').toUpperCase(),
  INVITE_MESSAGES: { invalid: 'Invalid code', npi_required: 'Match NPI', enrolled: 'Enrolled', error: 'Error' },
}))
vi.mock('./ProfileInterview.jsx', () => ({
  default: ({ onDraft }) => React.createElement('button', {
    type: 'button',
    onClick: () => onDraft({
      name: 'Dr. Lee',
      northStars: ['Limb preservation'],
      topics: [{ label: 'Aortic disease', query: 'aortic aneurysm OR dissection' }],
      rubric: { criteria: 'Rank trials first.', selectCount: 5, scoreFloor: 0 },
    }),
  }, 'Finish interview'),
}))

import { redeemInviteCode } from '../lib/inviteCode.js'
import { GMAIL_ALIAS_LOOKUP_MS } from '../lib/gmailAlias.js'
import { adoptEmailSession, sendMagicLink, supabase, verifyEmailCode } from '../lib/supabase.js'

const ALIAS_TICKET = '11111111-1111-4111-8111-111111111111'
const VERIFY_TICKET = '22222222-2222-4222-8222-222222222222'
import OnboardingQuiz from './OnboardingQuiz.jsx'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  supabase.auth.getSession.mockResolvedValue({ data: { session: null } })
  supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
  dom = await mountDom()
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await dom.unmount()
})

describe('onboarding sign-in and review', () => {
  it('speaks to physicians on the landing screen', async () => {
    await dom.render(React.createElement(OnboardingQuiz, { preview: true }))
    expect(dom.text()).toContain('Nothing is saved to your library')
    expect(dom.text().toLowerCase()).not.toContain('metadata')
    expect(dom.text()).not.toContain('no key needed')
  })

  it('uses one account screen for new and returning people, and keeps a bad code there', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    verifyEmailCode.mockRejectedValue(new Error('Token has expired or is invalid'))
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    expect(dom.text()).toContain('Create your account or sign in')
    expect(dom.text()).not.toContain('Secure your library')
    expect(dom.q('label[for="account-email"]').textContent).toContain('Account email')
    expect(dom.q('#account-email').getAttribute('placeholder')).toBe('you@example.com')
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('Code sent to doctor@clinic.edu')
    expect(dom.text()).toContain('Enter the 6-digit code from that email')
    expect(dom.text()).not.toContain('installed app')
    expect(dom.q('label[for="email-code"]').textContent).toContain('6-digit code')
    expect(dom.button('Sign in')).toBeUndefined()
    await dom.type(dom.q('#email-code'), '000000')
    await dom.submit(dom.q('form'))
    expect(dom.q('[role="alert"]').textContent).toMatch(/invalid or expired/i)
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.button('Send a new code')).toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
    sendMagicLink.mockClear()
    await dom.click(dom.button('Send a new code'))
    expect(sendMagicLink).toHaveBeenCalledWith('doctor@clinic.edu')
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.text()).toContain('A new code is on its way')
  })

  it('sends immediately when a gmail address is not a different spelling', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    supabase.rpc.mockResolvedValue({ data: { match: false }, error: null })
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'famularomarissa@gmail.com')
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).toHaveBeenCalledWith('famularomarissa@gmail.com')
    expect(dom.text()).toContain('Code sent to famularomarissa@gmail.com')
    expect(dom.text()).not.toContain('Signing you in')
    expect(dom.text()).not.toContain('You already have an account')
    expect(dom.button('Create a separate account with this spelling instead')).toBeUndefined()
  })

  it('signs a different gmail spelling into the existing account without showing that address', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    supabase.rpc.mockResolvedValue({
      data: { match: true, hint: 'f…@gmail.com', ticket: ALIAS_TICKET, email: 'famularo.marissa@gmail.com' },
      error: null,
    })
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.action === 'verify') {
        return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', email: 'famularo.marissa@gmail.com' }) }
      }
      return { ok: true, json: async () => ({ sent: true, verifyTicket: VERIFY_TICKET, email: 'famularo.marissa@gmail.com' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'famularo.marissa+notes@gmail.com')
    await dom.submit(dom.q('form'))
    expect(supabase.rpc).toHaveBeenCalledWith('gmail_alias_prepare', { p_email: 'famularo.marissa+notes@gmail.com' })
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect(dom.text()).not.toContain('famularo.marissa@gmail.com')
    expect(dom.text()).not.toContain('You already have an account')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).email).toBeUndefined()
    window.location.assign = vi.fn()
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('form'))
    expect(verifyEmailCode).not.toHaveBeenCalled()
    expect(adoptEmailSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' })
    expect(dom.text()).not.toContain('famularo.marissa@gmail.com')
    sendMagicLink.mockClear()
    await dom.click(dom.button('Create a separate account with this spelling instead'))
    expect(sendMagicLink).toHaveBeenCalledWith('famularo.marissa+notes@gmail.com')
    expect(dom.text()).toContain('Code sent to famularo.marissa+notes@gmail.com')
    expect(dom.text()).not.toContain('Signing you in as')
  })

  const TYPED_ALIAS = 'famularo.marissa+notes@gmail.com'
  const TICKET_B = '44444444-4444-4444-8444-444444444444'
  const VERIFY_B = '33333333-3333-4333-8333-333333333333'

  function aliasPrepare(ticket) {
    return { data: { match: true, hint: 'f…@gmail.com', ticket, email: 'famularo.marissa@gmail.com' }, error: null }
  }

  function sentBody(verifyTicket) {
    return { ok: true, json: async () => ({ sent: true, verifyTicket, email: 'famularo.marissa@gmail.com' }) }
  }

  async function openAliasSignIn() {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), TYPED_ALIAS)
  }

  it('does not switch a confirmed alias to the typed address when a retry lookup is limited or fails', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    supabase.rpc
      .mockResolvedValueOnce(aliasPrepare(ALIAS_TICKET))
      .mockResolvedValueOnce({ data: { match: false }, error: null })
      .mockRejectedValueOnce(new Error('lookup failed'))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t reach sign-in/i)
    expect(dom.text()).not.toContain(`Code sent to ${TYPED_ALIAS}`)
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.text()).not.toContain('Code sent to')
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t send a new code/i)
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.text()).not.toContain(`Code sent to ${TYPED_ALIAS}`)
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
  })

  function verifyTokens() {
    return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh' }) }
  }

  async function submitCode(calls) {
    window.location.assign = vi.fn()
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    return calls.find((body) => body.action === 'verify')
  }

  it('keeps a canonical code that arrives after the send timeout', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'verify') return verifyTokens()
      return late.promise
    }))
    supabase.rpc.mockResolvedValueOnce(aliasPrepare(ALIAS_TICKET))
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t reach sign-in/i)
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.text()).not.toContain('Code sent to')
    await dom.settle(async () => {
      late.resolve(sentBody(VERIFY_TICKET))
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect(dom.text()).not.toContain('famularo.marissa@gmail.com')
    expect(dom.button('Create a separate account with this spelling instead')).toBeTruthy()
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_TICKET)
    expect(verifyEmailCode).not.toHaveBeenCalled()
    expect(adoptEmailSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' })
  })

  it('does not let an older canonical send replace a newer ticket', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'verify') return verifyTokens()
      if (body.ticket === TICKET_B) return sentBody(VERIFY_B)
      return late.promise
    }))
    supabase.rpc
      .mockResolvedValueOnce(aliasPrepare(ALIAS_TICKET))
      .mockResolvedValueOnce(aliasPrepare(TICKET_B))
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t reach sign-in/i)
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    await dom.settle(async () => {
      late.resolve(sentBody(VERIFY_TICKET))
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_B)
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(verifyEmailCode).not.toHaveBeenCalled()
  })

  function stubPendingRetry(late, onSend) {
    const prepareRetry = deferred()
    let lookups = 0
    supabase.rpc.mockImplementation(() => {
      lookups += 1
      if (lookups === 1) return Promise.resolve(aliasPrepare(ALIAS_TICKET))
      return prepareRetry.promise
    })
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'verify') return verifyTokens()
      const custom = onSend?.(body)
      if (custom) return custom
      return late.promise
    }))
    return { prepareRetry, calls }
  }

  async function timeOutFirstAliasSend() {
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t reach sign-in/i)
    await dom.submit(dom.q('form'))
    expect(dom.button('Sending…')).toBeTruthy()
  }

  async function settleDeferred(gate, value) {
    await dom.settle(async () => {
      gate.resolve(value)
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
  }

  it('keeps the code screen when the original send lands before the retry lookup', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const { prepareRetry, calls } = stubPendingRetry(late)
    await timeOutFirstAliasSend()
    await settleDeferred(late, sentBody(VERIFY_TICKET))
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    await settleDeferred(prepareRetry, { data: { match: false }, error: null })
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect(dom.text()).not.toContain(`Code sent to ${TYPED_ALIAS}`)
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_TICKET)
    expect(adoptEmailSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' })
    expect(verifyEmailCode).not.toHaveBeenCalled()
  })

  it('keeps the code screen when the retry lookup returns before the original send', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const { prepareRetry, calls } = stubPendingRetry(late)
    await timeOutFirstAliasSend()
    await settleDeferred(prepareRetry, { data: { match: false }, error: null })
    expect(dom.q('#email-code')).toBeFalsy()
    expect(dom.text()).not.toContain(`Code sent to ${TYPED_ALIAS}`)
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t send a new code/i)
    await settleDeferred(late, sentBody(VERIFY_TICKET))
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_TICKET)
    expect(adoptEmailSession).toHaveBeenCalledWith({ access_token: 'access', refresh_token: 'refresh' })
    expect(verifyEmailCode).not.toHaveBeenCalled()
  })

  it('keeps the retained ticket when the retry send fails after the original code arrives', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const { prepareRetry, calls } = stubPendingRetry(late, (body) => (
      body.ticket === TICKET_B ? { ok: false, json: async () => ({}) } : null
    ))
    await timeOutFirstAliasSend()
    await settleDeferred(late, sentBody(VERIFY_TICKET))
    expect(dom.q('#email-code')).toBeTruthy()
    await settleDeferred(prepareRetry, aliasPrepare(TICKET_B))
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_TICKET)
    expect(verifyEmailCode).not.toHaveBeenCalled()
  })

  it('drops a late alias ticket when the address changes during the retry lookup', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const { prepareRetry, calls } = stubPendingRetry(late)
    await timeOutFirstAliasSend()
    await dom.type(dom.q('#account-email'), 'someone.else@gmail.com')
    await settleDeferred(late, sentBody(VERIFY_TICKET))
    expect(dom.q('#email-code')).toBeFalsy()
    expect(dom.text()).not.toContain('Signing you in')
    await settleDeferred(prepareRetry, { data: { match: false }, error: null })
    expect(dom.q('#email-code')).toBeFalsy()
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(calls.some((body) => body.action === 'verify')).toBe(false)
  })

  it('keeps the late alias ticket when a retry lookup is already limited', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'verify') return verifyTokens()
      return late.promise
    }))
    supabase.rpc
      .mockResolvedValueOnce(aliasPrepare(ALIAS_TICKET))
      .mockResolvedValueOnce({ data: { match: false }, error: null })
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    await dom.submit(dom.q('form'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.text()).not.toContain(`Code sent to ${TYPED_ALIAS}`)
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t send a new code/i)
    await dom.settle(async () => {
      late.resolve(sentBody(VERIFY_TICKET))
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_TICKET)
    expect(sendMagicLink).not.toHaveBeenCalled()
  })

  it('does not let an older canonical resend replace a newer code', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    const late = deferred()
    const calls = []
    const VERIFY_OLD = '55555555-5555-4555-8555-555555555555'
    let sends = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'verify') return verifyTokens()
      sends += 1
      if (sends === 1) return sentBody(VERIFY_TICKET)
      if (sends === 2) return late.promise
      return sentBody(VERIFY_B)
    }))
    supabase.rpc.mockResolvedValue(aliasPrepare(ALIAS_TICKET))
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    await dom.click(dom.button('Send a new code'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t send a new code/i)
    await dom.click(dom.button('Send a new code'))
    expect(dom.text()).toContain('A new code is on its way')
    await dom.settle(async () => {
      late.resolve(sentBody(VERIFY_OLD))
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect((await submitCode(calls)).verifyTicket).toBe(VERIFY_B)
    expect(sendMagicLink).not.toHaveBeenCalled()
  })

  it('resends a confirmed alias to the existing account and still offers a separate account', async () => {
    sendMagicLink.mockResolvedValue(undefined)
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push(body)
      if (body.action === 'verify') {
        return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh' }) }
      }
      const verifyTicket = body.ticket === TICKET_B ? VERIFY_B : VERIFY_TICKET
      return sentBody(verifyTicket)
    }))
    supabase.rpc
      .mockResolvedValueOnce(aliasPrepare(ALIAS_TICKET))
      .mockResolvedValueOnce(aliasPrepare(TICKET_B))
      .mockResolvedValueOnce({ data: { match: false }, error: null })
    await openAliasSignIn()
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    await dom.click(dom.button('Send a new code'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(calls.some((body) => body.action === 'send' && body.ticket === TICKET_B)).toBe(true)
    expect(dom.text()).toContain('A new code is on its way')
    expect(dom.text()).not.toContain('famularo.marissa@gmail.com')
    window.location.assign = vi.fn()
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(calls.find((body) => body.action === 'verify').verifyTicket).toBe(VERIFY_B)
    expect(verifyEmailCode).not.toHaveBeenCalled()

    await dom.click(dom.button('Send a new code'))
    expect(sendMagicLink).not.toHaveBeenCalled()
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t send a new code/i)
    expect(dom.text()).toContain('Signing you in as f…@gmail.com (the account already on this inbox)')
    await dom.click(dom.button('Create a separate account with this spelling instead'))
    expect(sendMagicLink).toHaveBeenCalledWith(TYPED_ALIAS)
    expect(dom.text()).toContain(`Code sent to ${TYPED_ALIAS}`)
    expect(dom.text()).not.toContain('Signing you in as')
  })

  it('sends the code when the gmail lookup never returns', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    supabase.rpc.mockReturnValue(new Promise(() => {}))
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'famularo.marissa@gmail.com')
    await dom.submit(dom.q('form'))
    expect(dom.button('Sending…')).toBeTruthy()
    expect(sendMagicLink).not.toHaveBeenCalled()
    await dom.settle(() => vi.advanceTimersByTimeAsync(GMAIL_ALIAS_LOOKUP_MS))
    expect(sendMagicLink).toHaveBeenCalledWith('famularo.marissa@gmail.com')
    expect(dom.text()).toContain('Code sent to famularo.marissa@gmail.com')
    expect(dom.text()).not.toContain('You already have an account')
    expect(dom.text()).not.toContain('Signing you in')
  })

  it('shows a timeout on the code screen instead of leaving', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    verifyEmailCode.mockReturnValue(new Promise(() => {}))
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('Checking')
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/timed out/i)
    expect(dom.q('#email-code')).toBeTruthy()
    expect(dom.button('Send a new code')).toBeTruthy()
  })

  it('offers one way forward on connect until a beta code or a key is present', async () => {
    await dom.render(React.createElement(OnboardingQuiz, { account: { email: 'doctor@clinic.edu' } }))
    await dom.click(dom.button('Set up my digest'))
    const continues = dom.buttons().filter((b) => b.textContent.includes('Continue'))
    expect(continues).toHaveLength(1)
    expect(continues[0].disabled).toBe(true)
    expect(dom.text()).toContain('Enter the invitation code you received')
    expect(dom.text()).toContain('Enter your beta code above to continue')
    expect(dom.q('label[for="beta-access-code"]')).toBeTruthy()
  })

  it('shows searches, north stars, and the rubric before anything is saved', async () => {
    await dom.render(React.createElement(OnboardingQuiz, { preview: true }))
    await dom.click(dom.button('Set up my digest'))
    const forward = dom.buttons().find((b) => b.textContent.includes('Continue') && !b.disabled)
    await dom.submit(forward.closest('form'))
    await dom.click(dom.button('Finish interview'))
    expect(dom.q('details').hasAttribute('open')).toBe(true)
    expect(dom.text()).toContain('aortic aneurysm OR dissection')
    expect(dom.text()).toContain('Limb preservation')
    expect(dom.text()).toContain('Rank trials first.')
    expect(dom.q('label[for="digest-name"]').textContent).toMatch(/I.ll call you/)
  })

  it('keeps a timed-out code check in flight and honors the session it creates', async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    sendMagicLink.mockResolvedValue(undefined)
    let resolveFirst
    verifyEmailCode.mockImplementation(() => new Promise((resolve) => { resolveFirst = resolve }))
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/timed out/i)
    expect(dom.button('Checking…').disabled).toBe(true)
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.click(dom.button('Send a new code'))
    expect(verifyEmailCode).toHaveBeenCalledTimes(1)
    await dom.settle(async () => {
      resolveFirst({ id: 'user-1' })
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(assign).toHaveBeenCalledWith('/')
    expect(dom.text()).not.toMatch(/invalid or expired/i)
  })

  async function flushSignIn() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  }

  async function openCodeScreen() {
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
  }

  it('submits a replacement code after a permanently stalled check', async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    sendMagicLink.mockResolvedValue(undefined)
    const first = deferred()
    const replacement = deferred()
    verifyEmailCode.mockImplementation((_email, code) => (code === '123456' ? first.promise : replacement.promise))
    await openCodeScreen()
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/timed out/i)
    expect(dom.button('Checking…').disabled).toBe(true)
    await dom.click(dom.button('Send a new code'))
    expect(dom.text()).toContain('A new code is on its way')
    expect(dom.q('[role="alert"]')).toBeNull()
    expect(dom.button('Checking…')).toBeUndefined()
    expect(dom.button('Continue').disabled).toBe(false)
    expect(verifyEmailCode).toHaveBeenCalledTimes(1)
    await dom.type(dom.q('#email-code'), '654321')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(verifyEmailCode).toHaveBeenCalledTimes(2)
    expect(verifyEmailCode).toHaveBeenLastCalledWith('doctor@clinic.edu', '654321')
    expect(dom.button('Checking…').disabled).toBe(true)
    expect(assign).not.toHaveBeenCalled()
    await dom.settle(async () => {
      replacement.resolve({ id: 'user-new' })
      await flushSignIn()
    })
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('lets each resend supersede an older in-flight check', async () => {
    vi.useFakeTimers()
    sendMagicLink.mockResolvedValue(undefined)
    verifyEmailCode.mockImplementation(() => deferred().promise)
    await openCodeScreen()
    await dom.type(dom.q('#email-code'), '111111')
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/timed out/i)

    await dom.click(dom.button('Send a new code'))
    await dom.click(dom.button('Send a new code'))
    expect(sendMagicLink).toHaveBeenCalledTimes(3)
    expect(dom.text()).toContain('A new code is on its way')
    expect(dom.button('Continue').disabled).toBe(false)

    await dom.type(dom.q('#email-code'), '222222')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(verifyEmailCode.mock.calls.map((call) => call[1])).toEqual(['111111', '222222'])
    expect(dom.button('Checking…').disabled).toBe(true)
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(verifyEmailCode).toHaveBeenCalledTimes(2)

    await dom.click(dom.button('Send a new code'))
    expect(dom.button('Checking…')).toBeUndefined()
    expect(dom.button('Continue').disabled).toBe(false)
    await dom.type(dom.q('#email-code'), '333333')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(verifyEmailCode.mock.calls.map((call) => call[1])).toEqual(['111111', '222222', '333333'])
    expect(dom.button('Checking…').disabled).toBe(true)
  })

  it('signs in when an older attempt succeeds after the replacement code fails', async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    sendMagicLink.mockResolvedValue(undefined)
    const first = deferred()
    verifyEmailCode.mockImplementation((_email, code) => (
      code === '123456' ? first.promise : Promise.reject(new Error('Token has expired or is invalid'))
    ))
    await openCodeScreen()
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    await dom.click(dom.button('Send a new code'))
    await dom.type(dom.q('#email-code'), '654321')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(dom.q('[role="alert"]').textContent).toMatch(/invalid or expired/i)
    expect(assign).not.toHaveBeenCalled()
    await dom.settle(async () => {
      first.resolve({ id: 'user-old' })
      await flushSignIn()
    })
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('stays signed in when an older attempt succeeds after the replacement code does', async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    sendMagicLink.mockResolvedValue(undefined)
    const first = deferred()
    verifyEmailCode.mockImplementation((_email, code) => (
      code === '123456' ? first.promise : Promise.resolve({ id: 'user-new' })
    ))
    await openCodeScreen()
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    await dom.click(dom.button('Send a new code'))
    await dom.type(dom.q('#email-code'), '654321')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(assign).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/')
    expect(dom.q('[role="alert"]')).toBeNull()
    await dom.settle(async () => {
      first.resolve({ id: 'user-old' })
      await flushSignIn()
    })
    expect(assign).toHaveBeenCalledTimes(1)
    expect(dom.text()).not.toMatch(/invalid or expired/i)
  })

  it('signs in when a session exists even if the code check reports it was used', async () => {
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    sendMagicLink.mockResolvedValue(undefined)
    verifyEmailCode.mockRejectedValue(new Error('Token has expired or is invalid'))
    supabase.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-9' } } } })
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    expect(assign).toHaveBeenCalledWith('/')
    expect(dom.q('[role="alert"]')).toBeNull()
  })

  it('restores the same connect screen on NPI back and forward', async () => {
    installOnboardHistory()
    redeemInviteCode.mockResolvedValue({ status: 'npi_required' })
    await dom.render(React.createElement(OnboardingQuiz, { account: { email: 'doctor@clinic.edu' } }))
    await dom.click(dom.button('Sign in'))
    expect(dom.text()).toContain('Create your account or sign in')
    await dom.settle(() => { window.history.back() })
    expect(dom.text()).not.toContain('Create your account or sign in')
    await dom.settle(() => { window.history.forward() })
    expect(dom.text()).toContain('Create your account or sign in')
    await dom.settle(() => { window.history.back() })
    await dom.click(dom.button('Set up my digest'))
    const connectHeading = () => [...dom.container.querySelectorAll('h2')].find((node) => node.textContent.includes('Connect Verastar'))
    expect(connectHeading().parentElement.hasAttribute('hidden')).toBe(false)
    await dom.type(dom.q('#beta-access-code'), 'BETA')
    await dom.submit(dom.q('#beta-access-code').closest('form'))
    expect(dom.text()).toContain('Your NPI')
    expect(dom.q('#beta-access-code')).toBeNull()
    expect(connectHeading().parentElement.hasAttribute('hidden')).toBe(true)
    await dom.settle(() => { window.history.back() })
    expect(dom.q('#beta-access-code')).toBeTruthy()
    expect(connectHeading().parentElement.hasAttribute('hidden')).toBe(false)
    expect(dom.text()).toContain('Enter your beta code above to continue')
    await dom.settle(() => { window.history.forward() })
    expect(dom.text()).toContain('Your NPI')
    expect(dom.q('#beta-access-code')).toBeNull()
    expect(connectHeading().parentElement.hasAttribute('hidden')).toBe(true)
    await dom.click(dom.button('Back'))
    expect(dom.q('#beta-access-code')).toBeTruthy()
    expect(connectHeading().parentElement.hasAttribute('hidden')).toBe(false)
    await dom.settle(() => { window.history.forward() })
    expect(dom.text()).toContain('Your NPI')
    expect(connectHeading().parentElement.hasAttribute('hidden')).toBe(true)
  })

  it('shows a timeout when session lookup stalls, then signs in if that lookup succeeds', async () => {
    vi.useFakeTimers()
    const assign = vi.fn()
    window.location = { pathname: '/', search: '', hash: '', assign }
    sendMagicLink.mockResolvedValue(undefined)
    verifyEmailCode.mockReturnValue(new Promise(() => {}))
    let resolveSession
    supabase.auth.getSession.mockReturnValue(new Promise((resolve) => { resolveSession = resolve }))
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
    await dom.type(dom.q('#email-code'), '123456')
    await dom.submit(dom.q('#email-code').closest('form'))
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/timed out/i)
    expect(assign).not.toHaveBeenCalled()
    await dom.settle(async () => {
      resolveSession({ data: { session: { user: { id: 'user-late' } } } })
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('stops a stalled code email instead of spinning, then continues when it arrives', async () => {
    vi.useFakeTimers()
    let resolveSend
    sendMagicLink.mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    await dom.render(React.createElement(OnboardingQuiz))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#account-email'), 'doctor@clinic.edu')
    await dom.submit(dom.q('form'))
    expect(dom.button('Sending…').disabled).toBe(true)
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.q('[role="alert"]').textContent).toMatch(/couldn.t reach sign-in/i)
    expect(dom.button('Email me a code')).toBeTruthy()
    await dom.settle(async () => {
      resolveSend()
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(dom.text()).toContain('Code sent to doctor@clinic.edu')
  })

  it('keeps the invitation code when NPI is left and restored, including a reload', async () => {
    installOnboardHistory()
    redeemInviteCode.mockResolvedValue({ status: 'npi_required' })
    const account = { email: 'doctor@clinic.edu' }
    await dom.render(React.createElement(OnboardingQuiz, { account }))
    await dom.click(dom.button('Set up my digest'))
    await dom.type(dom.q('#beta-access-code'), 'beta')
    await dom.submit(dom.q('#beta-access-code').closest('form'))
    expect(dom.text()).toContain('Your NPI')
    await dom.type(dom.q('#npi-firstName'), 'Ada')
    expect(window.history.state.inviteCode).toBe('BETA')
    expect(window.history.state.npiDraft.firstName).toBe('Ada')
    await dom.settle(() => { window.history.back() })
    await dom.settle(() => { window.history.back() })
    expect(dom.text()).not.toContain('Your NPI')
    expect(dom.q('#beta-access-code')).toBeFalsy()
    await dom.settle(() => { window.history.forward() })
    await dom.settle(() => { window.history.forward() })
    expect(dom.text()).toContain('Your NPI')
    expect(dom.q('#npi-firstName').value).toBe('Ada')
    expect(dom.q('#beta-access-code')).toBeNull()
    await dom.render(null)
    await dom.render(React.createElement(OnboardingQuiz, { account }))
    expect(dom.text()).toContain('Your NPI')
    expect(dom.q('#npi-firstName').value).toBe('Ada')
    await dom.settle(() => { window.history.back() })
    expect(dom.q('#beta-access-code').value).toBe('BETA')
    expect(dom.text()).toContain('Connect Verastar')
  })

  it('sends a reloaded NPI step back to code entry when the code is gone', async () => {
    installOnboardHistory()
    window.history.replaceState({ onboard: 'connect', substep: 'npi' }, '', '/#connect')
    await dom.render(React.createElement(OnboardingQuiz, { account: { email: 'doctor@clinic.edu' } }))
    expect(dom.q('#beta-access-code')).toBeTruthy()
    expect(dom.text()).toContain('Enter your invitation code to continue')
    expect(dom.text()).not.toContain('Your NPI')
    expect(window.history.state.substep).toBeUndefined()
  })

  it('restores interview and review on back and forward', async () => {
    installOnboardHistory()
    await dom.render(React.createElement(OnboardingQuiz, { preview: true }))
    await dom.click(dom.button('Set up my digest'))
    const forward = dom.buttons().find((b) => b.textContent.includes('Continue') && !b.disabled)
    await dom.submit(forward.closest('form'))
    expect(dom.text()).toContain('Let\u2019s talk')
    await dom.settle(() => { window.history.back() })
    expect(dom.text()).toContain('Connect Verastar')
    await dom.settle(() => { window.history.forward() })
    expect(dom.text()).toContain('Let\u2019s talk')
    await dom.click(dom.button('Finish interview'))
    expect(dom.text()).toContain('what I\u2019ll watch')
    await dom.settle(() => { window.history.back() })
    expect(dom.text()).toContain('Let\u2019s talk')
    await dom.settle(() => { window.history.forward() })
    expect(dom.text()).toContain('what I\u2019ll watch')
  })
})
