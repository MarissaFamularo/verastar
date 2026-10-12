import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'
import * as interview from '../pipeline/interview.js'
import ProfileInterview from './ProfileInterview.jsx'

let dom
beforeEach(async () => { dom = await mountDom() })
afterEach(async () => { vi.restoreAllMocks(); await dom.unmount() })

describe('interview progress', () => {
  it('drops the question counter while choosing what to ask next', async () => {
    const real = interview.nextQuestion
    vi.spyOn(interview, 'nextQuestion').mockImplementation((args) => {
      if (args.transcript.length >= interview.SCRIPTED_QUESTIONS.length) return new Promise(() => {})
      return real(args)
    })
    await dom.render(React.createElement(ProfileInterview))
    expect(dom.text()).toContain('QUESTION 1 OF 4')
    expect(dom.q('textarea').getAttribute('aria-labelledby')).toBe('interview-question')
    const answers = ['Dr. Lee', 'Vascular surgery', 'Aortic and carotid disease', 'JVS']
    for (let i = 0; i < 3; i++) {
      await dom.type(dom.q('textarea'), answers[i])
      await dom.click(dom.button('Send'))
      expect(dom.text()).toContain(`QUESTION ${i + 2} OF 4`)
    }
    await dom.type(dom.q('textarea'), answers[3])
    await dom.click(dom.button('Send'))
    expect(dom.text()).toContain('Checking whether one more question would help')
    expect(dom.text()).not.toContain('QUESTION 4 OF 4')
    expect(dom.text()).not.toMatch(/QUESTION \d OF \d/)
  })
})
