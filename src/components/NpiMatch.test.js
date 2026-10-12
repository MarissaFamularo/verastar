import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom, deferred } from '../test-utils/dom.js'
vi.mock('../lib/npi.js', () => ({ currentNpiMatch: vi.fn(() => null), matchNpi: vi.fn() }))
import { matchNpi } from '../lib/npi.js'
import NpiMatch from './NpiMatch.jsx'
let dom
const receipt = { npi: '1234567893', firstName: 'Jane', lastName: 'Doe', version: 1, matchedAt: '2026-10-12T12:00:00Z' }
beforeEach(async () => { vi.clearAllMocks(); dom = await mountDom() })
afterEach(async () => { await dom.unmount() })
async function fill() {
  await dom.type(dom.q('[name=firstName]'), 'Jane')
  await dom.type(dom.q('[name=lastName]'), 'Doe')
  await dom.type(dom.q('[name=npi]'), '1234567893')
}
describe('NPI entry', () => {
  it('names each field from its visible label', async () => {
    await dom.render(React.createElement(NpiMatch))
    expect(dom.q('label[for="npi-firstName"]').textContent).toContain('First name')
    expect(dom.q('label[for="npi-lastName"]').textContent).toContain('Last name')
    expect(dom.q('label[for="npi-npi"]').textContent).toContain('NPI number')
    expect(dom.q('#npi-firstName').id).toBe('npi-firstName')
  })
  it('shows matched only after success, continues with receipt, clears when fields change', async () => {
    const onContinue = vi.fn()
    matchNpi.mockResolvedValue(receipt)
    await dom.render(React.createElement(NpiMatch, { onContinue }))
    await fill()
    expect(dom.button('Continue')).toBeUndefined()
    await dom.submit(dom.q('form'))
    expect(dom.text()).toContain('NPI matched')
    await dom.click(dom.button('Continue'))
    expect(onContinue).toHaveBeenCalledWith(receipt)
    await dom.type(dom.q('[name=lastName]'), 'Different')
    expect(dom.text()).not.toContain('NPI matched')
    expect(dom.button('Continue')).toBeUndefined()
  })
  it('ignores success returned after user changes fields', async () => {
    const pending = deferred()
    matchNpi.mockReturnValue(pending.promise)
    await dom.render(React.createElement(NpiMatch))
    await fill()
    await dom.submit(dom.q('form'))
    await dom.type(dom.q('[name=npi]'), '1111111111')
    await dom.settle(() => pending.resolve(receipt))
    expect(dom.text()).not.toContain('NPI matched')
    expect(dom.button('Continue')).toBeUndefined()
  })
  it('keeps errors retryable without enabling continue', async () => {
    matchNpi.mockRejectedValue(new Error('Try again shortly.'))
    await dom.render(React.createElement(NpiMatch))
    await fill()
    await dom.submit(dom.q('form'))
    expect(dom.q('[role=alert]').textContent).toBe('Try again shortly.')
    expect(dom.button('Continue')).toBeUndefined()
    expect(dom.button('Match NPI').disabled).toBe(false)
  })
  it('labels preview honestly and never calls registry', async () => {
    const onContinue = vi.fn()
    await dom.render(React.createElement(NpiMatch, { preview: true, onContinue }))
    expect(dom.text()).toContain('Preview only')
    expect(dom.text()).not.toContain('NPI matched')
    await dom.click(dom.button('Continue'))
    expect(matchNpi).not.toHaveBeenCalled()
    expect(onContinue).toHaveBeenCalledWith(null)
  })
})
