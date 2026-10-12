import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountDom } from '../test-utils/dom.js'
import { installOnboardHistory } from '../test-utils/onboardHistory.js'
import { isAuthCallbackHash, onboardStepFromHash, onboardUrl, useOnboardStep } from './onboardingRoute.js'

describe('onboarding hash steps', () => {
  it('maps the flow steps and leaves auth callbacks alone', () => {
    expect(onboardStepFromHash('')).toBe('welcome')
    expect(onboardStepFromHash('#welcome')).toBe('welcome')
    expect(onboardStepFromHash('#signin')).toBe('signin')
    expect(onboardStepFromHash('#connect')).toBe('connect')
    expect(onboardStepFromHash('#interview')).toBe('interview')
    expect(onboardStepFromHash('#review')).toBe('review')
    expect(onboardStepFromHash('#nope')).toBeNull()
    expect(onboardStepFromHash('#access_token=abc&refresh_token=def')).toBeNull()
    expect(onboardStepFromHash('#error=access_denied&error_code=otp_expired')).toBeNull()
    expect(isAuthCallbackHash('#error_description=expired')).toBe(true)
  })

  it('keeps the query string and omits a hash on welcome', () => {
    const loc = { pathname: '/', search: '?firstrun=1' }
    expect(onboardUrl(loc, 'welcome')).toBe('/?firstrun=1')
    expect(onboardUrl(loc, 'connect')).toBe('/?firstrun=1#connect')
  })
})

function Probe() {
  const [step, goStep, backStep, substep, goSubstep] = useOnboardStep()
  return React.createElement('div', null,
    React.createElement('p', { id: 'step' }, substep ? `${step}/${substep}` : step),
    React.createElement('button', { type: 'button', onClick: () => goStep('signin') }, 'To sign in'),
    React.createElement('button', { type: 'button', onClick: () => goStep('connect') }, 'To connect'),
    React.createElement('button', { type: 'button', onClick: () => goStep('interview') }, 'To interview'),
    React.createElement('button', { type: 'button', onClick: () => goStep('review') }, 'To review'),
    React.createElement('button', { type: 'button', onClick: () => goSubstep('npi') }, 'Open NPI'),
    React.createElement('button', { type: 'button', onClick: () => goSubstep(null) }, 'Close NPI'),
    React.createElement('button', { type: 'button', onClick: () => backStep() }, 'In-app back'),
  )
}

describe('browser back stays inside onboarding', () => {
  let dom
  beforeEach(async () => { dom = await mountDom(); installOnboardHistory() })
  afterEach(async () => { await dom.unmount() })

  it('pushes a step hash and returns to welcome on back', async () => {
    await dom.render(React.createElement(Probe))
    expect(dom.text()).toContain('welcome')
    await dom.click(dom.button('To sign in'))
    expect(dom.text()).toContain('signin')
    expect(window.location.hash).toBe('#signin')
    await dom.click(dom.button('To connect'))
    expect(window.location.hash).toBe('#connect')
    await dom.settle(() => { window.history.back() })
    expect(dom.text()).toContain('signin')
    await dom.settle(() => { window.history.back() })
    expect(dom.text()).toContain('welcome')
    expect(window.location.hash).toBe('')
  })

  it('restores sign-in, connect, NPI, interview, and review on back and forward', async () => {
    await dom.render(React.createElement(Probe))
    const at = () => dom.q('#step').textContent
    const back = () => dom.settle(() => { window.history.back() })
    const forward = () => dom.settle(() => { window.history.forward() })
    expect(at()).toBe('welcome')
    await dom.click(dom.button('To sign in'))
    await dom.click(dom.button('To connect'))
    await dom.click(dom.button('Open NPI'))
    expect(at()).toBe('connect/npi')
    expect(window.location.hash).toBe('#connect')
    await back()
    expect(at()).toBe('connect')
    await forward()
    expect(at()).toBe('connect/npi')
    await dom.click(dom.button('Close NPI'))
    expect(at()).toBe('connect')
    await forward()
    expect(at()).toBe('connect/npi')
    await dom.click(dom.button('To interview'))
    await dom.click(dom.button('To review'))
    expect(at()).toBe('review')
    await back()
    expect(at()).toBe('interview')
    await back()
    expect(at()).toBe('connect/npi')
    await back()
    expect(at()).toBe('connect')
    await back()
    expect(at()).toBe('signin')
    await back()
    expect(at()).toBe('welcome')
    await forward()
    expect(at()).toBe('signin')
    await forward()
    expect(at()).toBe('connect')
    await forward()
    expect(at()).toBe('connect/npi')
    await forward()
    expect(at()).toBe('interview')
    await forward()
    expect(at()).toBe('review')
  })
})
