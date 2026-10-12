import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMAIL_CODE_MESSAGES,
  emailCodeFailureKind,
  reloadAfterSignIn,
  verifyEmailCodeForSignIn,
} from './emailCode.js'

afterEach(() => { vi.useRealTimers() })

describe('email code failures', () => {
  it('treats expired, used, and empty sessions as invalid and stays unsuccessful', async () => {
    expect(emailCodeFailureKind(new Error('Token has expired or is invalid'))).toBe('invalid')
    expect(emailCodeFailureKind(new Error('Email link is invalid or has expired'))).toBe('invalid')
    const expired = await verifyEmailCodeForSignIn('a@clinic.edu', '000000', {
      verify: async () => { throw new Error('Token has expired or is invalid') },
    })
    expect(expired).toEqual({ ok: false, kind: 'invalid', message: EMAIL_CODE_MESSAGES.invalid })
    const empty = await verifyEmailCodeForSignIn('a@clinic.edu', '111111', {
      verify: async () => null,
    })
    expect(empty.ok).toBe(false)
    expect(empty.kind).toBe('invalid')
  })

  it('names a timeout and still accepts a session that arrives afterward', async () => {
    vi.useFakeTimers()
    let resolve
    const onLateSession = vi.fn()
    const pending = verifyEmailCodeForSignIn('a@clinic.edu', '222222', {
      timeoutMs: 8000,
      verify: () => new Promise((r) => { resolve = r }),
      onLateSession,
    })
    await vi.advanceTimersByTimeAsync(8000)
    await expect(pending).resolves.toMatchObject({ ok: false, kind: 'timeout' })
    resolve({ id: 'user-1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(onLateSession).toHaveBeenCalledWith({ id: 'user-1' })
  })

  it('does not report success when a timed-out check later fails', async () => {
    vi.useFakeTimers()
    let reject
    const onLateSession = vi.fn()
    const pending = verifyEmailCodeForSignIn('a@clinic.edu', '333333', {
      timeoutMs: 8000,
      verify: () => new Promise((_, rej) => { reject = rej }),
      onLateSession,
    })
    await vi.advanceTimersByTimeAsync(8000)
    await expect(pending).resolves.toMatchObject({ kind: 'timeout' })
    reject(new Error('Token has expired or is invalid'))
    await Promise.resolve()
    await Promise.resolve()
    expect(onLateSession).not.toHaveBeenCalled()
  })

  it('distinguishes a network failure from a bad code', async () => {
    const result = await verifyEmailCodeForSignIn('a@clinic.edu', '444444', {
      verify: async () => { throw new TypeError('Failed to fetch') },
    })
    expect(result.kind).toBe('network')
    expect(result.message).toMatch(/couldn.t reach sign-in/i)
  })

  it('reloads without keeping an onboarding hash', () => {
    const assign = vi.fn()
    reloadAfterSignIn({ pathname: '/app', search: '?firstrun=1', hash: '#signin', assign })
    expect(assign).toHaveBeenCalledWith('/app?firstrun=1')
  })
})
