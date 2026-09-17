import { describe, it, expect, beforeEach } from 'vitest'
import { sponsorshipActive, isSponsored, _setSponsoredForTests } from './sponsor.js'
import { accessMode, hasModelAccess, setApiKey, clearApiKey, isCapReached, CapReachedError } from './anthropic.js'

function memStorage() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

beforeEach(() => {
  globalThis.sessionStorage = memStorage()
  globalThis.localStorage = memStorage()
  _setSponsoredForTests(false)
  clearApiKey()
})

describe('sponsorshipActive mirrors the server rule', () => {
  const now = new Date('2026-09-17T12:00:00Z')
  it('needs a row, active, and not past ends_at', () => {
    expect(sponsorshipActive(null, now)).toBe(false)
    expect(sponsorshipActive({ active: false }, now)).toBe(false)
    expect(sponsorshipActive({ active: true, ends_at: '2026-09-17T11:00:00Z' }, now)).toBe(false)
    expect(sponsorshipActive({ active: true, ends_at: '2027-03-15T00:00:00Z' }, now)).toBe(true)
  })
})

describe('access lanes', () => {
  it('no key and no sponsorship means no access', () => {
    expect(accessMode()).toBe('none')
    expect(hasModelAccess()).toBe(false)
  })
  it('sponsorship alone opens the sponsored lane', () => {
    _setSponsoredForTests(true)
    expect(isSponsored()).toBe(true)
    expect(accessMode()).toBe('sponsored')
    expect(hasModelAccess()).toBe(true)
  })
  it('a pasted key always wins over sponsorship', () => {
    _setSponsoredForTests(true)
    setApiKey('sk-ant-test')
    expect(accessMode()).toBe('byok')
  })
})

describe('cap errors', () => {
  it('recognizes the proxy 402 and the typed error', () => {
    expect(isCapReached({ status: 402 })).toBe(true)
    expect(isCapReached(new CapReachedError())).toBe(true)
    expect(isCapReached({ status: 429 })).toBe(false)
    expect(new CapReachedError().message).toMatch(/tomorrow morning/)
  })
})
