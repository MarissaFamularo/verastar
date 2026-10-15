import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, mountDom } from '../test-utils/dom.js'

vi.mock('../lib/betaSurvey.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, submitBetaSurvey: vi.fn() }
})

import { submitBetaSurvey } from '../lib/betaSurvey.js'
import BetaSurvey, { SURVEY_SUBMIT_TIMEOUT_MS } from './BetaSurvey.jsx'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  dom = await mountDom()
})
afterEach(async () => {
  vi.useRealTimers()
  await dom.unmount()
})

const send = () => dom.button('Send answers')
async function answerAll() {
  for (const label of ['Stay current', 'Weekly', '1–3 hours']) await dom.click(dom.button(label))
  await dom.click(dom.buttons().find((b) => b.getAttribute('role') === 'radio' && b.textContent === '4'))
}

describe('BetaSurvey', () => {
  it('shows the intro, four questions, and a Skip that is always enabled', async () => {
    await dom.render(React.createElement(BetaSurvey))
    expect(dom.text()).toContain('Help us understand how you keep up with research. This optional, one-minute survey will help us improve the beta.')
    expect(dom.container.querySelectorAll('fieldset')).toHaveLength(4)
    expect(dom.text()).toContain('1 = Not at all confident')
    expect(send().disabled).toBe(true)
    expect(dom.button('Skip for now').disabled).toBe(false)
    expect(dom.container.querySelector('input')).toBeNull() // choices only, nothing typed
  })

  it('submits the four codes and continues', async () => {
    const onDone = vi.fn()
    submitBetaSurvey.mockResolvedValue({ ok: true, status: 'recorded' })
    await dom.render(React.createElement(BetaSurvey, { onDone }))
    await answerAll()
    expect(send().disabled).toBe(false)
    await dom.submit(dom.q('form'))
    expect(submitBetaSurvey).toHaveBeenCalledWith({
      status: 'completed',
      answers: { reason: 'stay_current', read_frequency: 'weekly', weekly_time: '1_3h', confidence: '4' },
    })
    expect(onDone).toHaveBeenCalledWith('completed')
  })

  it('changing an answer keeps one choice per question', async () => {
    await dom.render(React.createElement(BetaSurvey))
    await dom.click(dom.button('Stay current'))
    await dom.click(dom.button('Explore a topic'))
    const checked = dom.buttons().filter((b) => b.getAttribute('aria-checked') === 'true')
    expect(checked.map((b) => b.textContent)).toEqual(['Explore a topic'])
  })

  it('skip records a skip and continues', async () => {
    const onDone = vi.fn()
    submitBetaSurvey.mockResolvedValue({ ok: true, status: 'recorded' })
    await dom.render(React.createElement(BetaSurvey, { onDone }))
    await dom.click(dom.button('Skip for now'))
    expect(submitBetaSurvey).toHaveBeenCalledWith({ status: 'skipped', answers: {} })
    expect(onDone).toHaveBeenCalledWith('skipped')
  })

  it('a failed save still continues', async () => {
    const onDone = vi.fn()
    submitBetaSurvey.mockRejectedValue(new Error('boom'))
    await dom.render(React.createElement(BetaSurvey, { onDone }))
    await answerAll()
    await dom.submit(dom.q('form'))
    expect(onDone).toHaveBeenCalledWith('completed')
  })

  it('a stalled save continues after the timeout', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const pending = deferred()
    submitBetaSurvey.mockReturnValue(pending.promise)
    await dom.render(React.createElement(BetaSurvey, { onDone }))
    await dom.click(dom.button('Skip for now'))
    expect(onDone).not.toHaveBeenCalled()
    expect(dom.button('Saving')).toBeTruthy()
    await dom.settle(() => vi.advanceTimersByTimeAsync(SURVEY_SUBMIT_TIMEOUT_MS))
    expect(onDone).toHaveBeenCalledWith('skipped')
  })
})
