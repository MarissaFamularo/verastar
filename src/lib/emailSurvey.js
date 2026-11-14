// lib/emailSurvey.js — the day-30 survey answered from the digest email, signed out.
//
// The email's invitation links to email-survey.html?u=<account>&t=<signed token>. Readers
// who use Verastar only from the email are often not signed in on the phone that opens it,
// so this page asks the five day-30 questions (the same DAY30_QUESTIONS the app shows) and
// posts them to the digest-survey function, which checks the token and records the answer
// under the same server rules as the app. Pure helpers here; src/emailSurvey.js binds the
// page. Nothing here signs in, reads the account, or stores anything in the browser.

import { DAY30_QUESTIONS, DAY30_VERSION, DAY30_INTRO, surveyComplete } from './betaSurvey.js'

export { DAY30_QUESTIONS, DAY30_VERSION }

// The signed link's parameters, or null when either is missing.
export function surveyParams(search) {
  const q = new URLSearchParams(search || '')
  const u = q.get('u') || ''
  const t = q.get('t') || ''
  return u && t ? { u, t } : null
}

// The form body digest-survey reads: x-www-form-urlencoded, so the browser sends it
// without a CORS preflight.
export function surveyBody({ u, t }, { check = false, answers = null } = {}) {
  const body = new URLSearchParams({ u, t })
  if (check) body.set('check', '1')
  else {
    body.set('v', DAY30_VERSION)
    for (const q of DAY30_QUESTIONS) body.set(q.key, answers?.[q.key] ?? '')
  }
  return body
}

export const answersComplete = (answers) => surveyComplete(answers, DAY30_QUESTIONS)

// What the page says for each digest-survey result. `form: true` keeps the questions up.
export const EMAIL_SURVEY_MESSAGES = {
  open: { title: 'How’s it going?', body: DAY30_INTRO, form: true },
  recorded: { title: 'Thank you', body: 'Your answers are in. If there is anything the questions missed, reply to any digest email.' },
  already: { title: 'Already answered', body: 'This account has already answered the one-month survey. Thank you.' },
  'not-open': { title: 'Not open yet', body: 'The one-month survey opens 30 days after you joined the beta. The link will work then.' },
  invalid: { title: 'This link is not valid', body: 'It may have been cut short by your mail app. Open Verastar and answer the survey on your digest page instead.', open: true },
  incomplete: { title: 'One answer is missing', body: 'Please answer all five questions.', form: true },
  retry: { title: 'Please try again', body: 'The server could not save your answers just now. Your choices are still selected; press Send again in a minute.', form: true },
  unconfigured: { title: 'Not set up yet', body: 'This page is not set up on this server yet. Open Verastar and answer the survey on your digest page.', open: true },
  'not-allowed': { title: 'Please try again', body: 'Open the link in your email again.', open: true },
}
export const emailSurveyMessage = (result) => EMAIL_SURVEY_MESSAGES[result] || EMAIL_SURVEY_MESSAGES.retry

// POST to digest-survey. Resolves { result, opensAt? }; never throws ('retry' on failure).
export async function postSurvey(functionsBase, body, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${String(functionsBase).replace(/\/+$/, '')}/digest-survey`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const data = await res.json().catch(() => null)
    return data && typeof data.result === 'string' ? data : { result: 'retry' }
  } catch {
    return { result: 'retry' }
  }
}
