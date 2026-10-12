import { describe, expect, it } from 'vitest'
import { ncbiCredentialCopy } from './ncbiCopy.js'

describe('ncbiCredentialCopy', () => {
  it('describes an unset key and email as optional', () => {
    expect(ncbiCredentialCopy({ keyActive: false, emailActive: false })).toEqual({
      key: 'API key not set · optional',
      email: 'Email not set · optional',
    })
  })

  it('keeps an active key distinct from an email that was never set', () => {
    expect(ncbiCredentialCopy({ keyActive: true, keyRemembered: true, emailActive: false })).toEqual({
      key: 'API key active · remembered',
      email: 'Email not set · optional',
    })
    expect(ncbiCredentialCopy({ keyActive: true, keyRemembered: false, emailActive: true, emailRemembered: false }).key).toBe('API key active · this session')
  })
})
