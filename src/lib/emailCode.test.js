import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMAIL_CODE_MESSAGES,
  emailCodeFailureKind,
  reloadAfterSignIn,
  verifyEmailCodeForSignIn,
} from './emailCode.js'

afterEach(() => { vi.useRealTimers() })

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

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
    await flush()
    expect(onLateSession).toHaveBeenCalledWith({ id: 'user-1' })
  })

  it('treats an existing session as signed in before a used-code or timeout failure', async () => {
    const used = await verifyEmailCodeForSignIn('a@clinic.edu', '999999', {
      verify: async () => { throw new Error('Token has expired or is invalid') },
      getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }),
    })
    expect(used).toEqual({ ok: true, user: { id: 'user-1' } })

    vi.useFakeTimers()
    let resolve
    const onLateSession = vi.fn()
    const pending = verifyEmailCodeForSignIn('a@clinic.edu', '888888', {
      timeoutMs: 8000,
      verify: () => new Promise((r) => { resolve = r }),
      getSession: async () => ({ id: 'user-2' }),
      onLateSession,
    })
    await vi.advanceTimersByTimeAsync(8000)
    await expect(pending).resolves.toEqual({ ok: true, user: { id: 'user-2' } })
    resolve({ id: 'user-3' })
    await flush()
    expect(onLateSession).not.toHaveBeenCalled()
  })

  it('shows the timeout when getSession never returns, then signs in if it does', async () => {
    vi.useFakeTimers()
    let resolveSession
    const onLateSession = vi.fn()
    let outcome
    verifyEmailCodeForSignIn('a@clinic.edu', '777777', {
      timeoutMs: 8000,
      sessionMs: 2000,
      verify: () => new Promise(() => {}),
      getSession: () => new Promise((resolve) => { resolveSession = resolve }),
      onLateSession,
    }).then((result) => { outcome = result })
    await vi.advanceTimersByTimeAsync(8000)
    await flush()
    expect(outcome).toMatchObject({ ok: false, kind: 'timeout', message: EMAIL_CODE_MESSAGES.timeout })
    expect(onLateSession).not.toHaveBeenCalled()
    resolveSession({ id: 'user-late' })
    await flush()
    expect(onLateSession).toHaveBeenCalledWith({ id: 'user-late' })
  })

  it('does not let a stalled session check hold a bad code for the full timeout', async () => {
    vi.useFakeTimers()
    let outcome
    verifyEmailCodeForSignIn('a@clinic.edu', '666666', {
      timeoutMs: 8000,
      sessionMs: 2000,
      verify: async () => { throw new Error('Token has expired or is invalid') },
      getSession: () => new Promise(() => {}),
    }).then((result) => { outcome = result })
    await vi.advanceTimersByTimeAsync(2000)
    await flush()
    expect(outcome).toMatchObject({ ok: false, kind: 'invalid' })
    vi.useRealTimers()
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
    await flush()
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
