import { describe, expect, it, vi } from 'vitest'
import { awaitWithin } from './deadline.js'

describe('awaitWithin', () => {
  it('returns a hanging promise as a timeout without waiting for it', async () => {
    vi.useFakeTimers()
    let settled = false
    const pending = awaitWithin(new Promise(() => {}), 2000).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toEqual({ timeout: true })
    expect(settled).toBe(true)
    vi.useRealTimers()
  })

  it('passes a result or a rejection through when it arrives in time', async () => {
    await expect(awaitWithin(Promise.resolve('ok'), 2000)).resolves.toEqual({ timeout: false, value: 'ok' })
    await expect(awaitWithin(Promise.reject(new Error('nope')), 2000)).rejects.toThrow('nope')
  })
})