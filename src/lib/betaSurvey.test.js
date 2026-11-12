import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn(), user: { id: 'u-1' }, configured: true }))
vi.mock('./supabase.js', () => ({
  get supabaseConfigured() { return mocks.configured },
  currentUser: () => mocks.user,
  supabase: {
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }) }),
  },
}))

import { DAY30_QUESTIONS, DAY30_VERSION, SURVEY_QUESTIONS, SURVEY_VERSION, betaSurveyRecorded, day30SurveyDue, submitBetaSurvey, surveyComplete } from './betaSurvey.js'

const FULL = { reason: 'stay_current', read_frequency: 'weekly', weekly_time: '1_3h', confidence: '4' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: 'u-1' }
  mocks.configured = true
})

describe('surveyComplete', () => {
  it('needs one offered code per question', () => {
    expect(surveyComplete(FULL)).toBe(true)
    expect(surveyComplete({ ...FULL, confidence: '7' })).toBe(false)
    expect(surveyComplete({ ...FULL, reason: 'free text' })).toBe(false)
    expect(surveyComplete({ reason: 'other' })).toBe(false)
    expect(surveyComplete(undefined)).toBe(false)
  })
  it('has four single-choice questions with code/label pairs', () => {
    expect(SURVEY_QUESTIONS).toHaveLength(4)
    expect(SURVEY_QUESTIONS.map((q) => q.options.length)).toEqual([5, 5, 4, 5])
  })
})

describe('submitBetaSurvey', () => {
  it('sends only the option codes, with the version and wave', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })
    const r = await submitBetaSurvey({ status: 'completed', answers: { ...FULL, extra: 'ignored' } })
    expect(r).toEqual({ ok: true, status: 'recorded' })
    expect(mocks.rpc).toHaveBeenCalledWith('beta_survey_submit', {
      p_wave: 'signup', p_version: SURVEY_VERSION, p_status: 'completed', p_answers: FULL,
    })
  })
  it('sends an empty answer set for a skip', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })
    await submitBetaSurvey({ status: 'skipped', answers: FULL })
    expect(mocks.rpc.mock.calls[0][1].p_answers).toEqual({})
    expect(mocks.rpc.mock.calls[0][1].p_status).toBe('skipped')
  })
  it('reports a duplicate as already, not as a failure', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'already', recorded_status: 'skipped' }, error: null })
    expect(await submitBetaSurvey({ status: 'completed', answers: FULL })).toEqual({ ok: true, status: 'already' })
  })
  it('never throws: an RPC error, a thrown error, and a signed-out caller all resolve', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'bad' } })
    expect(await submitBetaSurvey({ status: 'completed', answers: FULL })).toEqual({ ok: false, status: 'unavailable' })
    mocks.rpc.mockRejectedValue(new Error('network'))
    expect(await submitBetaSurvey({ status: 'skipped' })).toEqual({ ok: false, status: 'unavailable' })
    mocks.user = null
    expect(await submitBetaSurvey({ status: 'skipped' })).toEqual({ ok: false, status: 'unavailable' })
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
  it('refuses an incomplete completed submission locally', async () => {
    expect(await submitBetaSurvey({ status: 'completed', answers: { reason: 'other' } })).toEqual({ ok: false, status: 'unavailable' })
    expect(await submitBetaSurvey({ status: 'maybe' })).toEqual({ ok: false, status: 'unavailable' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('is unavailable without a configured backend', async () => {
    mocks.configured = false
    expect(await submitBetaSurvey({ status: 'skipped' })).toEqual({ ok: false, status: 'unavailable' })
  })
})

describe('betaSurveyRecorded', () => {
  it('answers true for an own row, false for none, null on a read error', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { status: 'skipped' }, error: null })
    expect(await betaSurveyRecorded()).toBe(true)
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null })
    expect(await betaSurveyRecorded()).toBe(false)
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: 'x' } })
    expect(await betaSurveyRecorded()).toBe(null)
    mocks.user = null
    expect(await betaSurveyRecorded()).toBe(null)
  })
})

const DAY30 = { read_frequency: 'daily', weekly_time: '30_60m', confidence: '5', digest_fit: '4', if_gone: 'very_disappointed' }

describe('day-30 wave', () => {
  it('repeats the three habit questions word for word and adds digest fit and if-gone', () => {
    expect(DAY30_QUESTIONS.map((q) => q.key)).toEqual(['read_frequency', 'weekly_time', 'confidence', 'digest_fit', 'if_gone'])
    for (const key of ['read_frequency', 'weekly_time', 'confidence']) {
      expect(DAY30_QUESTIONS.find((q) => q.key === key)).toBe(SURVEY_QUESTIONS.find((q) => q.key === key))
    }
    // Option codes match the table's checks (20261111120000_beta_survey_day30.sql).
    expect(DAY30_QUESTIONS[4].options.map(([c]) => c)).toEqual(['very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'stopped_using'])
    expect(DAY30_QUESTIONS[3].options.map(([c]) => c)).toEqual(['1', '2', '3', '4', '5'])
  })
  it('completeness is judged against the wave’s own questions', () => {
    expect(surveyComplete(DAY30, DAY30_QUESTIONS)).toBe(true)
    expect(surveyComplete(DAY30)).toBe(false) // no reason: not a signup answer
    expect(surveyComplete(FULL, DAY30_QUESTIONS)).toBe(false)
  })
  it('submits the day-30 codes with its own wave and version, and nothing else', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })
    const out = await submitBetaSurvey({ status: 'completed', wave: 'day30', answers: { ...DAY30, reason: 'other', extra: 'x' } })
    expect(out).toEqual({ ok: true, status: 'recorded' })
    expect(mocks.rpc).toHaveBeenCalledWith('beta_survey_submit', { p_wave: 'day30', p_version: DAY30_VERSION, p_status: 'completed', p_answers: DAY30 })
  })
  it('an incomplete day-30 answer or an unknown wave never reaches the server', async () => {
    expect(await submitBetaSurvey({ status: 'completed', wave: 'day30', answers: FULL })).toEqual({ ok: false, status: 'unavailable' })
    expect(await submitBetaSurvey({ status: 'skipped', wave: 'day60' })).toEqual({ ok: false, status: 'unavailable' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})

describe('day30SurveyDue', () => {
  it('is due only when eligible and nothing is recorded', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { eligible: true, recorded: null }, error: null })
    expect(await day30SurveyDue()).toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith('beta_survey_day30_state')
    mocks.rpc.mockResolvedValueOnce({ data: { eligible: true, recorded: 'skipped' }, error: null })
    expect(await day30SurveyDue()).toBe(false)
    mocks.rpc.mockResolvedValueOnce({ data: { eligible: false, recorded: null }, error: null })
    expect(await day30SurveyDue()).toBe(false)
  })
  it('answers false on any failure, and without asking when signed out', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
    expect(await day30SurveyDue()).toBe(false)
    mocks.rpc.mockRejectedValueOnce(new Error('offline'))
    expect(await day30SurveyDue()).toBe(false)
    mocks.user = null
    expect(await day30SurveyDue()).toBe(false)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
})
