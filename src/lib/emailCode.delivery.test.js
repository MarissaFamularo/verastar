import React, { useLayoutEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred, mountDom } from '../test-utils/dom.js'

vi.mock('./supabase.js', () => ({
  sendMagicLink: vi.fn(), verifyEmailCode: vi.fn(async () => ({ id: 'typed-user' })),
  adoptEmailSession: vi.fn(async () => ({ id: 'canonical-user' })),
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
  verifyCanonicalGmailCode: vi.fn(async () => ({ access_token: 'access', refresh_token: 'refresh' })),
}))
import { useEmailCodeSignIn } from './emailCode.js'
import { prepareGmailAlias } from './gmailAlias.js'
import { sendCanonicalGmailCode, verifyCanonicalGmailCode } from './gmailCanonical.js'
import { sendMagicLink, verifyEmailCode, adoptEmailSession } from './supabase.js'

let dom, form
const typed = 'codexreview+notes@gmail.com'
function Harness() {
  const state = useEmailCodeSignIn()
  useLayoutEffect(() => { form = state })
  return null
}
const sent = (ticket) => ({ ok: true, verifyTicket: ticket })
async function startSend() { await dom.settle(() => { void form.send() }) }
async function expire() { await dom.settle(() => vi.advanceTimersByTimeAsync(8000)) }
async function checkCode() {
  await dom.settle(() => form.setCode('123456'))
  await dom.settle(() => form.verify())
}
beforeEach(async () => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  sendMagicLink.mockResolvedValue(undefined)
  verifyEmailCode.mockResolvedValue({ id: 'typed-user' })
  adoptEmailSession.mockResolvedValue({ id: 'canonical-user' })
  verifyCanonicalGmailCode.mockResolvedValue({ access_token: 'access', refresh_token: 'refresh' })
  prepareGmailAlias.mockResolvedValue({ match: true, ticket: 'send-ticket' })
  dom = await mountDom()
  window.location = { pathname: '/', search: '', assign: vi.fn() }
  await dom.render(React.createElement(Harness))
  await dom.settle(() => form.setEmail(typed))
})
afterEach(async () => { await dom.unmount(); vi.useRealTimers() })

// Exercise all completion orders and success/failure combinations of three
// overlapping requests. The most recent successful request must win, regardless
// of when it finished; no receipt exists if every request failed.
const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]
for (const order of orders) {
  for (let successes = 0; successes < 8; successes += 1) {
    it(`keeps the newest successful send: order ${order}, successes ${successes}`, async () => {
      const sends = [deferred(), deferred(), deferred()]
      sends.forEach((send) => sendCanonicalGmailCode.mockReturnValueOnce(send.promise))
      for (let i = 0; i < sends.length; i += 1) { await startSend(); await expire() }
      let newest = -1
      for (const index of order) {
        const good = Boolean(successes & (1 << index))
        await dom.settle(() => sends[index].resolve(good ? sent(`ticket-${index}`) : { ok: false }))
        if (good) newest = Math.max(newest, index)
        expect(form.sendState).toBe(newest < 0 ? 'error' : 'sent')
      }
      if (newest >= 0) {
        await checkCode()
        expect(verifyCanonicalGmailCode).toHaveBeenLastCalledWith({ verifyTicket: `ticket-${newest}`, code: '123456' })
      }
      expect(sendMagicLink).not.toHaveBeenCalled()
    })
  }
}

for (const when of ['pending', 'success', 'failure', 'timeout']) {
  it(`separate-account choice invalidates old sends while typed delivery is ${when}`, async () => {
    const old = deferred()
    sendCanonicalGmailCode.mockReturnValueOnce(old.promise).mockResolvedValueOnce(sent('retry-ticket'))
    await startSend(); await expire(); await startSend()
    const separate = deferred()
    sendMagicLink.mockReturnValueOnce(separate.promise)
    await dom.settle(() => { void form.sendSeparate() })
    if (when === 'success') await dom.settle(() => separate.resolve())
    if (when === 'failure') await dom.settle(() => separate.reject(new Error('network unavailable')))
    if (when === 'timeout') await expire()
    await dom.settle(() => old.resolve(sent('old-ticket')))
    expect(form.aliasNote).toBe('')
    if (when === 'failure') {
      expect(form.sendState).toBe('error')
      // Retrying a failed explicit choice must not resume alias lookup.
      await startSend()
      expect(prepareGmailAlias).toHaveBeenCalledTimes(2)
    } else if (when !== 'success') await dom.settle(() => separate.resolve())
    expect(form.sendState).toBe('sent')
    await checkCode()
    expect(verifyEmailCode).toHaveBeenCalledWith(typed, '123456')
    expect(verifyCanonicalGmailCode).not.toHaveBeenCalled()
  })
}

for (const first of ['send', 'lookup']) {
  it(`retains the code during a limited retry with ${first} finishing first`, async () => {
    const old = deferred(), lookup = deferred()
    sendCanonicalGmailCode.mockReturnValueOnce(old.promise)
    await startSend(); await expire()
    prepareGmailAlias.mockReturnValueOnce(lookup.promise)
    await startSend()
    const finishSend = () => dom.settle(() => old.resolve(sent('old-ticket')))
    const finishLookup = () => dom.settle(() => lookup.resolve({ match: false }))
    if (first === 'send') { await finishSend(); await finishLookup() }
    else { await finishLookup(); await finishSend() }
    expect(form.sendState).toBe('sent')
    await checkCode()
    expect(verifyCanonicalGmailCode).toHaveBeenCalledWith({ verifyTicket: 'old-ticket', code: '123456' })
  })
}

for (const kind of ['typed', 'canonical', 'lookup']) {
  it(`changing address isolates the new request from an old ${kind} response`, async () => {
    const old = deferred(), next = deferred()
    if (kind === 'typed') {
      prepareGmailAlias.mockResolvedValueOnce({ match: false })
      sendMagicLink.mockReturnValueOnce(old.promise)
    } else if (kind === 'canonical') sendCanonicalGmailCode.mockReturnValueOnce(old.promise)
    else prepareGmailAlias.mockReturnValueOnce(old.promise)
    await startSend()
    await dom.settle(() => form.setEmail('different@clinic.edu'))
    prepareGmailAlias.mockResolvedValueOnce({ match: false })
    sendMagicLink.mockReturnValueOnce(next.promise)
    await startSend()
    await dom.settle(() => old.resolve(kind === 'lookup' ? { match: true, ticket: 'stale' } : sent('stale')))
    expect(form.sendPending).toBe(true)
    expect(form.aliasNote).toBe('')
    await dom.settle(() => next.resolve())
    expect(form.sendPending).toBe(false)
    await checkCode()
    expect(verifyEmailCode).toHaveBeenCalledWith('different@clinic.edu', '123456')
    expect(verifyCanonicalGmailCode).not.toHaveBeenCalled()
  })
}

it('does not adopt a canonical verification that completes after an explicit account switch', async () => {
  sendCanonicalGmailCode.mockResolvedValue(sent('ticket'))
  await startSend()
  const verification = deferred()
  verifyCanonicalGmailCode.mockReturnValueOnce(verification.promise)
  await dom.settle(() => form.setCode('123456'))
  await dom.settle(() => { void form.verify() })
  await dom.settle(() => form.sendSeparate())
  await dom.settle(() => verification.resolve({ access_token: 'old', refresh_token: 'old' }))
  expect(adoptEmailSession).not.toHaveBeenCalled()
  expect(window.location.assign).not.toHaveBeenCalled()
  await checkCode()
  expect(verifyEmailCode).toHaveBeenCalledWith(typed, '123456')
})

it('a failed canonical resend preserves its usable ticket', async () => {
  sendCanonicalGmailCode.mockResolvedValueOnce(sent('ticket')).mockResolvedValueOnce({ ok: false })
  await startSend()
  await dom.settle(() => form.resend())
  expect(form.sendState).toBe('sent')
  await checkCode()
  expect(verifyCanonicalGmailCode).toHaveBeenCalledWith({ verifyTicket: 'ticket', code: '123456' })
})

it('deduplicates a repeated separate-account click while its send is pending', async () => {
  sendCanonicalGmailCode.mockResolvedValue(sent('ticket'))
  await startSend()
  const separate = deferred()
  sendMagicLink.mockReturnValueOnce(separate.promise)
  await dom.settle(() => { void form.sendSeparate(); void form.sendSeparate() })
  expect(sendMagicLink).toHaveBeenCalledTimes(1)
  await dom.settle(() => separate.resolve())
  expect(form.sendState).toBe('sent')
})

it('reset invalidates pending delivery even when the email stays unchanged', async () => {
  const old = deferred()
  sendCanonicalGmailCode.mockReturnValueOnce(old.promise)
  await startSend()
  await dom.settle(() => form.reset())
  await dom.settle(() => old.resolve(sent('old-ticket')))
  expect(form.sendState).toBe('idle')
  expect(form.aliasNote).toBe('')
})
