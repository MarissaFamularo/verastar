import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: { id: 'u1' }, session: vi.fn() }))
vi.mock('./supabase.js', () => ({ currentUser: () => mocks.user, supabase: { auth: { getSession: mocks.session } } }))
const receipt = { version: 1, npi: '1234567893', firstName: 'Jane', lastName: 'Doe', matchedAt: '2026-10-12T12:00:00Z' }
const response = () => ({ ok: true, json: async () => ({ status: 'matched', match: receipt }) })
let npi
beforeEach(async () => {
  vi.resetModules(); mocks.user = { id: 'u1' }
  mocks.session.mockResolvedValue({ data: { session: { user: { id: 'u1' }, access_token: 'token' } } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
  npi = await import('./npi.js')
})
describe('NPI client account binding', () => {
  it('caches success only for initiating account', async () => {
    expect(await npi.matchNpi({})).toEqual(receipt)
    expect(npi.currentNpiMatch()).toEqual(receipt)
    mocks.user = { id: 'u2' }
    expect(npi.currentNpiMatch()).toBeNull()
  })
  it('discards response if account changed while lookup was in flight', async () => {
    fetch.mockImplementation(async () => { mocks.user = { id: 'u2' }; return response() })
    await expect(npi.matchNpi({})).rejects.toThrow('Sign in again')
    expect(npi.currentNpiMatch()).toBeNull()
  })
  it('does not submit a token from another account', async () => {
    mocks.session.mockResolvedValue({ data: { session: { user: { id: 'u2' }, access_token: 'other' } } })
    await expect(npi.matchNpi({})).rejects.toThrow('Sign in again')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects unavailable and malformed success responses', async () => {
    for (const body of [{ status: 'unavailable' }, { status: 'matched', match: {} }]) {
      fetch.mockResolvedValue({ ok: true, json: async () => body })
      await expect(npi.matchNpi({})).rejects.toThrow('unavailable')
      expect(npi.currentNpiMatch()).toBeNull()
    }
  })
})
