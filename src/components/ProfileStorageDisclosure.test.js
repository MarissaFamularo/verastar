import { describe, expect, it } from 'vitest'
import { profileStorageMessage } from './ProfileStorageDisclosure.jsx'

describe('profileStorageMessage', () => {
  it('discloses server storage and browser-only credentials when signed in', () => {
    const message = profileStorageMessage(true)
    expect(message).toContain('steering profile and saved library')
    expect(message).toContain('on our servers')
    expect(message).toContain('sync across devices')
    expect(message).toContain('credentials remain only in this browser')
  })

  it('states that signed-out profile and library data stay in the browser', () => {
    const message = profileStorageMessage(false)
    expect(message).toContain('profile and saved library stay in this browser')
    expect(message).not.toContain('on our servers')
  })
})
