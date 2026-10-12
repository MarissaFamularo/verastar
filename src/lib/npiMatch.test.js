import { describe, expect, it, vi } from 'vitest'
import { lookupNpi, hasNpiMatch, validNpi } from '../../supabase/functions/_shared/npiMatch.js'
const input = { npi: '1234567893', firstName: 'José', lastName: "O’Neil-Smith" }
const record = { number: input.npi, enumeration_type: 'NPI-1', basic: { first_name: 'JOSE', last_name: 'ONEIL SMITH', status: 'A' } }
const registry = (entry = record) => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result_count: entry ? 1 : 0, results: entry ? [entry] : [] }) })
describe('NPI matching', () => {
  it('requires valid NPI checksum and shape', () => {
    expect(validNpi(input.npi)).toBe(true)
    for (const npi of ['1234567890', '123', '0000000000', 1234567893]) expect(validNpi(npi)).toBe(false)
  })
  it('matches first and last after case, punctuation and diacritic normalization', async () => {
    const fetcher = registry()
    const result = await lookupNpi(input, fetcher)
    expect(result.status).toBe('matched')
    expect(fetcher.mock.calls[0][0]).toBe('https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1234567893')
    expect(Object.keys(result.match).sort()).toEqual(['firstName', 'lastName', 'matchedAt', 'npi', 'version'])
    expect(hasNpiMatch({ app_metadata: { npi_match: result.match } })).toBe(true)
    expect(hasNpiMatch({ user_metadata: { npi_match: result.match } })).toBe(false)
  })
  it('does not call registry for invalid or missing fields', async () => {
    const fetcher = registry()
    for (const bad of [{ ...input, npi: '0000000000' }, { ...input, firstName: '!!!' }, null]) {
      expect((await lookupNpi(bad, fetcher)).status).toBe('invalid')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects organizations, inactive or missing results and wrong numbers', async () => {
    for (const bad of [null, { ...record, enumeration_type: 'NPI-2' }, { ...record, basic: { ...record.basic, status: 'D' } }, { ...record, number: '1111111111' }]) {
      expect((await lookupNpi(input, registry(bad))).status).toBe('not_found')
    }
  })
  it('requires both names and does not guess nicknames or alternate names', async () => {
    for (const change of [{ firstName: 'Joseph' }, { lastName: 'Smith' }]) expect((await lookupNpi({ ...input, ...change }, registry())).status).toBe('mismatch')
  })
  it('fails closed on outage, timeout, invalid JSON, API error and malformed payload', async () => {
    for (const fetcher of [vi.fn().mockRejectedValue(new Error('timeout')), vi.fn().mockResolvedValue({ ok: false }),
      vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('json') } }),
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Errors: [{}] }) }),
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })]) {
      expect(await lookupNpi(input, fetcher)).toEqual({ status: 'unavailable' })
    }
  })
})
