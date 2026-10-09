import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { mountDom, deferred } from '../test-utils/dom.js'
import ReportBadgeButton from './ReportBadgeButton.jsx'
import ProvenanceBadge from './ProvenanceBadge.jsx'
import { FeedbackDialog } from './BetaFeedback.jsx'
import { VERIFICATION_VERSION } from '../lib/evidenceVersion.js'

const verdict = { tier: 'verified-full-text', verificationVersion: VERIFICATION_VERSION, flagged: false, relationshipValidated: true, relationshipStatus: 'validated', sourceTier: 'full_text' }
const A = { surface: 'digest', pmid: '100', quantity: { name: 'Stroke at 30 days', value: 2.1, unit: '%', source_quote: 'stroke 2.1%' }, verdict, extractionVersion: 'x1', sourceHash: 'h1' }
const B = { ...A, quantity: { name: 'Death at 1 year', value: 4.4, unit: '%', source_quote: 'death 4.4%' } }

// A controllable submit: each call is queued with its payload and its own deferred reply.
function fakeSubmit() {
  const calls = []
  const submit = (type, payload) => {
    const d = deferred()
    calls.push({ type, payload, ...d })
    return d.promise
  }
  return { submit, calls }
}

let ui
beforeEach(async () => { ui = await mountDom() })

describe('ReportBadgeButton — lifecycle follows the evidence identity', () => {
  it('rerendering a new value in the same slot mid-send shows a fresh control, submits B, and ignores A’s late reply', async () => {
    const { submit, calls } = fakeSubmit()
    await ui.render(React.createElement(ReportBadgeButton, { report: A, enabled: true, submit }))
    await ui.click(ui.button('This badge is wrong?'))
    expect(ui.text()).toContain('Sending report…')

    await ui.render(React.createElement(ReportBadgeButton, { report: B, enabled: true, submit }))
    expect(ui.text()).toContain('This badge is wrong?')
    await ui.click(ui.button('This badge is wrong?'))
    expect(calls).toHaveLength(2)
    expect(calls[0].payload.name).toBe('Stroke at 30 days')
    expect(calls[1].payload.name).toBe('Death at 1 year')
    expect(calls[1].payload.reportId).not.toBe(calls[0].payload.reportId)

    // A's reply lands late: B is still sending, not "Reported".
    await ui.settle(() => calls[0].resolve({ id: 1 }))
    expect(ui.text()).toContain('Sending report…')
    expect(ui.text()).not.toContain('Reported')
    await ui.settle(() => calls[1].resolve({ id: 2 }))
    expect(ui.text()).toContain('Reported.')
  })

  it('a receipt for A is not carried onto B; a failed late reply for A cannot mark B failed', async () => {
    const { submit, calls } = fakeSubmit()
    await ui.render(React.createElement(ReportBadgeButton, { report: A, enabled: true, submit }))
    await ui.click(ui.button('This badge is wrong?'))
    await ui.settle(() => calls[0].resolve({ id: 1 }))
    expect(ui.text()).toContain('Reported.')
    await ui.render(React.createElement(ReportBadgeButton, { report: { ...A, extractionVersion: 'x2' }, enabled: true, submit }))
    expect(ui.text()).toContain('This badge is wrong?')
    expect(ui.text()).not.toContain('Reported')

    await ui.click(ui.button('This badge is wrong?'))
    await ui.render(React.createElement(ReportBadgeButton, { report: B, enabled: true, submit }))
    await ui.settle(() => calls[1].reject(new Error('Not sent: offline')))
    expect(ui.text()).toContain('This badge is wrong?')
    expect(ui.text()).not.toContain('Report not sent')
  })

  it('failure shows Retry; the retry re-sends the same report id; success only after the server confirms', async () => {
    const { submit, calls } = fakeSubmit()
    await ui.render(React.createElement(ReportBadgeButton, { report: A, enabled: true, submit }))
    await ui.click(ui.button('This badge is wrong?'))
    await ui.settle(() => calls[0].reject(new Error('Not sent: offline')))
    expect(ui.text()).toContain('Report not sent (offline)')
    expect(ui.text()).not.toContain('Reported')
    // A rerender with the same evidence (new object, same identity) keeps the failure + retry.
    await ui.render(React.createElement(ReportBadgeButton, { report: { ...A, quantity: { ...A.quantity } }, enabled: true, submit }))
    await ui.click(ui.button('Retry'))
    expect(calls[1].payload.reportId).toBe(calls[0].payload.reportId)
    expect(ui.text()).toContain('Sending report…')
    await ui.settle(() => calls[1].resolve({ id: 9 }))
    expect(ui.text()).toContain('Reported.')
    expect(ui.button('This badge is wrong?')).toBeUndefined()
  })
})

describe('ProvenanceBadge — interactive', () => {
  it('click toggles the explanation; Escape closes it', async () => {
    await ui.render(React.createElement('div', null, React.createElement(ProvenanceBadge, { tier: 'verified-comparison', sourceTier: 'full_text' })))
    const btn = ui.q('button')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    await ui.click(btn)
    expect(ui.q('button').getAttribute('aria-expanded')).toBe('true')
    expect(ui.q('[role="note"]').textContent).toContain('Groups and endpoint')
    expect(ui.q('[role="note"]').id).toBe(ui.q('button').getAttribute('aria-controls'))
    await ui.keydown(ui.q('button'), 'Escape')
    expect(ui.q('[role="note"]')).toBe(null)
    expect(ui.q('button').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('FeedbackDialog — interactive failure and retry', () => {
  it('keeps the text on failure, retries with the same id, then shows the receipt', async () => {
    const { submit, calls } = fakeSubmit()
    await ui.render(React.createElement(FeedbackDialog, { onClose: () => {}, view: 'digest', submit, initialState: 'idle' }))
    await ui.type(ui.q('textarea'), 'The badge on CREST looked wrong')
    await ui.submit(ui.q('form'))
    expect(calls).toHaveLength(1)
    expect(calls[0].payload).toMatchObject({ text: 'The badge on CREST looked wrong', view: 'digest' })
    await ui.settle(() => calls[0].reject(new Error('Not sent: offline')))
    expect(ui.text()).toContain('Not sent.')
    expect(ui.q('textarea').value).toBe('The badge on CREST looked wrong')
    await ui.submit(ui.q('form'))
    expect(calls[1].payload.reportId).toBe(calls[0].payload.reportId)
    await ui.settle(() => calls[1].resolve({ id: 3 }))
    expect(ui.text()).toContain('Received.')
  })
})
