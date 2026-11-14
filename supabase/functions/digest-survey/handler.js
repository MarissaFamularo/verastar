// supabase/functions/digest-survey/handler.js — the day-30 survey, answered from the email.
//
// POST /digest-survey  (application/x-www-form-urlencoded, so the page needs no preflight)
//   u, t            the account id and its signed survey token (../_shared/unsubscribe.js)
//   check=1         only report the state: { result: 'open' | 'already' | 'not-open' }
//   otherwise       the five answer codes (read_frequency, weekly_time, confidence,
//                   digest_fit, if_gone) and v (the survey version)
//
// Readers who use Verastar only from the email are often not signed in on the phone that
// opens it, so the email's invitation links to the app's static email-survey.html page
// with a signed token, and that page posts here. The token is the only credential. The
// answer is recorded by beta_survey_submit_signed (service_role only), which applies the
// same rules as the app's signed-in path: beta access, day 30 opened, option codes only,
// first write wins, no skip. A recorded answer also stamps engaged_at: answering is
// reading. Supabase rewrites HTML responses, so this replies JSON and the page renders.
// Pure except for `admin`; index.ts binds the runtime.

import { verifySurvey } from '../_shared/unsubscribe.js'

export const SURVEY_ANSWER_KEYS = ['read_frequency', 'weekly_time', 'confidence', 'digest_fit', 'if_gone']
export const SURVEY_RESULTS = ['open', 'recorded', 'already', 'not-open', 'invalid', 'incomplete', 'retry', 'not-allowed', 'unconfigured']

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }
const STATUS = { open: 200, recorded: 200, already: 200, 'not-open': 200, invalid: 400, incomplete: 400, retry: 503, 'not-allowed': 405, unconfigured: 500 }

export function surveyReply(result, extra = {}) {
  const r = SURVEY_RESULTS.includes(result) ? result : 'retry'
  return new Response(JSON.stringify({ result: r, ...extra }), {
    status: STATUS[r],
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
}

async function readForm(req) {
  try {
    return new URLSearchParams(await req.text())
  } catch {
    return new URLSearchParams()
  }
}

// The account's day-30 state, read with the service role. null when it cannot be read.
async function stateOf(admin, userId, now) {
  try {
    const { data: acct, error } = await admin.from('sponsored_accounts').select('created_at').eq('user_id', userId).maybeSingle()
    if (error) return null
    if (!acct?.created_at) return { result: 'not-open', opensAt: null }
    const opens = new Date(new Date(acct.created_at).getTime() + 30 * 24 * 60 * 60 * 1000)
    const { data: row, error: rowError } = await admin.from('beta_survey_responses').select('status').eq('user_id', userId).eq('wave', 'day30').maybeSingle()
    if (rowError) return null
    if (row) return { result: 'already' }
    if (opens > now) return { result: 'not-open', opensAt: opens.toISOString() }
    return { result: 'open' }
  } catch {
    return null
  }
}

export async function handleSurvey(req, { admin, secret, now = () => new Date() }) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return surveyReply('not-allowed')
  if (!secret) return surveyReply('unconfigured')
  const form = await readForm(req)
  const u = form.get('u') || ''
  const t = form.get('t') || ''
  if (!(await verifySurvey(u, t, secret))) return surveyReply('invalid')
  const userId = u.toLowerCase()

  if (form.get('check') === '1') {
    const state = await stateOf(admin, userId, now())
    return state ? surveyReply(state.result, state.opensAt ? { opensAt: state.opensAt } : {}) : surveyReply('retry')
  }

  const answers = {}
  for (const key of SURVEY_ANSWER_KEYS) {
    const value = form.get(key)
    if (!value) return surveyReply('incomplete')
    answers[key] = value
  }
  const version = form.get('v') || ''
  try {
    const { data, error } = await admin.rpc('beta_survey_submit_signed', { p_user_id: userId, p_version: version, p_answers: answers })
    if (error) {
      const msg = String(error.message || '')
      if (/opens 30 days/.test(msg)) return surveyReply('not-open')
      if (/beta access/.test(msg)) return surveyReply('not-open')
      if (error.code === '22023') return surveyReply('incomplete')
      return surveyReply('retry')
    }
    if (data?.status === 'already') return surveyReply('already')
    const at = now().toISOString()
    await admin.from('digest_schedules').update({ engaged_at: at, updated_at: at }).eq('user_id', userId).then(() => {}, () => {})
    await admin.from('events').insert({ user_id: userId, type: 'beta_survey_answered_by_email', payload: { wave: 'day30' } }).then(() => {}, () => {})
    return surveyReply('recorded')
  } catch {
    return surveyReply('retry')
  }
}
