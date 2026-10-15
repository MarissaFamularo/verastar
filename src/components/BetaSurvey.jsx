// components/BetaSurvey.jsx — the optional one-minute signup survey, shown once after a
// beta code enrolls the account (OnboardingQuiz connect step).
//
// Four single-choice questions, a Skip that is always available, and no way to block the
// flow: whatever the server answers (or fails to answer), onDone fires and onboarding
// continues. Answers are option codes (lib/betaSurvey.js); nothing typed, nothing logged.

import { useState } from 'react'
import { SURVEY_INTRO, SURVEY_QUESTIONS, submitBetaSurvey, surveyComplete } from '../lib/betaSurvey.js'
import { awaitWithin } from '../lib/deadline.js'

export const SURVEY_SUBMIT_TIMEOUT_MS = 6000

const stepMark = { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: '#6d7484' }
const title = { margin: '12px 0 0', fontFamily: 'var(--font-serif)', fontSize: 30, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }
const lede = { margin: '12px 0 0', fontSize: 15.5, lineHeight: 1.6, color: 'var(--color-fg-dim)', maxWidth: 520 }
const prompt = { margin: 0, fontSize: 14.5, lineHeight: 1.5, fontWeight: 500, color: 'var(--color-fg-soft)' }
const primaryBtn = { padding: '12px 24px', border: 0, borderRadius: 11, background: 'var(--color-accent)', color: '#1c1206', fontSize: 15, fontWeight: 600, fontFamily: 'inherit' }
const ghostLink = { border: 0, background: 'transparent', padding: 0, fontSize: 14, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }

function optionStyle(selected) {
  return {
    padding: '9px 14px',
    borderRadius: 999,
    border: selected ? '1px solid rgba(239,143,91,.7)' : '1px solid rgba(255,255,255,.12)',
    background: selected ? 'rgba(239,143,91,.16)' : 'var(--surface-1)',
    color: selected ? 'var(--color-fg)' : 'var(--color-fg-soft)',
    fontSize: 13.5,
    fontFamily: 'inherit',
    minHeight: 40,
  }
}

export default function BetaSurvey({ onDone }) {
  const [answers, setAnswers] = useState({})
  const [busy, setBusy] = useState(false)
  const complete = surveyComplete(answers)

  async function finish(status) {
    if (busy) return
    setBusy(true)
    try {
      // The survey must never hold the flow: a slow or failed write is simply let go.
      await awaitWithin(submitBetaSurvey({ status, answers }), SURVEY_SUBMIT_TIMEOUT_MS)
    } catch {
      /* ignored: the app continues either way */
    }
    onDone?.(status)
  }

  return (
    <div>
      <p style={stepMark}>BETA · ONE MINUTE</p>
      <h2 className="vs-step-title" style={title}>Before you start</h2>
      <p style={lede}>{SURVEY_INTRO}</p>

      <form onSubmit={(e) => { e.preventDefault(); if (complete) finish('completed') }}>
        {SURVEY_QUESTIONS.map((q, i) => (
          <fieldset key={q.key} style={{ margin: '26px 0 0', padding: 0, border: 0, minWidth: 0 }}>
            <legend style={prompt}>{i + 1}. {q.prompt}</legend>
            {q.scale && (
              <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--color-fg-muted)' }}>
                {q.scale.min} = {q.scale.minLabel} … {q.scale.max} = {q.scale.maxLabel}
              </p>
            )}
            <div className="flex flex-wrap" style={{ marginTop: 10, gap: 8 }}>
              {q.options.map(([code, label]) => {
                const selected = answers[q.key] === code
                return (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setAnswers((a) => ({ ...a, [q.key]: code }))}
                    className="cursor-pointer"
                    style={optionStyle(selected)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}

        <div className="flex items-center flex-wrap" style={{ marginTop: 30, gap: 18 }}>
          <button type="submit" disabled={!complete || busy} className="cursor-pointer" style={{ ...primaryBtn, opacity: !complete || busy ? 0.5 : 1 }}>
            {busy ? 'Saving…' : 'Send answers →'}
          </button>
          <button type="button" onClick={() => finish('skipped')} disabled={busy} className="cursor-pointer" style={ghostLink}>
            Skip for now
          </button>
        </div>
        <p style={{ margin: '14px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)', maxWidth: 520 }}>
          Answers are stored with your account as choices only, never free text, and are used in aggregate to improve the beta. Skipping changes nothing about your access.
        </p>
      </form>
    </div>
  )
}
