import { describe, it, expect } from 'vitest'
import { libraryFingerprint, shouldRunSynthesis, DEFAULT_MIN_INTERVAL_MS } from './synthesisCooldown.js'

describe('libraryFingerprint', () => {
  it('changes when a paper is added or the newest save moves', () => {
    const a = libraryFingerprint([{ savedAt: '2026-09-01T00:00:00Z' }])
    const b = libraryFingerprint([{ savedAt: '2026-09-01T00:00:00Z' }, { savedAt: '2026-09-02T00:00:00Z' }])
    const c = libraryFingerprint([{ savedAt: '2026-09-03T00:00:00Z' }])
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(libraryFingerprint([])).toBe('0:')
  })
})

describe('shouldRunSynthesis', () => {
  const now = Date.parse('2026-09-17T12:00:00Z')
  it('runs the first time', () => {
    expect(shouldRunSynthesis({ last: undefined, fingerprint: '1:x', now })).toBe(true)
  })
  it('skips when the library has not changed, however long ago it ran', () => {
    expect(shouldRunSynthesis({ last: { at: '2026-01-01T00:00:00Z', fingerprint: '1:x' }, fingerprint: '1:x', now })).toBe(false)
  })
  it('skips a changed library inside the interval', () => {
    const at = new Date(now - DEFAULT_MIN_INTERVAL_MS + 1000).toISOString()
    expect(shouldRunSynthesis({ last: { at, fingerprint: '1:x' }, fingerprint: '2:y', now })).toBe(false)
  })
  it('runs a changed library once the interval has passed', () => {
    const at = new Date(now - DEFAULT_MIN_INTERVAL_MS).toISOString()
    expect(shouldRunSynthesis({ last: { at, fingerprint: '1:x' }, fingerprint: '2:y', now })).toBe(true)
  })
})
