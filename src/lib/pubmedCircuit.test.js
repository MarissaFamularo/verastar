import { describe, it, expect, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { guardedPubmedSearch } from '../../supabase/functions/_shared/pubmedCircuit.js'
import { observeDigest } from '../../supabase/functions/_shared/observeSignup.js'

function fake({ claim = 'token', finish = true, claimError = null } = {}) {
  return { rpc: vi.fn(async (name) => name === 'pubmed_search_claim' ? { data: claim, error: claimError } : { data: finish }) }
}
describe('shared PubMed circuit boundary', () => {
  it.each([null, false])('makes no request without admission (%s)', async (claim) => {
    const db = fake({ claim }), work = vi.fn()
    await expect(guardedPubmedSearch(db)(work)).rejects.toMatchObject({ code: 'PUBMED_WAITING' })
    expect(work).not.toHaveBeenCalled()
    expect(db.rpc).toHaveBeenCalledTimes(1)
  })
  it('fails closed when the admission database is unavailable', async () => {
    const work = vi.fn()
    await expect(guardedPubmedSearch(fake({ claimError: 'down' }))(work)).rejects.toMatchObject({ code: 'PUBMED_WAITING' })
    expect(work).not.toHaveBeenCalled()
  })
  it('records one failure, preserves Retry-After and never retries inside the invocation', async () => {
    const db = fake(), work = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'PUBMED_UNAVAILABLE', retryAfterSeconds: 7200 }))
    await expect(guardedPubmedSearch(db)(work)).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
    expect(work).toHaveBeenCalledTimes(1)
    expect(db.rpc).toHaveBeenLastCalledWith('pubmed_search_finish', { p_token: 'token', p_outcome: 'unavailable', p_retry_after_seconds: 7200 })
  })
  it('rejects partial discovery instead of clearing the circuit', async () => {
    const db = fake()
    await expect(guardedPubmedSearch(db)(async () => ({ failed: [{}], candidates: [{}] }))).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
    expect(db.rpc.mock.calls.at(-1)[1].p_outcome).toBe('unavailable')
  })
  it('accepts validated zero results but no searches cannot prove recovery', async () => {
    const db = fake()
    await guardedPubmedSearch(db)(async () => ({ failed: [], counts: [{ count: 0 }] }))
    expect(db.rpc.mock.calls.at(-1)[1].p_outcome).toBe('ok')
    await guardedPubmedSearch(db)(async () => ({ failed: [], counts: [] }))
    expect(db.rpc.mock.calls.at(-1)[1].p_outcome).toBe('cancelled')
  })
  it('a stale lease cannot publish success', async () => {
    await expect(guardedPubmedSearch(fake({ finish: false }))(async () => ({ failed: [], counts: [{}] }))).rejects.toMatchObject({ code: 'PUBMED_WAITING' })
  })
  it('does not classify permanent request errors as upstream outages', async () => {
    const db = fake()
    await expect(guardedPubmedSearch(db)(async () => { throw new Error('HTTP 400') })).rejects.toThrow('HTTP 400')
    expect(db.rpc.mock.calls.at(-1)[1].p_outcome).toBe('cancelled')
  })
  it('empty or unverified runs cannot supply paper-bearing recovery evidence', async () => {
    const db = fake()
    await observeDigest(db, { userId: 'A', phase: 'empty' })
    expect(db.rpc).not.toHaveBeenCalled()
    await observeDigest(db, { userId: 'A', phase: 'empty', searchComplete: true })
    expect(db.rpc).toHaveBeenLastCalledWith('beta_digest_observe', { p_user_id: 'A', p_outcome: 'empty' })
    await observeDigest(db, { userId: 'A', phase: 'done', searchComplete: true, recoveryEvidence: true, failed: true })
    expect(db.rpc).toHaveBeenLastCalledWith('beta_digest_observe', { p_user_id: 'A', p_outcome: 'failed' })
  })
})

it('accepts the real Supabase RPC thenable, which has no catch method', async () => {
  const fetch = vi.fn(async (url) => Response.json(String(url).endsWith('/pubmed_search_claim') ? 'lease-token' : true))
  const admin = createClient('https://test.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  })
  expect(admin.rpc('pubmed_search_claim').catch).toBeUndefined()
  const result = { failed: [], counts: [{}], candidates: [] }
  await expect(guardedPubmedSearch(admin)(async () => result)).resolves.toBe(result)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1][0]).toContain('pubmed_search_finish')
})
