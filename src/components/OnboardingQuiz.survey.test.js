// The signup survey is offered once, inline on the connect step, right after a code enrolls
// the account. It never appears for an account that was already in, never in preview, and
// skipping it lands on the ordinary "You are all set" screen.
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'

const state = vi.hoisted(() => ({ sponsored: false }))
vi.mock('../lib/supabase.js', () => ({
  supabaseConfigured: true,
  sendMagicLink: vi.fn(),
  verifyEmailCode: vi.fn(),
  adoptEmailSession: vi.fn(),
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) }, rpc: vi.fn() },
  currentUser: () => ({ id: 'u-1' }),
  isSignedIn: () => true,
  initAuth: async () => null,
  signOut: async () => {},
}))
vi.mock('../lib/sponsor.js', () => ({
  isSponsored: () => state.sponsored,
  refreshSponsorship: vi.fn(async () => state.sponsored),
}))
vi.mock('../lib/anthropic.js', () => ({ hasApiKey: () => false, hasModelAccess: () => state.sponsored, setApiKey: vi.fn() }))
vi.mock('../lib/store.js', () => ({ getProfile: vi.fn(async () => null), saveProfile: vi.fn(async () => {}) }))
vi.mock('../lib/npi.js', () => ({ currentNpiMatch: () => ({ npi: '1' }) }))
vi.mock('../lib/inviteCode.js', () => ({
  canRedeem: () => true,
  redeemInviteCode: vi.fn(),
  normalizeInviteCode: (s) => String(s || '').toUpperCase(),
  INVITE_MESSAGES: { invalid: 'Invalid code', npi_required: 'Match NPI', enrolled: 'Enrolled', already: 'Already', error: 'Error' },
}))
vi.mock('../lib/betaSurvey.js', async (importOriginal) => ({ ...(await importOriginal()), submitBetaSurvey: vi.fn(async () => ({ ok: true, status: 'recorded' })) }))
vi.mock('./ProfileInterview.jsx', () => ({ default: () => React.createElement('p', null, 'Interview') }))

import { redeemInviteCode } from '../lib/inviteCode.js'
import { submitBetaSurvey } from '../lib/betaSurvey.js'
import OnboardingQuiz from './OnboardingQuiz.jsx'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  state.sponsored = false
  dom = await mountDom()
})
afterEach(async () => { await dom.unmount() })

async function redeem(status) {
  redeemInviteCode.mockImplementation(async () => { state.sponsored = true; return { status } })
  await dom.render(React.createElement(OnboardingQuiz, { account: { email: 'doctor@clinic.edu' } }))
  await dom.click(dom.button('Set up my digest'))
  await dom.type(dom.q('#beta-access-code'), 'beta')
  await dom.submit(dom.q('#beta-access-code').closest('form'))
}

describe('signup survey after enrollment', () => {
  it('offers the survey once after a fresh enrollment, and skip returns to the connect step', async () => {
    await redeem('enrolled')
    expect(dom.text()).toContain('This optional, one-minute survey')
    expect(dom.text()).not.toContain('You are all set')
    await dom.click(dom.button('Skip for now'))
    expect(submitBetaSurvey).toHaveBeenCalledWith({ status: 'skipped', answers: {} })
    expect(dom.text()).toContain('You are all set')
    expect(dom.button('Continue →')).toBeTruthy()
    expect(dom.text()).not.toContain('one-minute survey')
  })

  it('submitting the survey also returns to the connect step', async () => {
    await redeem('enrolled')
    for (const sel of ['[name="reason"][value="find_papers"]', '[name="read_frequency"][value="daily"]', '[name="weekly_time"][value="gt_3h"]', '[name="confidence"][value="5"]']) {
      await dom.click(dom.q(`input[type="radio"]${sel}`))
    }
    await dom.submit(dom.container.querySelector('form'))
    expect(submitBetaSurvey.mock.calls[0][0].status).toBe('completed')
    expect(dom.text()).toContain('You are all set')
  })

  it('does not offer the survey to an account that was already enrolled', async () => {
    await redeem('already')
    expect(dom.text()).not.toContain('one-minute survey')
    expect(dom.text()).toContain('You are all set')
  })

  it('a failed survey save does not block setup', async () => {
    submitBetaSurvey.mockRejectedValue(new Error('offline'))
    await redeem('enrolled')
    await dom.click(dom.button('Skip for now'))
    expect(dom.text()).toContain('You are all set')
  })
})
