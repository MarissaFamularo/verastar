import { describe, expect, it } from 'vitest'
import { needsExistingLibrarySync, setupStartStep } from './accountGate.js'

describe('needsExistingLibrarySync', () => {
  const localProfile = { onboarded: true, name: 'Dr. Morgan' }

  it('gates an existing signed-out local library in a configured deployment', () => {
    expect(needsExistingLibrarySync({ configured: true, user: null, profile: localProfile })).toBe(true)
  })

  it('does not gate signed-in, demo, preview, or unconfigured use', () => {
    expect(needsExistingLibrarySync({ configured: true, user: { id: 'u1' }, profile: localProfile })).toBe(false)
    expect(needsExistingLibrarySync({ configured: true, user: null, profile: { onboarded: true, demo: true } })).toBe(false)
    expect(needsExistingLibrarySync({ configured: true, user: null, profile: localProfile, preview: true })).toBe(false)
    expect(needsExistingLibrarySync({ configured: false, user: null, profile: localProfile })).toBe(false)
  })
})

describe('setupStartStep', () => {
  it('sends a new production user through account creation first', () => {
    expect(setupStartStep({ configured: true, account: null })).toBe('signin')
  })

  it('lets signed-in, preview, and unconfigured users continue to setup', () => {
    expect(setupStartStep({ configured: true, account: { email: 'doctor@example.com' } })).toBe('connect')
    expect(setupStartStep({ configured: true, account: null, preview: true })).toBe('connect')
    expect(setupStartStep({ configured: false, account: null })).toBe('connect')
  })
})
