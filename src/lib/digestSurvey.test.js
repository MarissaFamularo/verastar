// The day-30 survey answered from the email, signed out: the signed link
// (supabase/functions/_shared/unsubscribe.js), the function that records it
// (supabase/functions/digest-survey/handler.js) and the page's helpers (lib/emailSurvey.js).
import { describe, it, expect } from 'vitest'
import { signSurvey, verifySurvey, surveyPageUrl, signResume } from '../../supabase/functions/_shared/unsubscribe.js'
import { handleSurvey, SURVEY_ANSWER_KEYS } from '../../supabase/functions/digest-survey/handler.js'
import { surveyParams, surveyBody, answersComplete, emailSurveyMessage, postSurvey, DAY30_QUESTIONS, DAY30_VERSION } from './emailSurvey.js'

const SECRET = 'a-long-enough-test-secret-value'
const USER = '41fd38b0-c67e-4ce1-a647-3612fbc6010e'
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-20T12:00:00Z')
const ANSWERS = { read_frequency: 'weekly', weekly_time: '1_3h', confidence: '4', digest_fit: '5', if_gone: 'very_disappointed' }

describe('signed survey link', () => {
  it('verifies its own token and refuses a resume token for the same account', async () => {
    const t = await signSurvey(USER, SECRET)
    expect(await verifySurvey(USER, t, SECRET)).toBe(true)
    expect(await verifySurvey(USER, await signResume(USER, SECRET), SECRET)).toBe(false)
    expect(await verifySurvey('41fd38b0-c67e-4ce1-a647-3612fbc6010f', t, SECRET)).toBe(false)
    expect(await verifySurvey(USER, t, 'another-secret-that-is-long')).toBe(false)
  })
  it('points at the app page, never the function', async () => {
    expect(await surveyPageUrl('https://app.test/', USER, SECRET)).toBe(`https://app.test/email-survey.html?u=${USER}&t=${await signSurvey(USER, SECRET)}`)
  })
})

function fakeAdmin({ enrolledDaysAgo = 31, answered = null, rpcError = null, readError = false, pausedAt = null } = {}) {
  const t = {
    sponsored_accounts: enrolledDaysAgo == null ? [] : [{ user_id: USER, created_at: new Date(NOW.getTime() - enrolledDaysAgo * DAY).toISOString() }],
    beta_survey_responses: answered ? [{ user_id: USER, wave: 'day30', status: answered }] : [],
    digest_schedules: [{ user_id: USER, engaged_at: null, paused_at: pausedAt }],
    events: [],
    rpc: [],
  }
  const from = (table) => {
    const filters = []
    let payload = null
    const rows = () => t[table].filter((r) => filters.every(([k, v]) => (r[k] ?? null) === v))
    const chain = {
      select: () => chain,
      eq: (k, v) => { filters.push([k, v]); return chain },
      is: (k, v) => { filters.push([k, v]); return chain },
      maybeSingle: async () => (readError ? { data: null, error: { message: 'down' } } : { data: rows()[0] ?? null, error: null }),
      update: (p) => { payload = p; return chain },
      insert: async (row) => { t[table].push(row); return { error: null } },
      then: (ok, bad) => Promise.resolve().then(() => { if (payload) rows().forEach((r) => Object.assign(r, payload)); return { error: null } }).then(ok, bad),
    }
    return chain
  }
  const rpc = async (name, args) => {
    t.rpc.push({ name, args })
    if (rpcError) return { data: null, error: rpcError }
    if (t.beta_survey_responses.length) return { data: { status: 'already' }, error: null }
    t.beta_survey_responses.push({ user_id: args.p_user_id, wave: 'day30', status: 'completed', ...args.p_answers })
    return { data: { status: 'recorded' }, error: null }
  }
  return { t, admin: { from, rpc } }
}

const post = async (fields) => new Request('https://fn.test/functions/v1/digest-survey', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
})
const run = async (admin, fields, opts = {}) => {
  const res = await handleSurvey(await post(fields), { admin, secret: SECRET, now: () => NOW, ...opts })
  return { status: res.status, body: await res.json(), cors: res.headers.get('Access-Control-Allow-Origin') }
}

describe('digest-survey', () => {
  it('records the five answers for the token’s account, stamps engagement, logs the event', async () => {
    const { t, admin } = fakeAdmin()
    const out = await run(admin, { u: USER, t: await signSurvey(USER, SECRET), v: DAY30_VERSION, ...ANSWERS })
    expect(out).toMatchObject({ status: 200, body: { result: 'recorded' }, cors: '*' })
    expect(t.rpc).toEqual([{ name: 'beta_survey_submit_signed', args: { p_user_id: USER, p_version: DAY30_VERSION, p_answers: ANSWERS } }])
    expect(t.digest_schedules[0].engaged_at).toBe(NOW.toISOString())
    expect(t.events).toEqual([expect.objectContaining({ user_id: USER, type: 'beta_survey_answered_by_email' })])
  })
  it('an answer from a paused account is recorded but does not restart its digest (no engagement stamp)', async () => {
    const { t, admin } = fakeAdmin({ pausedAt: '2026-11-10T11:00:00Z' })
    const out = await run(admin, { u: USER, t: await signSurvey(USER, SECRET), v: DAY30_VERSION, ...ANSWERS })
    expect(out.body.result).toBe('recorded')
    expect(t.digest_schedules[0].engaged_at).toBeNull()
    expect(t.events).toEqual([expect.objectContaining({ type: 'beta_survey_answered_by_email' })])
  })
  it('a second answer is a no-op: already, no new engagement stamp', async () => {
    const { t, admin } = fakeAdmin({ answered: 'completed' })
    const out = await run(admin, { u: USER, t: await signSurvey(USER, SECRET), v: DAY30_VERSION, ...ANSWERS })
    expect(out.body.result).toBe('already')
    expect(t.digest_schedules[0].engaged_at).toBeNull()
  })
  it('a bad or wrong-purpose token changes nothing', async () => {
    for (const tok of ['', 'abc', await signResume(USER, SECRET)]) {
      const { t, admin } = fakeAdmin()
      const out = await run(admin, { u: USER, t: tok, v: DAY30_VERSION, ...ANSWERS })
      expect(out).toMatchObject({ status: 400, body: { result: 'invalid' } })
      expect(t.rpc).toHaveLength(0)
    }
  })
  it('a missing answer is refused before the database', async () => {
    for (const key of SURVEY_ANSWER_KEYS) {
      const { t, admin } = fakeAdmin()
      const fields = { u: USER, t: await signSurvey(USER, SECRET), v: DAY30_VERSION, ...ANSWERS }
      delete fields[key]
      expect((await run(admin, fields)).body.result).toBe('incomplete')
      expect(t.rpc).toHaveLength(0)
    }
  })
  it('maps the server’s refusals: before day 30, no beta access, a bad code, anything else', async () => {
    const cases = [
      [{ code: '22023', message: 'the day-30 survey opens 30 days after enrollment' }, 'not-open'],
      [{ code: '42501', message: 'beta access required' }, 'not-open'],
      [{ code: '22023', message: 'an answer is missing or not one of the offered options' }, 'incomplete'],
      [{ code: 'XX000', message: 'boom' }, 'retry'],
    ]
    for (const [rpcError, result] of cases) {
      const { t, admin } = fakeAdmin({ rpcError })
      expect((await run(admin, { u: USER, t: await signSurvey(USER, SECRET), v: DAY30_VERSION, ...ANSWERS })).body.result).toBe(result)
      expect(t.digest_schedules[0].engaged_at).toBeNull()
    }
  })
  it('check=1 reports the state without writing', async () => {
    const tok = await signSurvey(USER, SECRET)
    const states = [
      [{}, 'open'],
      [{ answered: 'completed' }, 'already'],
      [{ enrolledDaysAgo: 10 }, 'not-open'],
      [{ enrolledDaysAgo: null }, 'not-open'],
      [{ readError: true }, 'retry'],
    ]
    for (const [opts, result] of states) {
      const { t, admin } = fakeAdmin(opts)
      expect((await run(admin, { u: USER, t: tok, check: '1' })).body.result).toBe(result)
      expect(t.rpc).toHaveLength(0)
      expect(t.events).toHaveLength(0)
    }
  })
  it('answers the CORS preflight, refuses GET, and says when the secret is missing', async () => {
    const { admin } = fakeAdmin()
    const pre = await handleSurvey(new Request('https://fn.test/digest-survey', { method: 'OPTIONS' }), { admin, secret: SECRET })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect((await handleSurvey(new Request('https://fn.test/digest-survey'), { admin, secret: SECRET })).status).toBe(405)
    expect((await run(admin, { u: USER, t: 'x' }, { secret: '' })).body.result).toBe('unconfigured')
  })
})

describe('email survey page helpers', () => {
  it('reads the signed link and refuses a partial one', () => {
    expect(surveyParams(`?u=${USER}&t=abc`)).toEqual({ u: USER, t: 'abc' })
    expect(surveyParams(`?u=${USER}`)).toBeNull()
    expect(surveyParams('')).toBeNull()
  })
  it('builds the check and the answer bodies the function reads', () => {
    expect(surveyBody({ u: USER, t: 'abc' }, { check: true }).toString()).toBe(`u=${USER}&t=abc&check=1`)
    const body = surveyBody({ u: USER, t: 'abc' }, { answers: ANSWERS })
    expect(body.get('v')).toBe(DAY30_VERSION)
    for (const key of SURVEY_ANSWER_KEYS) expect(body.get(key)).toBe(ANSWERS[key])
  })
  it('asks exactly the questions the function requires, with the app’s option codes', () => {
    expect(DAY30_QUESTIONS.map((q) => q.key).sort()).toEqual([...SURVEY_ANSWER_KEYS].sort())
    expect(answersComplete(ANSWERS)).toBe(true)
    expect(answersComplete({ ...ANSWERS, if_gone: 'meh' })).toBe(false)
  })
  it('has a message for every result, and an unknown one reads as retry', () => {
    for (const r of ['open', 'recorded', 'already', 'not-open', 'invalid', 'incomplete', 'retry', 'unconfigured', 'not-allowed']) expect(emailSurveyMessage(r).title).toBeTruthy()
    expect(emailSurveyMessage('weird')).toBe(emailSurveyMessage('retry'))
  })
  it('posts form-encoded (no preflight) and never throws', async () => {
    const calls = []
    const ok = async (url, init) => { calls.push({ url, init }); return { json: async () => ({ result: 'recorded' }) } }
    expect(await postSurvey('https://ref.supabase.co/functions/v1/', new URLSearchParams({ u: 'x' }), ok)).toEqual({ result: 'recorded' })
    expect(calls[0].url).toBe('https://ref.supabase.co/functions/v1/digest-survey')
    expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(await postSurvey('https://x', new URLSearchParams(), async () => { throw new Error('offline') })).toEqual({ result: 'retry' })
    expect(await postSurvey('https://x', new URLSearchParams(), async () => ({ json: async () => { throw new Error('html') } }))).toEqual({ result: 'retry' })
  })
})
