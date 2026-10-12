import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'

vi.mock('../lib/supabase.js', () => ({
  supabaseConfigured: true,
  sendMagicLink: vi.fn(),
  verifyEmailCode: vi.fn(),
  supabase: null,
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

import { sendMagicLink, verifyEmailCode } from '../lib/supabase.js'
import OnboardingQuiz from './OnboardingQuiz.jsx'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  dom = await mountDom()
})
afterEach(async () => {
  vi.useRealTimers()
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
})
