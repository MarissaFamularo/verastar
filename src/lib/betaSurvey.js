// lib/betaSurvey.js — the optional one-minute signup survey (docs/BETA_ADMIN_DASHBOARD.md).
//
// Offered once, right after a beta code enrolls the account. Answers are option CODES only
// (no free text); the server validates them again and stores one row per account through
// the beta_survey_submit RPC, so a repeat submit is a no-op and a skip is final. Nothing
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

// Pure: every question answered with one of its offered codes.
export function surveyComplete(answers) {
  return SURVEY_QUESTIONS.every((q) => q.options.some(([code]) => code === answers?.[q.key]))
}

export function canOfferSurvey() {
  return supabaseConfigured && !!currentUser()
}

// Record a completed survey or a skip. Resolves { ok, status } where status is
// 'recorded' | 'already' | 'unavailable'. Never throws.
export async function submitBetaSurvey({ status, answers = {} }) {
  if (!canOfferSurvey()) return { ok: false, status: 'unavailable' }
  if (status !== 'completed' && status !== 'skipped') return { ok: false, status: 'unavailable' }
  if (status === 'completed' && !surveyComplete(answers)) return { ok: false, status: 'unavailable' }
  const payload = status === 'completed'
    ? Object.fromEntries(SURVEY_QUESTIONS.map((q) => [q.key, answers[q.key]]))
    : {}
  try {
    const { data, error } = await supabase.rpc('beta_survey_submit', {
      p_wave: SURVEY_WAVE,
      p_version: SURVEY_VERSION,
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
