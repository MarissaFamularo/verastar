import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchPubmed, fetchCitations, fetchAbstractsByPmid } from './sources.js'
vi.mock('../lib/anthropic.js', () => ({ getNcbiKey: () => 'private-api-key', getNcbiEmail: () => 'private@example.test' }))
afterEach(() => vi.unstubAllGlobals())
describe('bounded scheduled PubMed discovery', () => {
  it.each([429, 500, 503, 408])('defers HTTP %s after just one request without exposing credentials', async (status) => {
    const fetch = vi.fn(async () => new Response('upstream error', { status, headers: { 'Retry-After': '7200' } }))
    vi.stubGlobal('fetch', fetch)
    const err = await searchPubmed('private topic', { strict: true }).catch((e) => e)
    expect(err).toMatchObject({ code: 'PUBMED_UNAVAILABLE', retryAfterSeconds: 7200 })
    expect(err.message).not.toMatch(/private|http|key/)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it.each([{}, { error: 'backend failed' }, { esearchresult: { ERROR: 'bad', idlist: [] } }])('does not interpret invalid payloads as an empty day: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(searchPubmed('x', { strict: true })).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
  })
  it('accepts a valid empty search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ esearchresult: { idlist: [] } })))
    expect(await searchPubmed('x', { strict: true })).toEqual([])
  })
  it('sanitizes permanent errors without classifying them as outages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })))
    await expect(searchPubmed('x', { strict: true })).rejects.toThrow('PubMed request rejected (HTTP 400).')
  })
  it('handles network failure and invalid JSON as outages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('secret URL')).mockResolvedValueOnce(new Response('<html>error</html>')))
    await expect(searchPubmed('x', { strict: true })).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
    await expect(searchPubmed('x', { strict: true })).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
  })
  it('does not discard missing metadata and pretend the scan was empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: {} })))
    await expect(fetchCitations(['123'], { strict: true })).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
  })
  it('does not silently drop an abstract fetch outage during scheduled discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(fetchAbstractsByPmid(['123'], { strict: true })).rejects.toMatchObject({ code: 'PUBMED_UNAVAILABLE' })
  })
})
