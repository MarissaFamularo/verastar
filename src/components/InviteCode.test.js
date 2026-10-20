import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom, deferred } from '../test-utils/dom.js'
vi.mock('../lib/inviteCode.js', () => ({
  NO_NPI_MAILTO: 'mailto:beta@example.test', BETA_CONTACT_EMAIL: 'beta@example.test',
  canRedeem: () => true, redeemInviteCode: vi.fn(), normalizeInviteCode: (s) => s.toUpperCase(),
  INVITE_MESSAGES: {
    invalid: 'That code is not recognized. Check it and try again.',
    exhausted: 'That code has been used up. Ask for a new one.',
    slow_down: 'Too many attempts. Try again in an hour.',
    npi_required: 'Match NPI',
    enrolled: 'Enrolled',
    error: 'Something went wrong. Try again in a moment.',
  },
}))
vi.mock('../lib/sponsor.js', () => ({ isSponsored: () => false }))
vi.mock('./NpiMatch.jsx', () => ({ default: ({ onContinue, onBack }) => React.createElement('div', null,
  'NPI form', React.createElement('button', { onClick: onContinue }, 'Finish NPI'), React.createElement('button', { onClick: onBack }, 'Back')) }))
import { redeemInviteCode } from '../lib/inviteCode.js'
import InviteCode, { BetaAccessGate } from './InviteCode.jsx'
let dom
beforeEach(async () => { vi.clearAllMocks(); redeemInviteCode.mockReset(); dom = await mountDom() })
afterEach(async () => { vi.useRealTimers(); await dom.unmount() })
async function enterCode() {
  await dom.type(dom.q('#beta-access-code'), 'BETA')
  await dom.submit(dom.q('form'))
}
describe('beta code before NPI', () => {
  it('offers people without a US NPI an email for a code', async () => {
    await dom.render(React.createElement(InviteCode))
    expect(dom.text()).toContain('Outside the US or no NPI?')
    expect(dom.q('a[href="mailto:beta@example.test"]')).not.toBeNull()
  })
  it('points an empty box at the NPI step so an NPI is not typed in as a code', async () => {
    await dom.render(React.createElement(InviteCode))
    const submit = () => dom.q('form button[type="submit"]').textContent
    expect(submit()).toBe('Continue to NPI')
    expect(dom.q('#beta-access-code').getAttribute('placeholder')).toBe('Invitation code, if you have one')
    await dom.type(dom.q('#beta-access-code'), 'BETA')
    expect(submit()).toBe('Continue')
  })
  it('starts with code and keeps invalid codes out of the NPI form', async () => {
    redeemInviteCode.mockResolvedValue({ status: 'invalid' })
    await dom.render(React.createElement(InviteCode))
    expect(dom.text()).not.toContain('NPI form')
    await enterCode()
    expect(dom.text()).toContain('That code is not recognized')
    expect(dom.text()).toContain('Join the beta')
    expect(dom.text()).not.toContain('NPI form')
  })
  it('shows a used-up code and a rate limit once each', async () => {
    redeemInviteCode.mockResolvedValueOnce({ status: 'exhausted' }).mockResolvedValueOnce({ status: 'slow_down' })
    await dom.render(React.createElement(InviteCode))
    await enterCode()
    expect(dom.text()).toContain('That code has been used up')
    expect(redeemInviteCode).toHaveBeenCalledTimes(1)
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('Too many attempts')
    expect(redeemInviteCode).toHaveBeenCalledTimes(2)
  })

  it('offers the invite field on an access gate', async () => {
    await dom.render(React.createElement(BetaAccessGate, { inputId: 'beta-invite-digest' }, 'Sign in or add your API key in Settings first.'))
    expect(dom.text()).toContain('Sign in or add your API key in Settings first.')
    expect(dom.q('label[for="beta-invite-digest"]').textContent).toContain('Join the beta')
    expect(dom.q('#beta-invite-digest')).toBeTruthy()
  })

  it('shows NPI only after a usable code and redeems the same code after matching', async () => {
    const onEnrolled = vi.fn()
    redeemInviteCode.mockResolvedValueOnce({ status: 'npi_required' }).mockResolvedValueOnce({ status: 'enrolled' })
    await dom.render(React.createElement(InviteCode, { onEnrolled }))
    await enterCode()
    expect(dom.text()).toContain('NPI form')
    expect(onEnrolled).not.toHaveBeenCalled()
    await dom.click(dom.button('Finish NPI'))
    expect(redeemInviteCode).toHaveBeenNthCalledWith(2, 'BETA')
    expect(onEnrolled).toHaveBeenCalledTimes(1)
  })
  it('allows returning to change the code without enrollment', async () => {
    redeemInviteCode.mockResolvedValue({ status: 'npi_required' })
    await dom.render(React.createElement(InviteCode))
    await enterCode()
    await dom.click(dom.button('Back'))
    expect(dom.q('#beta-access-code').value).toBe('BETA')
    expect(dom.text()).not.toContain('NPI form')
    expect(redeemInviteCode).toHaveBeenCalledTimes(1)
  })
  it('confirms access after NPI without returning to the code form', async () => {
    const onEnrolled = vi.fn()
    const onNpiStep = vi.fn()
    const pending = deferred()
    redeemInviteCode.mockResolvedValueOnce({ status: 'npi_required' }).mockReturnValueOnce(pending.promise)
    await dom.render(React.createElement(InviteCode, { onEnrolled, onNpiStep, lead: true }))
    await enterCode()
    await dom.click(dom.button('Finish NPI'))
    expect(dom.q('#beta-access-code')).toBeNull()
    expect(dom.text()).toContain('Confirming your access')
    expect(dom.text()).not.toContain('Checking')
    await dom.settle(() => pending.resolve({ status: 'enrolled' }))
    expect(onEnrolled).toHaveBeenCalledTimes(1)
    expect(onNpiStep).toHaveBeenCalledWith(false)
    expect(dom.q('#beta-access-code')).toBeNull()
  })
  it('keeps the alternate NPI step open without an invitation code', async () => {
    const onNpiStep = vi.fn()
    await dom.render(React.createElement(InviteCode, { npiOpen: true, code: '', onNpiStep }))
    expect(dom.text()).toContain('NPI form')
    expect(onNpiStep).not.toHaveBeenCalled()
  })
  it('redeems the code kept by the parent after NPI', async () => {
    const onEnrolled = vi.fn()
    redeemInviteCode.mockResolvedValue({ status: 'enrolled' })
    await dom.render(React.createElement(InviteCode, { code: 'BETA', onCodeChange: () => {}, npiOpen: true, onEnrolled }))
    await dom.click(dom.button('Finish NPI'))
    expect(redeemInviteCode).toHaveBeenCalledWith('BETA')
    expect(onEnrolled).toHaveBeenCalledTimes(1)
  })
  it('reports a stalled redeem and still opens NPI when that redeem later succeeds', async () => {
    vi.useFakeTimers()
    const pending = deferred()
    redeemInviteCode.mockReturnValue(pending.promise)
    await dom.render(React.createElement(InviteCode))
    await enterCode()
    expect(dom.text()).toContain('Checking')
    await dom.settle(() => vi.advanceTimersByTimeAsync(8000))
    expect(dom.text()).toContain('timed out')
    expect(dom.button('Continue').disabled).toBe(false)
    await dom.settle(() => pending.resolve({ status: 'npi_required' }))
    expect(dom.text()).toContain('NPI form')
    vi.useRealTimers()
  })
  it('previews the sequence without validating or enrolling', async () => {
    const onEnrolled = vi.fn()
    await dom.render(React.createElement(InviteCode, { preview: true, onEnrolled }))
    await enterCode()
    expect(dom.text()).toContain('NPI form')
    await dom.click(dom.button('Finish NPI'))
    expect(dom.text()).toContain('no access was granted')
    expect(redeemInviteCode).not.toHaveBeenCalled()
    expect(onEnrolled).not.toHaveBeenCalled()
  })
})
