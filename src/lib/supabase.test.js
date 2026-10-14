import { describe, expect, it } from 'vitest'
import { authError } from './supabase.js'

describe('authError', () => {
  it('keeps the status and code supabase-js reported', () => {
    const err = authError({ message: 'Email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Email rate limit exceeded')
    expect(err.status).toBe(429)
    expect(err.code).toBe('over_email_send_rate_limit')
  })
  it('does not invent fields', () => {
    const err = authError({ message: 'Token has expired or is invalid' })
    expect('status' in err).toBe(false)
    expect('code' in err).toBe(false)
  })
})
