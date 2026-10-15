import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), user: { id: 'admin' } }))
vi.mock('./supabase.js', () => ({
  supabaseConfigured: true,
  currentUser: () => mocks.user,
  supabase: { rpc: mocks.rpc },
}))

import { availability, checkBetaAdmin, defaultRange, fetchBetaStats, metricSections, rangeFromInputs, surveyDistributions } from './betaAdmin.js'

import { STATS } from './betaAdmin.fixture.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: 'admin' }
})

describe('dates', () => {
  it('defaults to the last 30 calendar days, inclusive', () => {
    expect(defaultRange(new Date(2026, 9, 15, 13, 0))).toEqual({ fromDate: '2026-09-16', toDate: '2026-10-15' })
  })
  it('turns inclusive dates into a half-open range and rejects bad input', () => {
    const r = rangeFromInputs('2026-10-01', '2026-10-15')
    expect(r.days).toBe(15)
    expect(new Date(r.to) - new Date(r.from)).toBe(15 * 86_400_000)
    expect(rangeFromInputs('', '2026-10-15').error).toMatch(/both dates/)
    expect(rangeFromInputs('2026-10-16', '2026-10-15').error).toMatch(/before the start/)
    expect(rangeFromInputs('2025-01-01', '2026-10-15').error).toMatch(/at most 400/)
    expect(rangeFromInputs('2026-10-15', '2026-10-15').days).toBe(1)
  })
})

describe('availability', () => {
  it('is not available when the record kind has never been written', () => {
    expect(availability(STATS, 'digest_opened')).toMatchObject({ available: false })
    expect(availability(STATS, 'digest_opened').note).toMatch(/No retained records of this kind/)
    expect(availability(STATS, 'digest_opened').note).toMatch(/instrumentation not yet in place, or rows removed/)
  })
  it('is not available when the range ends before the first record', () => {
    const s = { ...STATS, range: { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' } }
    expect(availability(s, 'digest_scheduled_run')).toMatchObject({ available: false })
    expect(availability(s, 'digest_scheduled_run').note).toMatch(/oldest retained record of this kind is from 2026-08-15/)
  })
  it('notes a partial overlap and is silent for full coverage', () => {
    expect(availability(STATS, 'evidence_cache_trusted')).toEqual({ available: true, note: 'Oldest retained record 2026-10-01; days before it have nothing on record. Coverage before that date is unknown.' })
    expect(availability({ ...STATS, first_seen: STATS.earliest_retained, earliest_retained: undefined }, 'sponsored_accounts').available).toBe(false) // the old key is not read
    expect(availability(STATS, 'sponsored_accounts')).toEqual({ available: true, note: '' })
  })
})

describe('metricSections', () => {
  const find = (label) => metricSections(STATS).flatMap((s) => s.rows).find((r) => r.label === label)
  it('renders counts with definitions', () => {
    expect(find('New beta users in range').value).toBe('2 as recorded')
    expect(find('Unique users who requested a digest').value).toBe('2 as recorded')
    expect(find('Scheduled digest-days attempted').value).toBe('5 as recorded')
    expect(find('Retry ticks')).toMatchObject({ value: '2 as recorded', available: true })
    expect(find('Retry ticks').definition).toMatch(/counted separately from requests/)
    expect(find('Summaries generated (scheduled + browser)').value).toBe('9 as recorded')
    expect(find('Unique papers extracted (PMIDs)').value).toBe('2 as recorded')
    expect(find('Surveys completed').value).toBe('1 as recorded')
    expect(find('Total beta users').definition).toMatch(/regardless of the range/)
  })
  it('shows Not available, never zero, for missing instrumentation', () => {
    expect(find('Digest opens')).toMatchObject({ value: 'Not available', available: false })
    expect(find('Rejection and failure reasons')).toMatchObject({ value: 'Not available', available: false })
    const old = metricSections({ ...STATS, range: { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' }, scheduled: { ...STATS.scheduled, ticks: 0, generated: 0 }, survey: { ...STATS.survey, completed: 0 } })
    const oldRow = (label) => old.flatMap((s) => s.rows).find((r) => r.label === label)
    expect(oldRow('Generated').value).toBe('Not available')
    expect(oldRow('Surveys completed').value).toBe('Not available')
    expect(oldRow('Completed, all time')).toMatchObject({ value: '4 as recorded', available: true }) // independent of the range
    expect(oldRow('Rejection and failure reasons').value).toBe('Not available') // genuinely unavailable stays so
  })
  it('distinguishes registration from activity in its wording', () => {
    const users = metricSections(STATS).find((s) => s.title === 'Beta users')
    expect(users.caveat).toMatch(/Registering says nothing about activity/)
    expect(metricSections(STATS).find((s) => s.title === 'Digests opened').caveat).toMatch(/does not record delivery/)
    expect(metricSections(STATS).find((s) => s.title === 'Signup survey').caveat).toMatch(/can identify an individual/)
  })
  it('is empty without stats', () => {
    expect(metricSections(null)).toEqual([])
  })
})

describe('surveyDistributions', () => {
  it('lists every option in question order with zeros', () => {
    const d = surveyDistributions(STATS)
    expect(d).toHaveLength(4)
    expect(d[0].rows.map((r) => r.count)).toEqual([1, 0, 0, 0, 0])
    expect(d[3].rows.map((r) => [r.label, r.count])).toEqual([['1', 0], ['2', 0], ['3', 0], ['4', 1], ['5', 0]])
    expect(d[0].total).toBe(1)
  })
})

describe('rpc wrappers', () => {
  it('checkBetaAdmin is true only for a server yes', async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    expect(await checkBetaAdmin()).toBe(true)
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    expect(await checkBetaAdmin()).toBe(false)
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } })
    expect(await checkBetaAdmin()).toBe(false)
    mocks.rpc.mockRejectedValue(new Error('x'))
    expect(await checkBetaAdmin()).toBe(false)
    mocks.user = null
    expect(await checkBetaAdmin()).toBe(false)
  })
  it('fetchBetaStats passes the range and maps 42501 to forbidden', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    const r = await fetchBetaStats({ from: 'a', to: 'b' })
    expect(r).toEqual({ ok: true, stats: STATS })
    expect(mocks.rpc).toHaveBeenCalledWith('beta_admin_stats', { p_from: 'a', p_to: 'b' })
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'beta admin only' } })
    expect(await fetchBetaStats({ from: 'a', to: 'b' })).toMatchObject({ ok: false, reason: 'forbidden' })
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'range' } })
    expect(await fetchBetaStats({ from: 'a', to: 'b' })).toMatchObject({ ok: false, reason: 'error' })
    mocks.user = null
    expect(await fetchBetaStats({ from: 'a', to: 'b' })).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})
