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
  recordUsage,
  getUsageSummary,
  parseStructuredResponse,
  StructuredOutputError,
} from './anthropic.js'

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
  it('uses the dated Sonnet 5 rate and accumulates calls', () => {
    expect(modelRates('claude-sonnet-5', new Date('2026-08-05T00:00:00Z'))).toEqual({ input: 2, output: 10 })
    expect(modelRates('claude-sonnet-5', new Date('2026-09-02T00:00:00Z'))).toEqual({ input: 3, output: 15 })
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
