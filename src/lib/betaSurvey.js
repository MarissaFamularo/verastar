// lib/betaSurvey.js — the optional beta surveys (docs/BETA_ADMIN_DASHBOARD.md): the
// one-minute signup survey and the day-30 follow-up.
//
// Signup is offered once, right after a beta code enrolls the account. Day 30 is offered in
// the app (and linked from the digest email) once the server says the account is 30 days
// past enrollment; it repeats the three habit questions so each account can be compared
// with its own signup answers. Answers are option CODES only
// (no free text); the server validates them again and stores one row per account through
// the beta_survey_submit RPC, so a repeat submit is a no-op and a signup skip is final (day 30 refuses skips). Nothing
// here can block the app: every call resolves, never throws, and a failure is reported as
// { ok: false } for the caller to ignore.

import { supabase, supabaseConfigured, currentUser } from './supabase.js'

export const SURVEY_VERSION = 'signup-v1'
export const SURVEY_WAVE = 'signup'

export const SURVEY_INTRO = 'Help us understand how you keep up with research. This optional, one-minute survey will help us improve the beta.'

// Question keys match the beta_survey_responses columns; option codes match its checks.
export const SURVEY_QUESTIONS = [
  {
    key: 'reason',
    prompt: 'What’s your main reason for trying Verastar?',
    options: [
      ['stay_current', 'Stay current'],
      ['find_papers', 'Find relevant papers'],
      ['support_project', 'Support a research project'],
      ['explore_topic', 'Explore a topic'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'read_frequency',
    prompt: 'How often do you currently read research papers?',
    options: [
      ['lt_monthly', 'Less than monthly'],
      ['monthly', 'Monthly'],
      ['weekly', 'Weekly'],
      ['several_weekly', 'Several days a week'],
      ['daily', 'Daily'],
    ],
  },
  {
    key: 'weekly_time',
    prompt: 'About how much time do you spend each week finding and reviewing relevant research?',
    options: [
      ['lt_30m', 'Under 30 minutes'],
      ['30_60m', '30–60 minutes'],
      ['1_3h', '1–3 hours'],
      ['gt_3h', 'More than 3 hours'],
    ],
  },
  {
    key: 'confidence',
    prompt: 'How confident are you that you’re keeping up with research relevant to your work?',
    scale: { min: 1, max: 5, minLabel: 'Not at all confident', maxLabel: 'Very confident' },
    options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']],
  },
]

// --- Day 30 ---------------------------------------------------------------------------------
export const DAY30_VERSION = 'day30-v1'
export const DAY30_WAVE = 'day30'
export const DAY30_INTRO = 'You’ve had Verastar for about a month. Five quick questions on how it’s going; three repeat what we asked at signup so we can see what changed.'

const habit = (key) => SURVEY_QUESTIONS.find((q) => q.key === key)
export const DAY30_QUESTIONS = [
  habit('read_frequency'),
  habit('weekly_time'),
  habit('confidence'),
  {
    key: 'digest_fit',
    prompt: 'How well do the papers in your digest match your work?',
    scale: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very well' },
    options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']],
  },
  {
    key: 'if_gone',
    prompt: 'How would you feel if you could no longer use Verastar?',
    options: [
      ['very_disappointed', 'Very disappointed'],
      ['somewhat_disappointed', 'Somewhat disappointed'],
      ['not_disappointed', 'Not disappointed'],
      ['stopped_using', 'I’ve stopped using it'],
    ],
  },
]

const WAVES = {
  signup: { wave: SURVEY_WAVE, version: SURVEY_VERSION, questions: SURVEY_QUESTIONS },
  day30: { wave: DAY30_WAVE, version: DAY30_VERSION, questions: DAY30_QUESTIONS },
}

// Pure: every question answered with one of its offered codes.
export function surveyComplete(answers, questions = SURVEY_QUESTIONS) {
  return questions.every((q) => q.options.some(([code]) => code === answers?.[q.key]))
}

export function canOfferSurvey() {
  return supabaseConfigured && !!currentUser()
}

// Record a completed survey or a skip. Resolves { ok, status } where status is
// 'recorded' | 'already' | 'unavailable'. Never throws.
// `wave` is 'signup' (default) or 'day30'.
export async function submitBetaSurvey({ status, answers = {}, wave = 'signup' }) {
  const w = WAVES[wave]
  if (!w) return { ok: false, status: 'unavailable' }
  if (!canOfferSurvey()) return { ok: false, status: 'unavailable' }
  if (status !== 'completed' && status !== 'skipped') return { ok: false, status: 'unavailable' }
  if (status === 'completed' && !surveyComplete(answers, w.questions)) return { ok: false, status: 'unavailable' }
  const payload = status === 'completed'
    ? Object.fromEntries(w.questions.map((q) => [q.key, answers[q.key]]))
    : {}
  try {
    const { data, error } = await supabase.rpc('beta_survey_submit', {
      p_wave: w.wave,
      p_version: w.version,
      p_status: status,
      p_answers: payload,
    })
    if (error) return { ok: false, status: 'unavailable' }
    return { ok: true, status: data?.status === 'already' ? 'already' : 'recorded' }
  } catch {
    return { ok: false, status: 'unavailable' }
  }
}

// Has this account already answered or skipped? Resolves true/false, or null when the
// question could not be answered (signed out, unconfigured, or a read error).
export async function betaSurveyRecorded() {
  if (!canOfferSurvey()) return null
  try {
    const { data, error } = await supabase
      .from('beta_survey_responses')
      .select('status')
      .eq('user_id', currentUser().id)
      .eq('wave', SURVEY_WAVE)
      .maybeSingle()
    if (error) return null
    return !!data
  } catch {
    return null
  }
}

// Should the app offer the day-30 survey now? Resolves true only when the server says the
// account is past day 30 and has not answered (the day-30 wave cannot be skipped). Any failure (signed out,
// unconfigured, RPC error, an older database without the function) resolves false: the
// prompt is a nicety and never an error the reader sees.
export async function day30SurveyDue() {
  if (!canOfferSurvey()) return false
  try {
    const { data, error } = await supabase.rpc('beta_survey_day30_state')
    if (error || !data) return false
    return data.eligible === true && !data.recorded
  } catch {
    return false
  }
}
