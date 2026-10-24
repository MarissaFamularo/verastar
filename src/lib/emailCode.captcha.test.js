// The sign-in hook asks for a CAPTCHA token on every send and passes it to whichever
// route delivers the code. A failed check sends nothing and says why.

import React, { useLayoutEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred, mountDom } from '../test-utils/dom.js'

vi.mock('./supabase.js', () => ({
  sendMagicLink: vi.fn(), verifyEmailCode: vi.fn(),
  adoptEmailSession: vi.fn(),
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}))
vi.mock('./gmailAlias.js', () => ({
  prepareGmailAlias: vi.fn(),
  gmailAliasDecision: (p) => p.match
    ? { send: 'canonical', ticket: p.ticket, note: 'Signing you in as c…@gmail.com' }
    : { send: 'typed' },
}))
vi.mock('./gmailCanonical.js', () => ({
  sendCanonicalGmailCode: vi.fn(),
  verifyCanonicalGmailCode: vi.fn(),
}))
vi.mock('./captcha.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, getCaptchaToken: vi.fn() }
})
import { useEmailCodeSignIn } from './emailCode.js'
import { CAPTCHA_MESSAGE, CaptchaError, getCaptchaToken } from './captcha.js'
import { prepareGmailAlias } from './gmailAlias.js'
import { sendCanonicalGmailCode } from './gmailCanonical.js'
import { sendMagicLink } from './supabase.js'

let dom, form
function Harness() {
  const state = useEmailCodeSignIn()
  useLayoutEffect(() => { form = state })
  return null
}
async function startSend() { await dom.settle(() => { void form.send() }) }

beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  sendMagicLink.mockResolvedValue(undefined)
  sendCanonicalGmailCode.mockResolvedValue({ ok: true, verifyTicket: 'verify-ticket' })
  prepareGmailAlias.mockResolvedValue({ match: false })
  getCaptchaToken.mockResolvedValue('tok-1')
  dom = await mountDom()
  window.location = { origin: 'https://verastar.papertrellis.com', pathname: '/', search: '', assign: vi.fn() }
  await dom.render(React.createElement(Harness))
})
afterEach(async () => { await dom.unmount(); vi.useRealTimers() })

it('sends the token with a typed-address code', async () => {
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  expect(sendMagicLink).toHaveBeenCalledWith('doctor@clinic.edu', 'tok-1')
  expect(form.sendState).toBe('sent')
})

it('sends the token with a canonical Gmail code', async () => {
  prepareGmailAlias.mockResolvedValue({ match: true, ticket: 'send-ticket' })
  await dom.settle(() => form.setEmail('jane.doe+x@gmail.com'))
  await startSend()
  expect(sendCanonicalGmailCode).toHaveBeenCalledWith({
    ticket: 'send-ticket', redirectTo: 'https://verastar.papertrellis.com', captchaToken: 'tok-1',
  })
  expect(form.sendState).toBe('sent')
})

it('asks for a fresh token on every resend', async () => {
  getCaptchaToken.mockResolvedValueOnce('tok-1').mockResolvedValueOnce('tok-2')
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  await dom.settle(() => form.resend())
  expect(getCaptchaToken).toHaveBeenCalledTimes(2)
  expect(sendMagicLink).toHaveBeenLastCalledWith('doctor@clinic.edu', 'tok-2')
})

it('sends exactly the old request when CAPTCHA is not configured', async () => {
  getCaptchaToken.mockResolvedValue(undefined)
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  expect(sendMagicLink).toHaveBeenCalledWith('doctor@clinic.edu')
})

it('a failed widget leaves the decision to Auth: the code still sends while CAPTCHA is off', async () => {
  getCaptchaToken.mockRejectedValue(new CaptchaError('error'))
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  expect(sendMagicLink).toHaveBeenCalledWith('doctor@clinic.edu')
  expect(form.sendState).toBe('sent')
})

it('a failed widget with CAPTCHA on shows the CAPTCHA message, not a generic error', async () => {
  getCaptchaToken.mockRejectedValue(new CaptchaError('error'))
  sendMagicLink.mockRejectedValue(Object.assign(new Error('captcha protection: request disallowed (no captcha response)'), { code: 'captcha_failed', status: 400 }))
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  expect(form.sendState).toBe('error')
  expect(form.sendError).toBe(CAPTCHA_MESSAGE)
  expect(form.sendBusy).toBe(false)
})

it('maps an Auth captcha refusal to the CAPTCHA message', async () => {
  sendMagicLink.mockRejectedValue(Object.assign(new Error('captcha protection: request disallowed'), { code: 'captcha_failed' }))
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  expect(form.sendState).toBe('error')
  expect(form.sendError).toBe(CAPTCHA_MESSAGE)
})

it('maps a canonical captcha refusal to the CAPTCHA message', async () => {
  prepareGmailAlias.mockResolvedValue({ match: true, ticket: 'send-ticket' })
  sendCanonicalGmailCode.mockResolvedValue({ ok: false, captcha: true })
  await dom.settle(() => form.setEmail('jane.doe+x@gmail.com'))
  await startSend()
  expect(form.sendState).toBe('error')
  expect(form.sendError).toBe(CAPTCHA_MESSAGE)
})

it('an interactive check longer than the 8s delivery clock still sends', async () => {
  const token = deferred()
  getCaptchaToken.mockReturnValue(token.promise)
  await dom.settle(() => form.setEmail('doctor@clinic.edu'))
  await startSend()
  await dom.settle(() => vi.advanceTimersByTimeAsync(20000))
  expect(form.sendState).toBe('sending')
  await dom.settle(() => token.resolve('slow-tok'))
  expect(sendMagicLink).toHaveBeenCalledWith('doctor@clinic.edu', 'slow-tok')
  expect(form.sendState).toBe('sent')
})

it('a token that arrives after the address changed is not used', async () => {
  const token = deferred()
  getCaptchaToken.mockReturnValueOnce(token.promise)
  await dom.settle(() => form.setEmail('first@clinic.edu'))
  await startSend()
  await dom.settle(() => form.setEmail('second@clinic.edu'))
  await dom.settle(() => token.resolve('stale'))
  expect(sendMagicLink).not.toHaveBeenCalled()
  expect(form.sendState).toBe('idle')
})
