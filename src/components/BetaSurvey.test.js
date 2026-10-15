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
const radios = () => [...dom.container.querySelectorAll('input[type="radio"]')]
const radio = (name, value) => dom.q(`input[type="radio"][name="${name}"][value="${value}"]`)
const choose = (node) => dom.click(node)
async function answerAll() {
  await choose(radio('reason', 'stay_current'))
  await choose(radio('read_frequency', 'weekly'))
  await choose(radio('weekly_time', '1_3h'))
  await choose(radio('confidence', '4'))
}

describe('BetaSurvey', () => {
  it('shows the intro, four native radio groups, and a Skip that is always enabled', async () => {
    await dom.render(React.createElement(BetaSurvey))
    expect(dom.text()).toContain('Help us understand how you keep up with research. This optional, one-minute survey will help us improve the beta.')
    const fieldsets = [...dom.container.querySelectorAll('fieldset')]
    expect(fieldsets).toHaveLength(4)
    expect(fieldsets.map((f) => f.querySelector('legend').textContent)).toEqual([
      '1. What’s your main reason for trying Verastar?',
      '2. How often do you currently read research papers?',
      '3. About how much time do you spend each week finding and reviewing relevant research?',
      '4. How confident are you that you’re keeping up with research relevant to your work?',
    ])
    // One radio group per fieldset, every radio labelled, no free-text field anywhere.
    for (const f of fieldsets) {
      const inputs = [...f.querySelectorAll('input')]
      expect(inputs.every((i) => i.type === 'radio')).toBe(true)
      expect(new Set(inputs.map((i) => i.name)).size).toBe(1)
      expect(inputs.every((i) => f.querySelector(`label[for="${i.id}"]`))).toBe(true)
    }
    expect(radios()).toHaveLength(19)
    expect(dom.container.querySelector('input:not([type="radio"])')).toBeNull()
    expect(dom.container.querySelector('[role="radio"]')).toBeNull()
    expect(dom.text()).toContain('1 = Not at all confident')
    expect(send().disabled).toBe(true)
    expect(dom.button('Skip for now').disabled).toBe(false)
  })

  it('says answers are account-linked and does not promise anonymity', async () => {
    await dom.render(React.createElement(BetaSurvey))
    expect(dom.text()).toContain('linked to your account')
    expect(dom.text()).toContain('this is not anonymous')
    expect(dom.text()).not.toMatch(/(are|is|kept|stay|remain) anonymous|anonymously|anonymized/i)
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
    await choose(radio('reason', 'stay_current'))
    await choose(radio('reason', 'explore_topic'))
    expect(radios().filter((r) => r.checked).map((r) => r.value)).toEqual(['explore_topic'])
    await choose(radio('read_frequency', 'daily'))
    expect(radios().filter((r) => r.checked).map((r) => `${r.name}=${r.value}`)).toEqual(['reason=explore_topic', 'read_frequency=daily'])
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
