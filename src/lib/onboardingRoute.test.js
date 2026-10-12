import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountDom } from '../test-utils/dom.js'
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
  const [step, goStep, backStep] = useOnboardStep()
  return React.createElement('div', null,
    React.createElement('p', null, step),
    React.createElement('button', { type: 'button', onClick: () => goStep('signin') }, 'To sign in'),
    React.createElement('button', { type: 'button', onClick: () => goStep('connect') }, 'To connect'),
    React.createElement('button', { type: 'button', onClick: () => backStep() }, 'In-app back'),
  )
}

function installHistory() {
  const entries = [{ hash: '', state: null }]
  let index = 0
  const location = {
    pathname: '/',
    search: '',
    hash: '',
    assign: () => {},
  }
  const history = {
    get state() { return entries[index].state },
    pushState(state, _title, url) {
      const hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''
      entries.splice(index + 1)
      entries.push({ hash, state })
      index = entries.length - 1
      location.hash = hash
    },
    replaceState(state, _title, url) {
      const hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : ''
      entries[index] = { hash, state }
      location.hash = hash
    },
    back() {
      if (index > 0) index -= 1
      location.hash = entries[index].hash
      window.dispatchEvent(new window.Event('popstate'))
    },
  }
  window.location = location
  window.history = history
}

describe('browser back stays inside onboarding', () => {
  let dom
  beforeEach(async () => { dom = await mountDom(); installHistory() })
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
})
