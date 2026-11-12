import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'

vi.mock('../lib/betaSurvey.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, submitBetaSurvey: vi.fn(async () => ({ ok: true, status: 'recorded' })) }
})
// The thank-you offers the existing feedback box; render it whatever the auth state.
vi.mock('./BetaFeedback.jsx', () => ({ FeedbackButton: () => React.createElement('button', null, 'Send feedback') }))

import { submitBetaSurvey } from '../lib/betaSurvey.js'
import Day30Survey from './Day30Survey.jsx'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  dom = await mountDom()
})
afterEach(async () => { await dom.unmount() })

const mount = async (props) => {
  await dom.render(React.createElement(Day30Survey, props))
  await dom.settle(async () => {})
}
const radio = (name, value) => dom.q(`input[type="radio"][name="${name}"][value="${value}"]`)

describe('Day30Survey', () => {
  it('renders nothing when not due, or when the check fails', async () => {
    await mount({ isDue: async () => false })
    expect(dom.container.innerHTML).toBe('')
    await mount({ isDue: async () => { throw new Error('offline') } })
    expect(dom.container.innerHTML).toBe('')
  })

  it('offers a card; Not now hides it without recording anything', async () => {
    await mount({ isDue: async () => true })
    expect(dom.text()).toContain('about a month')
    expect(dom.container.querySelector('fieldset')).toBeNull()
    await dom.click(dom.button('Not now'))
    expect(dom.container.innerHTML).toBe('')
    expect(submitBetaSurvey).not.toHaveBeenCalled()
  })

  it('Answer now opens the five day-30 questions; a full answer is sent as day30 and thanked', async () => {
    await mount({ isDue: async () => true })
    await dom.click(dom.button('Answer now'))
    const legends = [...dom.container.querySelectorAll('legend')].map((l) => l.textContent)
    expect(legends).toEqual([
      '1. How often do you currently read research papers?',
      '2. About how much time do you spend each week finding and reviewing relevant research?',
      '3. How confident are you that you’re keeping up with research relevant to your work?',
      '4. How well do the papers in your digest match your work?',
      '5. How would you feel if you could no longer use Verastar?',
    ])
    expect(dom.container.querySelector('input:not([type="radio"])')).toBeNull()
    for (const [k, v] of [['read_frequency', 'weekly'], ['weekly_time', '1_3h'], ['confidence', '4'], ['digest_fit', '5'], ['if_gone', 'somewhat_disappointed']]) {
      await dom.click(radio(k, v))
    }
    await dom.submit(dom.q('form'))
    expect(submitBetaSurvey).toHaveBeenCalledWith({ status: 'completed', wave: 'day30', answers: { read_frequency: 'weekly', weekly_time: '1_3h', confidence: '4', digest_fit: '5', if_gone: 'somewhat_disappointed' } })
    expect(dom.text()).toContain('Thank you')
    expect(dom.button('Send feedback')).toBeTruthy()
  })

  it('the email link opens it directly; it has no Skip, and Not now records nothing', async () => {
    await mount({ isDue: async () => true, autoOpen: true })
    expect(dom.container.querySelectorAll('fieldset')).toHaveLength(5)
    expect(dom.text()).not.toMatch(/skip/i)
    await dom.click(dom.button('Not now'))
    expect(submitBetaSurvey).not.toHaveBeenCalled()
    expect(dom.container.innerHTML).toBe('')
  })

  it('comes back on the next visit after Not now', async () => {
    const isDue = vi.fn(async () => true)
    await mount({ isDue })
    await dom.click(dom.button('Not now'))
    expect(dom.container.innerHTML).toBe('')
    await dom.unmount() // a new visit: a fresh mount
    dom = await mountDom()
    await mount({ isDue })
    expect(dom.text()).toContain('stay here until it’s done')
    expect(submitBetaSurvey).not.toHaveBeenCalled()
  })
})
