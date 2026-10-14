// anthropic.test.js — key storage rules. Locks the invariant the Settings toggle
// relies on: the key lives in exactly ONE store at a time, and re-persisting via
// setApiKey moves it between sessionStorage and localStorage without re-entry.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setApiKey,
  getApiKey,
  hasApiKey,
  isKeyRemembered,
  clearApiKey,
  setNcbiKey,
  getNcbiKey,
  setNcbiEmail,
  getNcbiEmail,
  setAllCredentialsRemembered,
  getNcbiCredentialStatus,
  clearNcbiCredentials,
  modelRates,
  thinkingParam,
  MODELS,
  recordUsage,
  getUsageSummary,
  parseStructuredResponse,
  StructuredOutputError,
  denialReason,
  sponsoredRefusalMessage,
  CapReachedError,
} from './anthropic.js'
import { CAP_MESSAGE, PAUSE_MESSAGE, OVERRUN_MESSAGE, HELD_MESSAGE } from '../../supabase/functions/_shared/spending.js'

function memStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

beforeEach(() => {
  globalThis.sessionStorage = memStorage()
  globalThis.localStorage = memStorage()
})

describe('api key storage', () => {
  it('defaults to session-only (not remembered)', () => {
    setApiKey('sk-ant-test')
    expect(hasApiKey()).toBe(true)
    expect(isKeyRemembered()).toBe(false)
  })

  it('remember=true persists to localStorage', () => {
    setApiKey('sk-ant-test', { remember: true })
    expect(hasApiKey()).toBe(true)
    expect(isKeyRemembered()).toBe(true)
  })

  it('toggling remember on moves the saved key without re-entry', () => {
    setApiKey('sk-ant-test')
    setApiKey(getApiKey(), { remember: true })
    expect(getApiKey()).toBe('sk-ant-test')
    expect(isKeyRemembered()).toBe(true)
    expect(globalThis.sessionStorage.getItem('verastar.anthropic_key')).toBe(null)
  })

  it('toggling remember off moves it back to session-only', () => {
    setApiKey('sk-ant-test', { remember: true })
    setApiKey(getApiKey(), { remember: false })
    expect(getApiKey()).toBe('sk-ant-test')
    expect(isKeyRemembered()).toBe(false)
    expect(globalThis.localStorage.getItem('verastar.anthropic_key')).toBe(null)
  })

  it('clearApiKey empties both stores', () => {
    setApiKey('sk-ant-test', { remember: true })
    clearApiKey()
    expect(hasApiKey()).toBe(false)
    expect(isKeyRemembered()).toBe(false)
  })
})

describe('unified browser credential persistence', () => {
  it('NCBI credentials follow the Anthropic Remember choice by default', () => {
    setApiKey('sk-ant-test', { remember: true })
    setNcbiKey('ncbi-key')
    setNcbiEmail('researcher@example.edu')

    expect(getNcbiCredentialStatus()).toEqual({
      keyActive: true,
      emailActive: true,
      keyRemembered: true,
      emailRemembered: true,
    })
    expect(globalThis.sessionStorage.getItem('verastar.ncbi_key')).toBe(null)
    expect(globalThis.sessionStorage.getItem('verastar.ncbi_email')).toBe(null)
  })

  it('one toggle migrates all three credentials between storage tiers', () => {
    setApiKey('sk-ant-test')
    setNcbiKey('ncbi-key')
    setNcbiEmail('researcher@example.edu')

    setAllCredentialsRemembered(true)
    expect(isKeyRemembered()).toBe(true)
    expect(getNcbiCredentialStatus().keyRemembered).toBe(true)
    expect(getNcbiCredentialStatus().emailRemembered).toBe(true)

    setAllCredentialsRemembered(false)
    expect(isKeyRemembered()).toBe(false)
    expect(getNcbiCredentialStatus().keyRemembered).toBe(false)
    expect(getNcbiCredentialStatus().emailRemembered).toBe(false)
    expect(getNcbiKey()).toBe('ncbi-key')
    expect(getNcbiEmail()).toBe('researcher@example.edu')
  })

  it('remembered NCBI credentials survive a simulated browser restart', () => {
    setApiKey('sk-ant-test', { remember: true })
    setNcbiKey('ncbi-key')
    setNcbiEmail('researcher@example.edu')

    globalThis.sessionStorage = memStorage()

    expect(getApiKey()).toBe('sk-ant-test')
    expect(getNcbiKey()).toBe('ncbi-key')
    expect(getNcbiEmail()).toBe('researcher@example.edu')
  })

  it('repairs the legacy split state and clears NCBI values from both stores', () => {
    setApiKey('sk-ant-test', { remember: true })
    setNcbiKey('ncbi-key', { remember: false })
    setNcbiEmail('researcher@example.edu', { remember: false })

    setAllCredentialsRemembered(true)
    expect(globalThis.sessionStorage.getItem('verastar.ncbi_key')).toBe(null)
    expect(getNcbiCredentialStatus().keyRemembered).toBe(true)

    clearNcbiCredentials()
    expect(getNcbiKey()).toBe('')
    expect(getNcbiEmail()).toBe('')
    expect(getNcbiCredentialStatus().keyActive).toBe(false)
  })
})

describe('usage accounting', () => {
  it('bills Sonnet 5 at $2/$10 after the cancelled 2026-09-01 rise, and accumulates calls', () => {
    expect(modelRates('claude-sonnet-5')).toEqual({ input: 2, output: 10 })
    recordUsage('claude-sonnet-5', { input_tokens: 1000, output_tokens: 100 }, new Date('2026-08-05T00:00:00Z'))
    recordUsage('claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 100 }, new Date('2026-08-05T00:00:00Z'))
    const summary = getUsageSummary()
    expect(summary.calls).toBe(2)
    expect(summary.inputTokens).toBe(2000)
    expect(summary.outputTokens).toBe(200)
    expect(summary.estimatedUsd).toBeCloseTo(0.0045, 8)
  })
})

describe('structured response completion', () => {
  it('parses a naturally completed structured response', () => {
    expect(parseStructuredResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"ok":true}' }],
    })).toEqual({ ok: true })
  })

  it('classifies max-token output as retryable before parsing partial JSON', () => {
    expect(() => parseStructuredResponse({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"ok":' }],
    })).toThrow(StructuredOutputError)

    try {
      parseStructuredResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ok":' }] })
    } catch (err) {
      expect(err).toMatchObject({ retryable: true, stopReason: 'max_tokens' })
    }
  })

  it('classifies malformed or empty structured output as retryable', () => {
    for (const content of [[{ type: 'text', text: '{"ok":' }], []]) {
      try {
        parseStructuredResponse({ stop_reason: 'end_turn', content })
        throw new Error('expected parseStructuredResponse to throw')
      } catch (err) {
        expect(err).toMatchObject({ retryable: true })
      }
    }
  })
})

// 2026-10-04 Sonnet 5.5 switch: 'disabled' is a 400 on Sonnet 5.5, so every structured
// call (all of which ask for 'disabled') would fail without this mapping.
describe('thinkingParam', () => {
  it('sends between_tools for Sonnet 5.5', () => {
    expect(thinkingParam('claude-sonnet-5-5', { type: 'disabled' })).toEqual({ type: 'between_tools' })
  })
  it('leaves Haiku 4.5 and Sonnet 5 on disabled, and other settings untouched', () => {
    expect(thinkingParam('claude-haiku-4-5-20251001', { type: 'disabled' })).toEqual({ type: 'disabled' })
    expect(thinkingParam('claude-sonnet-5', { type: 'disabled' })).toEqual({ type: 'disabled' })
    expect(thinkingParam('claude-sonnet-5-5', undefined)).toBeUndefined()
    expect(thinkingParam('claude-sonnet-5-5', { type: 'adaptive' })).toEqual({ type: 'adaptive' })
  })
  it('the Sonnet lanes run Sonnet 5.5 at the Sonnet 5 price', () => {
    for (const lane of ['extraction', 'triage', 'interview']) expect(MODELS[lane]).toBe('claude-sonnet-5-5')
    expect(modelRates('claude-sonnet-5-5')).toEqual({ input: 2, output: 10 })
  })
})

// A 402 from the sponsored proxy is worded by its reason: the reader's own cap (stop, resume
// tomorrow) reads differently from a pause, a billing review, or a held scheduled run,
// none of which the reader caused. Never a dollar figure. The reason comes from the exposed
// x-verastar-denial header, or from the error body's type when a client cannot see headers.
describe('sponsored 402 wording', () => {
  const apiError = (type, denial) => ({ status: 402, headers: new Headers(denial ? { 'x-verastar-denial': denial } : {}), error: { type: 'error', error: { type, message: 'server text with $9.99 in it' } } })

  it('reads the denial reason from the header first, then the body type', () => {
    expect(denialReason(apiError('cap_reached', 'cap_month'))).toBe('cap_month')
    expect(denialReason(apiError('spending_paused', 'overrun_review'))).toBe('overrun_review')
    expect(denialReason(apiError('scheduler_held', 'halted:ambiguous'))).toBe('halted:ambiguous')
    expect(denialReason(apiError('cap_reached'))).toBe('cap_day')
    expect(denialReason(apiError('scheduler_held'))).toBe('unresolved_liability')
    expect(denialReason(apiError('overrun_review'))).toBe('overrun_review')
    expect(denialReason(apiError('spending_paused'))).toBe('spending_paused')
    expect(denialReason({ status: 402, headers: { 'x-verastar-denial': 'cap_global' } })).toBe('cap_global')
    expect(denialReason({ status: 402 })).toBeNull()
    expect(denialReason(null)).toBeNull()
  })

  it('maps each reason to its own sentence and never shows server text or money', () => {
    expect(sponsoredRefusalMessage('cap_day')).toBe(CAP_MESSAGE)
    expect(sponsoredRefusalMessage('budget_total')).toBe(CAP_MESSAGE)
    expect(sponsoredRefusalMessage('spending_paused')).toBe(PAUSE_MESSAGE)
    expect(sponsoredRefusalMessage('overrun_review')).toBe(OVERRUN_MESSAGE)
    expect(sponsoredRefusalMessage('unresolved_liability')).toBe(HELD_MESSAGE)
    expect(sponsoredRefusalMessage('halted:release_failed')).toBe(HELD_MESSAGE)
    expect(sponsoredRefusalMessage(null)).toBe(PAUSE_MESSAGE)
    expect(sponsoredRefusalMessage('something_new')).toBe(PAUSE_MESSAGE)
    expect(new Set([CAP_MESSAGE, PAUSE_MESSAGE, OVERRUN_MESSAGE, HELD_MESSAGE]).size).toBe(4)
    for (const m of [CAP_MESSAGE, PAUSE_MESSAGE, OVERRUN_MESSAGE, HELD_MESSAGE]) expect(m).not.toMatch(/\$|\d|dollar|usd/i)
  })

  it('CapReachedError keeps the reason and the chosen sentence', () => {
    const err = new CapReachedError(sponsoredRefusalMessage('overrun_review'), { reason: 'overrun_review' })
    expect(err.capReached).toBe(true)
    expect(err.reason).toBe('overrun_review')
    expect(err.message).toBe(OVERRUN_MESSAGE)
    expect(new CapReachedError().message).toBe(CAP_MESSAGE)
  })
})
